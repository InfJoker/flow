import { describe, it, expect, vi } from "vitest";
import { StateMachineEngine } from "./StateMachineEngine";
import type { ChannelClient } from "./ChannelClient";
import type { Workflow, Action, WorkflowState } from "../types";

type Listener = (event: { type: string; data: Record<string, unknown> }) => void;

function makeWorkflow(actions: Action[], stateOverrides: Partial<WorkflowState> = {}): Workflow {
  return {
    id: "wf-1",
    name: "Test Workflow",
    description: "",
    states: [
      { id: "s1", name: "Only State", actions, ...stateOverrides },
    ],
    transitions: [],
  };
}

function mockClient(): ChannelClient {
  const listeners = new Set<Listener>();
  return {
    executeState: vi.fn(async (payload) => {
      // Simulate Claude completing the action
      setTimeout(() => {
        for (const fn of listeners) {
          fn({ type: "action_complete", data: { stateId: payload.stateId, results: "done" } });
        }
      }, 0);
    }),
    pickTransition: vi.fn(),
    subscribe: vi.fn((cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    disconnect: vi.fn(),
  } as unknown as ChannelClient;
}

/**
 * Client that never completes the action on its own — tests drive completion
 * (or a channel error) via the returned `emit` function.
 */
function manualClient(): { client: ChannelClient; emit: (event: { type: string; data: Record<string, unknown> }) => void } {
  const listeners = new Set<Listener>();
  const emit = (event: { type: string; data: Record<string, unknown> }) => {
    for (const fn of listeners) fn(event);
  };
  const client = {
    executeState: vi.fn(async () => {}),
    pickTransition: vi.fn(),
    subscribe: vi.fn((cb: Listener) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    disconnect: vi.fn(),
  } as unknown as ChannelClient;
  return { client, emit };
}

describe("StateMachineEngine", () => {
  it("passes model field through to executeState", async () => {
    const actions: Action[] = [
      { type: "prompt", content: "analyze code", agent: "Explore", model: "opus" },
    ];
    const workflow = makeWorkflow(actions);
    const client = mockClient();

    const engine = new StateMachineEngine(workflow, client, "sess-1", () => {});
    await engine.start();

    expect(client.executeState).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: [
          expect.objectContaining({ model: "opus", agent: "Explore" }),
        ],
      })
    );
  });

  it("passes undefined model when not set", async () => {
    const actions: Action[] = [
      { type: "prompt", content: "do something" },
    ];
    const workflow = makeWorkflow(actions);
    const client = mockClient();

    const engine = new StateMachineEngine(workflow, client, "sess-1", () => {});
    await engine.start();

    const call = (client.executeState as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.actions[0].model).toBeUndefined();
  });

  it("passes all action fields through correctly", async () => {
    const actions: Action[] = [
      { type: "script", content: "print(1)", shell: "python" },
      { type: "prompt", content: "review", agent: "code-review:code-reviewer", model: "haiku" },
    ];
    const workflow = makeWorkflow(actions);
    const client = mockClient();

    const engine = new StateMachineEngine(workflow, client, "sess-1", () => {});
    await engine.start();

    const call = (client.executeState as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.actions).toEqual([
      { type: "script", content: "print(1)", shell: "python", agent: undefined, model: undefined },
      { type: "prompt", content: "review", agent: "code-review:code-reviewer", model: "haiku", shell: undefined },
    ]);
  });

  describe("interactive flag", () => {
    it("threads interactive=true through to executeState", async () => {
      const workflow = makeWorkflow([{ type: "prompt", content: "ask the user" }], {
        interactive: true,
      });
      const client = mockClient();

      const engine = new StateMachineEngine(workflow, client, "sess-1", () => {});
      await engine.start();

      expect(client.executeState).toHaveBeenCalledWith(
        expect.objectContaining({ interactive: true })
      );
    });

    it("defaults interactive to false when unset", async () => {
      const workflow = makeWorkflow([{ type: "prompt", content: "do it" }]);
      const client = mockClient();

      const engine = new StateMachineEngine(workflow, client, "sess-1", () => {});
      await engine.start();

      expect(client.executeState).toHaveBeenCalledWith(
        expect.objectContaining({ interactive: false })
      );
    });
  });

  describe("action wait", () => {
    it("does not time out — waits indefinitely for action_complete", async () => {
      // Advance virtual time way past any reasonable old timeout (was 5 min)
      // and confirm the engine hasn't errored out.
      vi.useFakeTimers();
      try {
        const workflow = makeWorkflow([{ type: "prompt", content: "long job" }]);
        const { client, emit } = manualClient();

        const states: { status: string }[] = [];
        const engine = new StateMachineEngine(workflow, client, "sess-1", (s) =>
          states.push({ status: s.status })
        );
        const done = engine.start();

        // Simulate a very long wait — 1 hour of virtual time.
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

        // Engine must still be running, not errored.
        expect(states.some((s) => s.status === "error")).toBe(false);
        expect(engine.getState().status).toBe("running");

        // Now let the action finish.
        emit({ type: "action_complete", data: { stateId: "s1", results: "ok" } });
        await done;

        expect(engine.getState().status).toBe("completed");
        expect(engine.getState().error).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("aborts the action wait with an error on fatal channel drop", async () => {
      const workflow = makeWorkflow([{ type: "prompt", content: "long job" }]);
      const { client, emit } = manualClient();

      const engine = new StateMachineEngine(workflow, client, "sess-1", () => {});
      const done = engine.start();

      // Fire a fatal channel error while the action is mid-wait.
      await Promise.resolve();
      emit({ type: "error", data: { message: "SSE connection lost" } });

      await done;

      expect(engine.getState().status).toBe("error");
      expect(engine.getState().error).toContain("SSE connection lost");
    });

    // The SDK backend answers some states without awaiting anything — it refuses
    // interactive states and reports spawn failures immediately — so the event
    // can land before executeState's POST resolves. If the waiter is armed only
    // after that, the event is dropped and the run hangs forever with no output.
    it("does not miss an error that arrives before executeState resolves", async () => {
      const workflow = makeWorkflow([{ type: "prompt", content: "x" }], { interactive: true });
      const listeners = new Set<Listener>();
      const client = {
        executeState: vi.fn(async () => {
          // Emit while the POST is still in flight.
          for (const fn of listeners) {
            fn({ type: "error", data: { message: "state is interactive" } });
          }
          await new Promise((r) => setTimeout(r, 0));
        }),
        pickTransition: vi.fn(),
        subscribe: vi.fn((cb: Listener) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        }),
        disconnect: vi.fn(),
      } as unknown as ChannelClient;

      const engine = new StateMachineEngine(workflow, client, "sess-1", () => {});

      await Promise.race([
        engine.start(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("engine hung")), 1000)),
      ]);

      expect(engine.getState().status).toBe("error");
      expect(engine.getState().error).toContain("state is interactive");
    });

    // The channel server outlives a run and replays buffered events to every
    // client that attaches, so a finished run's completion can land in the next
    // run's stream. Settling on it marks the wrong state done and desyncs
    // everything after it.
    it("ignores an event stamped with a different run", async () => {
      const workflow = makeWorkflow([{ type: "prompt", content: "x" }]);
      const listeners = new Set<Listener>();
      const client = {
        runId: "run-2",
        executeState: vi.fn(async (payload: { stateId: string }) => {
          // A leftover completion from the previous run, then the real one.
          for (const fn of listeners) {
            fn({
              type: "action_complete",
              data: { stateId: payload.stateId, results: "STALE" },
              runId: "run-1",
            } as never);
          }
          for (const fn of listeners) {
            fn({
              type: "action_complete",
              data: { stateId: payload.stateId, results: "fresh" },
              runId: "run-2",
            } as never);
          }
        }),
        pickTransition: vi.fn(),
        subscribe: vi.fn((cb: Listener) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        }),
        disconnect: vi.fn(),
      } as unknown as ChannelClient;

      const engine = new StateMachineEngine(workflow, client, "sess-1", () => {});
      await Promise.race([
        engine.start(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("engine hung")), 1000)),
      ]);

      expect(engine.getState().status).toBe("completed");
      const entry = engine.getState().history.find((h) => h.stateId === "s1");
      expect(entry?.results).toBe("fresh");
    });

    // A completion for a state this engine is not waiting on must not settle the
    // current wait — that is how a duplicate or late event skips a state.
    it("ignores a completion for a different state", async () => {
      const workflow = makeWorkflow([{ type: "prompt", content: "x" }]);
      const listeners = new Set<Listener>();
      const client = {
        executeState: vi.fn(async () => {
          for (const fn of listeners) {
            fn({ type: "action_complete", data: { stateId: "some-other-state", results: "nope" } });
          }
          setTimeout(() => {
            for (const fn of listeners) {
              fn({ type: "action_complete", data: { stateId: "s1", results: "real" } });
            }
          }, 5);
        }),
        pickTransition: vi.fn(),
        subscribe: vi.fn((cb: Listener) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        }),
        disconnect: vi.fn(),
      } as unknown as ChannelClient;

      const engine = new StateMachineEngine(workflow, client, "sess-1", () => {});
      await Promise.race([
        engine.start(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("engine hung")), 1000)),
      ]);

      const entry = engine.getState().history.find((h) => h.stateId === "s1");
      expect(entry?.results).toBe("real");
    });

    it("does not miss a completion that arrives before executeState resolves", async () => {
      const workflow = makeWorkflow([{ type: "prompt", content: "x" }]);
      const listeners = new Set<Listener>();
      const client = {
        executeState: vi.fn(async (payload: { stateId: string }) => {
          for (const fn of listeners) {
            fn({ type: "action_complete", data: { stateId: payload.stateId, results: "fast" } });
          }
          await new Promise((r) => setTimeout(r, 0));
        }),
        pickTransition: vi.fn(),
        subscribe: vi.fn((cb: Listener) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        }),
        disconnect: vi.fn(),
      } as unknown as ChannelClient;

      const engine = new StateMachineEngine(workflow, client, "sess-1", () => {});

      await Promise.race([
        engine.start(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("engine hung")), 1000)),
      ]);

      expect(engine.getState().status).toBe("completed");
    });
  });

  describe("attempts", () => {
    /**
     * A workflow that loops back N times before moving on — the research-loop
     * shape, and the reason attempts exist at all.
     */
    function loopingWorkflow(): Workflow {
      return {
        id: "wf-loop",
        name: "Loop",
        description: "",
        states: [
          { id: "work", name: "Work", actions: [{ type: "prompt", content: "do" }] },
          { id: "judge", name: "Judge", actions: [{ type: "prompt", content: "judge" }] },
          { id: "done", name: "Done", actions: [] },
        ],
        transitions: [
          { from: "work", to: "judge", description: "" },
          { from: "judge", to: "work", description: "not good enough" },
          { from: "judge", to: "done", description: "good enough" },
        ],
      };
    }

    /** Drives a looping workflow, sending it back to `work` `loops` times. */
    function loopingClient(loops: number) {
      const listeners = new Set<Listener>();
      const emit = (event: { type: string; data: Record<string, unknown> }) => {
        for (const fn of listeners) fn(event);
      };
      let judged = 0;
      const client = {
        executeState: vi.fn(async (p: { stateId: string; attemptId?: string }) => {
          emit({
            type: "activity",
            data: {
              attemptId: p.attemptId,
              stateId: p.stateId,
              kind: "tool_use",
              tool: "Bash",
              detail: `${p.stateId} pass`,
            },
          });
          emit({
            type: "action_complete",
            data: {
              stateId: p.stateId,
              results: `${p.stateId} result`,
              attemptId: p.attemptId,
            },
          });
        }),
        pickTransition: vi.fn(async (p: { stateId: string }) => {
          const picked = p.stateId === "judge" && judged++ < loops ? "work" : "done";
          emit({
            type: "transition_picked",
            data: { stateId: p.stateId, picked, reason: `because ${picked}` },
          });
        }),
        sendChat: vi.fn(),
        interrupt: vi.fn(),
        subscribe: vi.fn((cb: Listener) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        }),
        disconnect: vi.fn(),
      } as unknown as ChannelClient;
      return { client, emit };
    }

    // The bug this replaces: history held one record per state and overwrote it,
    // so four of five visits to a state vanished.
    it("keeps every visit to a state when the workflow loops", async () => {
      const { client } = loopingClient(2);
      const engine = new StateMachineEngine(loopingWorkflow(), client, "sess", () => {});

      await engine.start("work");

      const judged = engine.getState().attempts.filter((a) => a.stateId === "judge");
      expect(judged).toHaveLength(3);
      expect(judged.map((a) => a.index)).toEqual([1, 2, 3]);
      expect(judged.every((a) => a.status === "done")).toBe(true);
    });

    it("files each visit's activity under that visit alone", async () => {
      const { client } = loopingClient(2);
      const engine = new StateMachineEngine(loopingWorkflow(), client, "sess", () => {});

      await engine.start("work");

      const work = engine.getState().attempts.filter((a) => a.stateId === "work");
      expect(work).toHaveLength(3);
      // One tool call each, not three piled onto the first attempt.
      for (const attempt of work) {
        expect(attempt.activity).toHaveLength(1);
        expect(attempt.activity[0]).toMatchObject({ kind: "tool_use", tool: "Bash" });
      }
    });

    // "Why did it loop?" is the question a research loop most needs answered.
    it("records against each visit why the run went where it did next", async () => {
      const { client } = loopingClient(1);
      const engine = new StateMachineEngine(loopingWorkflow(), client, "sess", () => {});

      await engine.start("work");

      const judged = engine.getState().attempts.filter((a) => a.stateId === "judge");
      expect(judged[0].transition).toEqual({ picked: "work", reason: "because work" });
      expect(judged[1].transition).toEqual({ picked: "done", reason: "because done" });
    });

    it("still exposes a per-state view built from each state's latest visit", async () => {
      const { client } = loopingClient(2);
      const engine = new StateMachineEngine(loopingWorkflow(), client, "sess", () => {});

      await engine.start("work");

      const entry = engine.getState().history.find((h) => h.stateId === "judge");
      expect(entry?.status).toBe("done");
      expect(entry?.results).toBe("judge result");
    });

    // Activity for an attempt that is not the current one — a late event from a
    // previous visit — must not be appended to whatever is running now.
    it("drops activity naming an attempt it does not know", async () => {
      const { client, emit } = loopingClient(0);
      const engine = new StateMachineEngine(loopingWorkflow(), client, "sess", () => {});
      await engine.start("work");

      const before = engine.getState().attempts.map((a) => a.activity.length);
      emit({
        type: "activity",
        data: { attemptId: "nonexistent", stateId: "work", kind: "note", text: "stray" },
      });

      expect(engine.getState().attempts.map((a) => a.activity.length)).toEqual(before);
    });
  });

  describe("stop", () => {
    // stop() used to RESOLVE the action waiter, so the loop ran on and POSTed a
    // transition — starting a fresh Claude turn after the user pressed Stop.
    it("does not request a transition after the user stops mid-state", async () => {
      const workflow: Workflow = {
        id: "wf",
        name: "wf",
        description: "",
        states: [
          { id: "a", name: "A", actions: [{ type: "prompt", content: "x" }] },
          { id: "b", name: "B", actions: [] },
          { id: "c", name: "C", actions: [] },
        ],
        // Two outgoing transitions, so a transition pick would be requested.
        transitions: [
          { from: "a", to: "b", description: "one" },
          { from: "a", to: "c", description: "two" },
        ],
      };
      const { client } = manualClient();
      const engine = new StateMachineEngine(workflow, client, "sess", () => {});

      const running = engine.start("a");
      await new Promise((r) => setTimeout(r, 0));
      engine.stop();
      await running;

      expect(client.pickTransition).not.toHaveBeenCalled();
    });

    // stop() rejects the action waiter to break the loop. The loop must not
    // report that rejection as a channel failure — Stop is the user's own
    // instruction, and a red "Channel error" is both wrong and alarming.
    it("does not report a stopped run as an error", async () => {
      const { client } = manualClient();
      const engine = new StateMachineEngine(
        makeWorkflow([{ type: "prompt", content: "x" }]),
        client,
        "sess",
        () => {}
      );

      const running = engine.start();
      await new Promise((r) => setTimeout(r, 0));
      engine.stop();
      await running;

      expect(engine.getState().status).toBe("completed");
      expect(engine.getState().error).toBeUndefined();
      expect(engine.getState().output.join("\n")).not.toContain("Channel error");
    });

    it("marks the interrupted visit stopped rather than failed", async () => {
      const { client } = manualClient();
      const engine = new StateMachineEngine(
        makeWorkflow([{ type: "prompt", content: "x" }]),
        client,
        "sess",
        () => {}
      );

      const running = engine.start();
      await new Promise((r) => setTimeout(r, 0));
      engine.stop();
      await running;

      expect(engine.getState().attempts[0].status).toBe("stopped");
    });
  });

  describe("transition activity", () => {
    // Transition turns run real Claude turns that use tools. Without an attempt
    // to file them against, every one of those events was silently dropped and
    // the reasoning behind a loop-back was invisible.
    it("attributes the transition turn to the visit it followed", async () => {
      const workflow: Workflow = {
        id: "wf",
        name: "wf",
        description: "",
        states: [
          { id: "a", name: "A", actions: [{ type: "prompt", content: "x" }] },
          { id: "b", name: "B", actions: [] },
          { id: "c", name: "C", actions: [] },
        ],
        transitions: [
          { from: "a", to: "b", description: "one" },
          { from: "a", to: "c", description: "two" },
        ],
      };

      const listeners = new Set<Listener>();
      const emit = (e: { type: string; data: Record<string, unknown> }) => {
        for (const fn of listeners) fn(e);
      };
      const client = {
        executeState: vi.fn(async (p: { stateId: string; attemptId?: string }) => {
          emit({
            type: "action_complete",
            data: { stateId: p.stateId, results: "ok", attemptId: p.attemptId },
          });
        }),
        pickTransition: vi.fn(async (p: { stateId: string; attemptId?: string }) => {
          // Activity from the transition turn, stamped as the server would.
          emit({
            type: "activity",
            data: {
              attemptId: p.attemptId,
              stateId: p.stateId,
              kind: "assistant_text",
              text: "Reviewing what just happened",
            },
          });
          emit({
            type: "transition_picked",
            data: { stateId: p.stateId, picked: "b", reason: "one fits" },
          });
        }),
        subscribe: vi.fn((cb: Listener) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        }),
        disconnect: vi.fn(),
      } as unknown as ChannelClient;

      const engine = new StateMachineEngine(workflow, client, "sess", () => {});
      await engine.start("a");

      const sent = (client.pickTransition as unknown as { mock: { calls: [{ attemptId?: string }][] } })
        .mock.calls[0][0];
      expect(sent.attemptId).toBeTruthy();

      const attemptA = engine.getState().attempts.find((a) => a.stateId === "a")!;
      expect(sent.attemptId).toBe(attemptA.attemptId);
      expect(attemptA.activity.map((e) => e.text)).toContain("Reviewing what just happened");
    });
  });

  describe("chat", () => {
    function chatClient() {
      const listeners = new Set<Listener>();
      const emit = (event: { type: string; data: Record<string, unknown> }) => {
        for (const fn of listeners) fn(event);
      };
      const client = {
        executeState: vi.fn(async () => {}),
        pickTransition: vi.fn(),
        sendChat: vi.fn(async () => {}),
        interrupt: vi.fn(async () => {}),
        subscribe: vi.fn((cb: Listener) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        }),
        disconnect: vi.fn(),
      } as unknown as ChannelClient;
      return { client, emit };
    }

    it("records the message immediately, then the reply when it lands", async () => {
      const { client, emit } = chatClient();
      const engine = new StateMachineEngine(makeWorkflow([]), client, "sess", () => {});

      await engine.sendChat("focus on the parser");

      const attempt = engine.getState().attempts.find((a) => a.kind === "chat");
      expect(attempt).toMatchObject({ prompt: "focus on the parser", status: "running" });

      emit({
        type: "chat_complete",
        data: { attemptId: attempt!.attemptId, result: "Will do." },
      });

      const settled = engine.getState().attempts.find((a) => a.kind === "chat");
      expect(settled).toMatchObject({ status: "done", result: "Will do." });
    });

    // The reason chat has its own completion event: routing a chat failure
    // through `error` would reject the in-flight state waiter and abort the run.
    it("survives a failed chat message without failing the run", async () => {
      const { client, emit } = chatClient();
      const engine = new StateMachineEngine(makeWorkflow([{ type: "prompt", content: "x" }]), client, "sess", () => {});

      const running = engine.start();
      await new Promise((r) => setTimeout(r, 0));

      await engine.sendChat("hello");
      const chat = engine.getState().attempts.find((a) => a.kind === "chat")!;
      emit({
        type: "chat_complete",
        data: { attemptId: chat.attemptId, result: "", error: "turn exploded" },
      });

      expect(engine.getState().status).toBe("running");
      expect(engine.getState().error).toBeUndefined();

      // And the run still finishes normally afterwards.
      emit({ type: "action_complete", data: { stateId: "s1", results: "ok" } });
      await running;
      expect(engine.getState().status).toBe("completed");
    });

    it("ignores an empty message rather than sending a blank turn", async () => {
      const { client } = chatClient();
      const engine = new StateMachineEngine(makeWorkflow([]), client, "sess", () => {});

      await engine.sendChat("   ");

      expect(client.sendChat).not.toHaveBeenCalled();
      expect(engine.getState().attempts).toHaveLength(0);
    });
  });
});
