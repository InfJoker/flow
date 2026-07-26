import { describe, it, expect } from "vitest";
import { formatSdkExecutePrompt, transitionSchema } from "./sdk-backend.js";
import type { ExecuteStatePayload } from "./types.js";

function payload(overrides: Partial<ExecuteStatePayload> = {}): ExecuteStatePayload {
  return {
    sessionId: "s1",
    stateId: "fetch",
    stateName: "Fetch Issue",
    actions: [{ type: "prompt", content: "Read the issue" }],
    subagent: false,
    ...overrides,
  };
}

describe("formatSdkExecutePrompt", () => {
  it("includes the state name and id", () => {
    const text = formatSdkExecutePrompt(payload());
    expect(text).toContain('"Fetch Issue"');
    expect(text).toContain("fetch");
  });

  it("numbers actions and names the subagent for agent-scoped actions", () => {
    const text = formatSdkExecutePrompt(
      payload({
        actions: [
          { type: "prompt", content: "Review it", agent: "code-review:code-reviewer" },
          { type: "script", content: "npm test", shell: "bash" },
        ],
      })
    );
    expect(text).toContain("1. Prompt [use the code-review:code-reviewer subagent]: Review it");
    expect(text).toContain("2. Script (bash): npm test");
  });

  it("defaults script shell to bash", () => {
    const text = formatSdkExecutePrompt(payload({ actions: [{ type: "script", content: "ls" }] }));
    expect(text).toContain("Script (bash)");
  });

  it("only mentions subagents when the state asks for them", () => {
    expect(formatSdkExecutePrompt(payload())).not.toContain("Run these as subagents");
    expect(formatSdkExecutePrompt(payload({ subagent: true }))).toContain("Run these as subagents");
  });

  // The SDK backend reports completion from the turn's result rather than waiting
  // for an MCP tool call, so the prompt must not ask for one.
  it("does not instruct Claude to call report_action_complete", () => {
    expect(formatSdkExecutePrompt(payload())).not.toContain("report_action_complete");
  });
});

describe("transitionSchema", () => {
  it("constrains next_state to exactly the offered targets", () => {
    const schema = transitionSchema([{ to: "implement" }, { to: "root-cause" }]);
    expect(schema.properties.next_state.enum).toEqual(["implement", "root-cause"]);
  });

  it("requires a reason and forbids extra keys", () => {
    const schema = transitionSchema([{ to: "done" }]);
    expect(schema.required).toEqual(["next_state", "reason"]);
    expect(schema.additionalProperties).toBe(false);
  });

  // Transition targets come from user-authored workflow JSON; they are embedded as
  // enum values, so unusual characters must survive rather than be interpolated
  // into prompt text where they could steer the choice.
  it("passes target ids through verbatim", () => {
    const schema = transitionSchema([{ to: "a-b_c1" }, { to: "state with spaces" }]);
    expect(schema.properties.next_state.enum).toEqual(["a-b_c1", "state with spaces"]);
  });
});
