import { describe, it, expect } from "vitest";
import { formatExecuteContent, sendPickTransition } from "./server.js";
import type { ExecuteStatePayload } from "./types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

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

  describe("interactive states", () => {
    it("emits wait-for-user instructions when interactive is true", () => {
      const content = formatExecuteContent({ ...basePayload, interactive: true });
      expect(content).toContain("INTERACTIVE");
      expect(content).toContain("Do NOT call report_action_complete yet");
      expect(content).toContain("after the user has actually replied");
    });

    it("still references the session + state IDs in interactive mode", () => {
      const content = formatExecuteContent({ ...basePayload, interactive: true });
      expect(content).toContain('session_id="sess-1"');
      expect(content).toContain('state_id="s1"');
    });

    it("omits the standard 'when done' instruction when interactive", () => {
      const content = formatExecuteContent({ ...basePayload, interactive: true });
      expect(content).not.toContain("When done, call the report_action_complete tool");
    });

    it("uses standard completion instruction when interactive is false", () => {
      const content = formatExecuteContent({ ...basePayload, interactive: false });
      expect(content).toContain("When done, call the report_action_complete tool");
      expect(content).not.toContain("INTERACTIVE");
    });

    it("uses standard completion instruction when interactive is omitted", () => {
      const content = formatExecuteContent(basePayload);
      expect(content).toContain("When done, call the report_action_complete tool");
      expect(content).not.toContain("INTERACTIVE");
    });
  });
});

describe("sendPickTransition", () => {
  // Capture the notification payload so we can assert on the text Claude sees.
  function mockServer(): { server: Server; captured: { content?: string } } {
    const captured: { content?: string } = {};
    const server = {
      notification: async (msg: { params: { content: string } }) => {
        captured.content = msg.params.content;
      },
    } as unknown as Server;
    return { server, captured };
  }

  it("asks Claude to pick one of the listed transitions", async () => {
    const { server, captured } = mockServer();
    await sendPickTransition(server, {
      sessionId: "sess-1",
      stateId: "s1",
      options: [
        { to: "s2", description: "go to s2" },
        { to: "s3", description: "go to s3" },
      ],
    });

    expect(captured.content).toContain('pick_transition tool with session_id="sess-1"');
    expect(captured.content).toContain('Go to "s2" — go to s2');
    expect(captured.content).toContain('Go to "s3" — go to s3');
  });

  it("does NOT tell Claude to withhold pick_transition (would deadlock on 2-min transition timeout)", async () => {
    const { server, captured } = mockServer();
    await sendPickTransition(server, {
      sessionId: "sess-1",
      stateId: "s1",
      options: [{ to: "s2", description: "next" }],
    });

    // Regression: the previous implementation had a defensive clause telling
    // Claude "do NOT call pick_transition" if user input was still pending.
    // That contradicted the engine's TRANSITION_TIMEOUT_MS and would brick
    // the workflow after 2 minutes. Must not come back.
    expect(captured.content).not.toContain("do NOT");
    expect(captured.content).not.toMatch(/not.*call.*pick_transition/i);
  });
});
