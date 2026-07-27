import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SSEEvent } from "./types.js";

// Each test installs its own fake turn before importing the backend.
const queryMock = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

const { SdkBackend, summarizeToolInput } = await import("./sdk-backend.js");

/** A fake Claude turn: an async iterable of SDK messages. */
function turn(...messages: unknown[]) {
  return async function* () {
    for (const m of messages) yield m;
  };
}

const init = (sessionId: string) => ({ type: "system", subtype: "init", session_id: sessionId });
const ok = (result: string, extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  result,
  ...extra,
});

function collector() {
  const events: SSEEvent[] = [];
  return { events, emit: (e: SSEEvent) => events.push(e) };
}

const executePayload = (overrides = {}) => ({
  sessionId: "s1",
  stateId: "probe",
  stateName: "Probe",
  actions: [{ type: "prompt" as const, content: "do it" }],
  subagent: false,
  ...overrides,
});

// Braces matter: a concise arrow would return the mock, and Vitest treats a
// function returned from beforeEach as a teardown callback — it would then call
// the mock with no arguments after every test.
beforeEach(() => {
  queryMock.mockReset();
});

describe("execute", () => {
  it("emits action_complete carrying the turn's result", async () => {
    queryMock.mockImplementation(() => turn(init("c1"), ok("did the thing"))());
    const { events, emit } = collector();

    await new SdkBackend(emit, "/tmp").execute(executePayload());

    expect(events).toEqual([
      { type: "action_complete", data: { sessionId: "s1", stateId: "probe", results: "did the thing" } },
    ]);
  });

  // An interactive state is a human gate. Completing it headlessly would march
  // the workflow past that gate on an answer no user gave.
  it("refuses interactive states instead of reporting completion", async () => {
    const { events, emit } = collector();

    await new SdkBackend(emit, "/tmp").execute(executePayload({ interactive: true }));

    expect(queryMock).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect((events[0].data as { message: string }).message).toContain("interactive");
  });

  it("converts a failed turn into an error event rather than rejecting", async () => {
    queryMock.mockImplementation(() => turn(init("c1"), { type: "result", subtype: "error_max_turns" })());
    const { events, emit } = collector();

    await expect(new SdkBackend(emit, "/tmp").execute(executePayload())).resolves.toBeUndefined();
    expect(events[0].type).toBe("error");
  });

  // Callers fire execute/transition without awaiting, so a rejection would become
  // an unhandled rejection and kill the server process.
  it("never rejects even when the SDK throws outright", async () => {
    queryMock.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const { events, emit } = collector();

    const returned = await new SdkBackend(emit, "/tmp").execute(executePayload());

    expect(returned).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
  });

  it("surfaces permission denials in the result without failing the state", async () => {
    queryMock.mockImplementation(() =>
      turn(init("c1"), ok("wrote the file", { permission_denials: [{ tool_name: "Write" }, { tool_name: "Write" }] }))()
    );
    const { events, emit } = collector();

    await new SdkBackend(emit, "/tmp").execute(executePayload());

    expect(events[0].type).toBe("action_complete");
    const results = (events[0].data as { results: string }).results;
    expect(results).toContain("wrote the file");
    expect(results).toContain("denied Write");
    // Deduplicated, not repeated once per denial.
    expect(results.match(/Write/g)).toHaveLength(1);
  });

  it("resumes later states onto the session id captured from the first turn", async () => {
    queryMock.mockImplementation(() => turn(init("claude-abc"), ok("done"))());
    const { emit } = collector();
    const backend = new SdkBackend(emit, "/tmp");

    await backend.execute(executePayload());
    await backend.execute(executePayload({ stateId: "second" }));

    expect(queryMock.mock.calls[0][0].options.resume).toBeUndefined();
    expect(queryMock.mock.calls[1][0].options.resume).toBe("claude-abc");
  });

  it("runs states one at a time even when fired concurrently", async () => {
    const order: string[] = [];
    let call = 0;
    queryMock.mockImplementation(() => {
      const id = ++call === 1 ? "first" : "second";
      return (async function* () {
        order.push(`${id}:start`);
        await new Promise((r) => setTimeout(r, id === "first" ? 20 : 0));
        order.push(`${id}:end`);
        yield ok("done");
      })();
    });
    const { emit } = collector();
    const backend = new SdkBackend(emit, "/tmp");

    await Promise.all([
      backend.execute(executePayload({ actions: [{ type: "prompt", content: "first" }] })),
      backend.execute(executePayload({ actions: [{ type: "prompt", content: "second" }] })),
    ]);

    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  // A rejected link must not poison the shared chain for every later state.
  it("keeps running states after one fails", async () => {
    queryMock
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementationOnce(() => turn(init("c1"), ok("recovered"))());
    const { events, emit } = collector();
    const backend = new SdkBackend(emit, "/tmp");

    await backend.execute(executePayload());
    await backend.execute(executePayload({ stateId: "after" }));

    expect(events[0].type).toBe("error");
    expect(events[1]).toEqual({
      type: "action_complete",
      data: { sessionId: "s1", stateId: "after", results: "recovered" },
    });
  });
});

describe("stop", () => {
  it("aborts the signal handed to the in-flight query", async () => {
    let seen: AbortSignal | undefined;
    let release: (() => void) | undefined;
    queryMock.mockImplementation(({ options }: { options: { abortController?: AbortController } }) => {
      seen = options.abortController?.signal;
      return (async function* () {
        await new Promise<void>((r) => {
          release = r;
        });
        yield ok("done");
      })();
    });
    const { emit } = collector();
    const backend = new SdkBackend(emit, "/tmp");

    const running = backend.execute(executePayload());
    await new Promise((r) => setTimeout(r, 0));

    expect(seen?.aborted).toBe(false);
    backend.stop();
    expect(seen?.aborted).toBe(true);

    release?.();
    await running;
  });

  // Reporting completion after a stop would walk the engine on to the next state.
  it("does not report completion for work finished after a stop", async () => {
    queryMock.mockImplementation(() => turn(init("c1"), ok("done"))());
    const { events, emit } = collector();
    const backend = new SdkBackend(emit, "/tmp");

    backend.stop();
    await backend.execute(executePayload());

    expect(queryMock).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("is safe to call when nothing is running, and more than once", () => {
    const { emit } = collector();
    const backend = new SdkBackend(emit, "/tmp");

    expect(() => {
      backend.stop();
      backend.stop();
    }).not.toThrow();
  });
});

describe("activity streaming", () => {
  const assistant = (...content: unknown[]) => ({ type: "assistant", message: { content } });
  const toolResults = (...content: unknown[]) => ({ type: "user", message: { content } });

  it("streams assistant text and tool calls filed under the state's attempt", async () => {
    queryMock.mockImplementation(() =>
      turn(
        init("c1"),
        assistant(
          { type: "text", text: "Looking at the failing test." },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/src/app.ts" } }
        ),
        toolResults({ type: "tool_result", tool_use_id: "t1", is_error: false }),
        ok("done")
      )()
    );
    const { events, emit } = collector();

    await new SdkBackend(emit, "/tmp").execute(
      executePayload({ attemptId: "attempt-7", stateId: "implement" })
    );

    const activity = events.filter((e) => e.type === "activity").map((e) => e.data);
    expect(activity).toEqual([
      {
        attemptId: "attempt-7",
        stateId: "implement",
        kind: "assistant_text",
        text: "Looking at the failing test.",
      },
      {
        attemptId: "attempt-7",
        stateId: "implement",
        kind: "tool_use",
        tool: "Read",
        detail: "/repo/src/app.ts",
      },
      { attemptId: "attempt-7", stateId: "implement", kind: "tool_result", tool: "Read", ok: true },
    ]);
  });

  // tool_result blocks carry only a tool_use_id, so the name has to be remembered
  // from the matching tool_use or the feed reports results from anonymous tools.
  it("names a tool result after the call it answers", async () => {
    queryMock.mockImplementation(() =>
      turn(
        init("c1"),
        assistant({ type: "tool_use", id: "abc", name: "Bash", input: { command: "npm test" } }),
        toolResults({ type: "tool_result", tool_use_id: "abc", is_error: true }),
        ok("done")
      )()
    );
    const { events, emit } = collector();

    await new SdkBackend(emit, "/tmp").execute(executePayload({ attemptId: "a1" }));

    const result = events
      .filter((e) => e.type === "activity")
      .map((e) => e.data as { kind: string; tool?: string; ok?: boolean })
      .find((d) => d.kind === "tool_result");
    expect(result).toMatchObject({ tool: "Bash", ok: false });
  });

  // Two visits to one state must stay separate, or a research loop's fifth
  // attempt appends onto the first attempt's transcript.
  it("stamps each visit to a state with its own attempt id", async () => {
    queryMock.mockImplementation(() =>
      turn(init("c1"), assistant({ type: "text", text: "working" }), ok("done"))()
    );
    const { events, emit } = collector();
    const backend = new SdkBackend(emit, "/tmp");

    await backend.execute(executePayload({ stateId: "judge", attemptId: "visit-1" }));
    await backend.execute(executePayload({ stateId: "judge", attemptId: "visit-2" }));

    const attempts = events
      .filter((e) => e.type === "activity")
      .map((e) => (e.data as { attemptId: string }).attemptId);
    expect(attempts).toEqual(["visit-1", "visit-2"]);
  });

  it("carries the attempt id on the completion so it can close the right attempt", async () => {
    queryMock.mockImplementation(() => turn(init("c1"), ok("finished"))());
    const { events, emit } = collector();

    await new SdkBackend(emit, "/tmp").execute(executePayload({ attemptId: "attempt-9" }));

    expect(events[0]).toMatchObject({
      type: "action_complete",
      data: { attemptId: "attempt-9", results: "finished" },
    });
  });

  // An older app sends no attempt id; the field should then be absent rather than
  // present-and-empty, so its events stay byte-identical to before.
  it("omits the attempt id entirely when the app did not send one", async () => {
    queryMock.mockImplementation(() => turn(init("c1"), ok("finished"))());
    const { events, emit } = collector();

    await new SdkBackend(emit, "/tmp").execute(executePayload());

    expect(events[0].data).not.toHaveProperty("attemptId");
  });
});

describe("chat", () => {
  const chatPayload = { sessionId: "s1", attemptId: "chat-1", text: "focus on the parser" };

  it("answers on the same Claude session and reports the reply", async () => {
    queryMock.mockImplementation(() => turn(init("c1"), ok("Understood, switching focus."))());
    const { events, emit } = collector();

    await new SdkBackend(emit, "/tmp").chat(chatPayload);

    expect(events).toContainEqual({
      type: "chat_complete",
      data: { attemptId: "chat-1", result: "Understood, switching focus." },
    });
  });

  // THE important one. The engine treats an `error` event as a fatal channel drop
  // and rejects whatever state or transition it is waiting on. Reporting a chat
  // failure that way would abort a perfectly healthy workflow run.
  it("reports its own failure without emitting an error event", async () => {
    queryMock.mockImplementation(() => {
      throw new Error("chat turn exploded");
    });
    const { events, emit } = collector();

    await new SdkBackend(emit, "/tmp").chat(chatPayload);

    expect(events.some((e) => e.type === "error")).toBe(false);
    const done = events.find((e) => e.type === "chat_complete");
    expect(done?.data).toMatchObject({ attemptId: "chat-1" });
    expect((done?.data as { error?: string }).error).toContain("chat turn exploded");
  });

  // Chat shares the serialization chain with state execution, which is what makes
  // a message sent mid-state arrive after that state rather than interleaved into
  // the middle of its turn.
  it("waits for a running state to finish before taking its turn", async () => {
    const order: string[] = [];
    queryMock.mockImplementation(({ prompt }: { prompt: string }) => {
      const label = prompt.startsWith("Execute workflow state") ? "state" : "chat";
      return (async function* () {
        order.push(`${label}:start`);
        await new Promise((r) => setTimeout(r, label === "state" ? 20 : 0));
        order.push(`${label}:end`);
        yield ok("done");
      })();
    });
    const { emit } = collector();
    const backend = new SdkBackend(emit, "/tmp");

    await Promise.all([backend.execute(executePayload()), backend.chat(chatPayload)]);

    expect(order).toEqual(["state:start", "state:end", "chat:start", "chat:end"]);
  });

  it("files its activity under no state, so it renders as chat rather than state work", async () => {
    queryMock.mockImplementation(() =>
      turn(init("c1"), { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }, ok(""))()
    );
    const { events, emit } = collector();

    await new SdkBackend(emit, "/tmp").chat(chatPayload);

    const activity = events.find((e) => e.type === "activity");
    expect(activity?.data).toMatchObject({ attemptId: "chat-1", stateId: null });
  });
});

describe("interrupt", () => {
  it("ends the turn and reports what the state managed to do", async () => {
    let release: (() => void) | undefined;
    const interrupt = vi.fn(async () => {});
    queryMock.mockImplementation(() => {
      const gen = (async function* () {
        await new Promise<void>((r) => {
          release = r;
        });
        // What the SDK yields for a turn the user cut short.
        yield { type: "result", subtype: "error_during_execution", result: "partial work" };
      })();
      return Object.assign(gen, { interrupt });
    });
    const { events, emit } = collector();
    const backend = new SdkBackend(emit, "/tmp");

    const running = backend.execute(executePayload({ attemptId: "a1" }));
    await new Promise((r) => setTimeout(r, 0));

    await backend.interrupt();
    release?.();
    await running;

    expect(interrupt).toHaveBeenCalled();
    const done = events.find((e) => e.type === "action_complete");
    expect((done?.data as { results: string }).results).toContain("partial work");
    expect((done?.data as { results: string }).results).toContain("Interrupted");
  });

  // Without the explicit flag, a genuinely failed turn and an interrupted one are
  // indistinguishable — both arrive as a non-success subtype.
  it("still treats an uninterrupted failure as an error", async () => {
    queryMock.mockImplementation(() =>
      turn(init("c1"), { type: "result", subtype: "error_during_execution" })()
    );
    const { events, emit } = collector();

    await new SdkBackend(emit, "/tmp").execute(executePayload());

    expect(events[0].type).toBe("error");
  });

  it("is safe to call when no turn is running", async () => {
    const { emit } = collector();
    await expect(new SdkBackend(emit, "/tmp").interrupt()).resolves.toBeUndefined();
  });
});

describe("summarizeToolInput", () => {
  it("picks the field that identifies each kind of call", () => {
    expect(summarizeToolInput("Bash", { command: "npm test", timeout: 5 })).toBe("npm test");
    expect(summarizeToolInput("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summarizeToolInput("Grep", { pattern: "TODO", glob: "*.ts" })).toBe("TODO");
  });

  it("collapses whitespace and truncates, since a Write payload is a whole file", () => {
    const summary = summarizeToolInput("Write", { file_path: "/a.ts", content: "x".repeat(9999) });
    expect(summary).toBe("/a.ts");

    const long = summarizeToolInput("Bash", { command: "echo " + "y".repeat(500) });
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith("…")).toBe(true);
  });

  it("returns empty rather than dumping JSON for an unrecognised shape", () => {
    expect(summarizeToolInput("Mystery", { count: 3, nested: { a: 1 } })).toBe("");
    expect(summarizeToolInput("Mystery", null)).toBe("");
  });
});

describe("transition", () => {
  const transitionPayload = {
    sessionId: "s1",
    stateId: "probe",
    options: [
      { to: "verified", description: "it worked" },
      { to: "retry", description: "it did not" },
    ],
  };

  it("emits transition_picked from the structured output", async () => {
    queryMock.mockImplementation(() =>
      turn(init("c1"), ok("", { structured_output: { next_state: "verified", reason: "file exists" } }))()
    );
    const { events, emit } = collector();

    await new SdkBackend(emit, "/tmp").transition(transitionPayload);

    expect(events).toEqual([
      {
        type: "transition_picked",
        data: { sessionId: "s1", stateId: "probe", picked: "verified", reason: "file exists" },
      },
    ]);
  });

  it("constrains the schema enum to the offered targets", async () => {
    queryMock.mockImplementation(() =>
      turn(init("c1"), ok("", { structured_output: { next_state: "verified", reason: "r" } }))()
    );
    const { emit } = collector();

    await new SdkBackend(emit, "/tmp").transition(transitionPayload);

    const schema = queryMock.mock.calls[0][0].options.outputFormat.schema;
    expect(schema.properties.next_state.enum).toEqual(["verified", "retry"]);
  });

  // Sending an unknown target would walk the engine into an undefined state.
  it("rejects a target that is not on offer", async () => {
    queryMock.mockImplementation(() =>
      turn(init("c1"), ok("", { structured_output: { next_state: "somewhere-else", reason: "r" } }))()
    );
    const { events, emit } = collector();

    await new SdkBackend(emit, "/tmp").transition(transitionPayload);

    expect(events[0].type).toBe("error");
    expect((events[0].data as { message: string }).message).toContain("no valid target");
  });

  it("errors rather than hanging when structured output is missing", async () => {
    queryMock.mockImplementation(() => turn(init("c1"), ok(""))());
    const { events, emit } = collector();

    await new SdkBackend(emit, "/tmp").transition(transitionPayload);

    expect(events[0].type).toBe("error");
  });
});
