import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SSEEvent } from "./types.js";

// Each test installs its own fake turn before importing the backend.
const queryMock = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

const { SdkBackend } = await import("./sdk-backend.js");

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
