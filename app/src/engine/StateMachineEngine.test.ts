import { describe, it, expect, vi } from "vitest";
import { StateMachineEngine } from "./StateMachineEngine";
import type { ChannelClient } from "./ChannelClient";
import type { Workflow, Action } from "../types";

function makeWorkflow(actions: Action[]): Workflow {
  return {
    id: "wf-1",
    name: "Test Workflow",
    description: "",
    states: [
      { id: "s1", name: "Only State", actions },
    ],
    transitions: [],
  };
}

function mockClient(): ChannelClient {
  const listeners = new Set<(event: { type: string; data: Record<string, unknown> }) => void>();
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
});
