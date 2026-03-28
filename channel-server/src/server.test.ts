import { describe, it, expect } from "vitest";
import { formatExecuteContent } from "./server.js";
import type { ExecuteStatePayload } from "./types.js";

describe("formatExecuteContent", () => {
  const basePayload: ExecuteStatePayload = {
    sessionId: "sess-1",
    stateId: "s1",
    stateName: "Fetch Issue",
    actions: [{ type: "prompt", content: "fetch the issue" }],
    subagent: false,
  };

  it("includes state name and IDs", () => {
    const content = formatExecuteContent(basePayload);
    expect(content).toContain('Execute workflow state "Fetch Issue" (id: s1)');
    expect(content).toContain("Session ID: sess-1");
  });

  it("includes report_action_complete instruction", () => {
    const content = formatExecuteContent(basePayload);
    expect(content).toContain('report_action_complete tool with session_id="sess-1" and state_id="s1"');
  });

  it("marks subagent mode", () => {
    const content = formatExecuteContent({ ...basePayload, subagent: true });
    expect(content).toContain("(run as subagents)");
  });

  it("does not mark subagent when false", () => {
    const content = formatExecuteContent(basePayload);
    expect(content).not.toContain("subagent");
  });

  it("formats a prompt action", () => {
    const content = formatExecuteContent(basePayload);
    expect(content).toContain("1. Prompt: fetch the issue");
  });

  it("formats a script action with default shell", () => {
    const content = formatExecuteContent({
      ...basePayload,
      actions: [{ type: "script", content: "echo hello" }],
    });
    expect(content).toContain("1. Script (bash): echo hello");
  });

  it("formats a script action with python shell", () => {
    const content = formatExecuteContent({
      ...basePayload,
      actions: [{ type: "script", content: "print(1)", shell: "python" }],
    });
    expect(content).toContain("1. Script (python): print(1)");
  });

  it("includes agent tag in action line", () => {
    const content = formatExecuteContent({
      ...basePayload,
      actions: [{ type: "prompt", content: "review", agent: "code-review:bug-hunter" }],
    });
    expect(content).toContain("1. Prompt [agent: code-review:bug-hunter]: review");
  });

  it("includes model tag in action line", () => {
    const content = formatExecuteContent({
      ...basePayload,
      actions: [{ type: "prompt", content: "analyze", model: "haiku" }],
    });
    expect(content).toContain("1. Prompt [model: haiku]: analyze");
  });

  it("includes both agent and model tags", () => {
    const content = formatExecuteContent({
      ...basePayload,
      actions: [{ type: "prompt", content: "fix it", agent: "Explore", model: "opus" }],
    });
    expect(content).toContain("1. Prompt [agent: Explore] [model: opus]: fix it");
  });

  it("omits agent and model tags when absent", () => {
    const content = formatExecuteContent(basePayload);
    expect(content).not.toContain("[agent:");
    expect(content).not.toContain("[model:");
  });

  it("formats multiple actions with correct numbering", () => {
    const content = formatExecuteContent({
      ...basePayload,
      actions: [
        { type: "prompt", content: "review code", agent: "code-review:code-reviewer" },
        { type: "prompt", content: "check security", agent: "code-review:security-auditor", model: "opus" },
      ],
      subagent: true,
    });
    expect(content).toContain("1. Prompt [agent: code-review:code-reviewer]: review code");
    expect(content).toContain("2. Prompt [agent: code-review:security-auditor] [model: opus]: check security");
  });
});
