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
  });
});
