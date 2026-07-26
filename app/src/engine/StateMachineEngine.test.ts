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
});
