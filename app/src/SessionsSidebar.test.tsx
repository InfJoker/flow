import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SessionsSidebar, { shortenPath, resumeCommand } from "./SessionsSidebar";
import type { SessionInfo } from "./engine/SessionManager";
import type { ClaudeSession } from "./hooks/useClaudeSessions";

describe("shortenPath", () => {
  it("keeps the last two segments, which identify the project", () => {
    expect(shortenPath("/Users/george/code/agent-flow")).toBe("…/code/agent-flow");
  });

  it("leaves short paths alone", () => {
    expect(shortenPath("/tmp")).toBe("/tmp");
    expect(shortenPath("/Users/george")).toBe("/Users/george");
  });

  it("ignores a trailing slash rather than emitting an empty segment", () => {
    expect(shortenPath("/Users/george/code/agent-flow/")).toBe("…/code/agent-flow");
  });

  it("handles a relative path", () => {
    expect(shortenPath("a/b/c/d")).toBe("…/c/d");
  });
});

describe("resumeCommand", () => {
  // The whole delivery of the Claude Code interop. It has to cd first, because
  // `claude --resume` resolves the session against the current directory.
  it("changes into the project folder before resuming", () => {
    expect(resumeCommand("/Users/george/agent-flow", "abc-123")).toBe(
      "cd '/Users/george/agent-flow' && claude --resume abc-123"
    );
  });

  it("quotes the path so a folder with spaces still works", () => {
    expect(resumeCommand("/Users/george/my project", "x")).toContain("'/Users/george/my project'");
  });
});

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "sess-1",
    port: 5000,
    workflowId: "wf",
    workflowName: "Debug Issue",
    pid: 1,
    startedAt: new Date().toISOString(),
    backend: "sdk",
    cwd: "/Users/george/agent-flow",
    ...over,
  };
}

function claudeSession(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    sessionId: "claude-1",
    title: "Fix the failing test",
    cwd: "/Users/george/agent-flow",
    modifiedAt: new Date().toISOString(),
    sizeBytes: 1024,
    ...over,
  };
}

function sidebar(over: Partial<Parameters<typeof SessionsSidebar>[0]> = {}) {
  const props = {
    sessions: [] as SessionInfo[],
    claudeSessions: [] as ClaudeSession[],
    activeSessionId: null,
    claudeSessionId: null,
    projectPath: "/Users/george/agent-flow",
    onSelect: vi.fn(),
    onRefresh: vi.fn(),
    ...over,
  };
  return { ...render(<SessionsSidebar {...props} />), props };
}

describe("SessionsSidebar", () => {
  /**
   * navigator.clipboard is getter-only in jsdom, so it must be redefined rather
   * than assigned — and this must run AFTER userEvent.setup(), which installs a
   * clipboard stub of its own that would otherwise replace the spy.
   */
  const setClipboard = (writeText: () => Promise<void>) => {
    const spy = vi.fn(writeText);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: spy },
      configurable: true,
    });
    return spy;
  };

  it("offers a resume command once Claude's session id is known", async () => {
    const user = userEvent.setup();
    const writeText = setClipboard(async () => {});
    sidebar({
      sessions: [session({ claudeSessionId: "claude-xyz" })],
      activeSessionId: "sess-1",
      claudeSessionId: "claude-xyz",
    });

    await user.click(screen.getByRole("button", { name: /resume Debug Issue in a terminal/i }));

    expect(writeText).toHaveBeenCalledWith(
      "cd '/Users/george/agent-flow' && claude --resume claude-xyz"
    );
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  // The id only exists once Claude's first turn has run, so a session that has
  // not started anything has nothing to offer.
  it("offers no resume command before the session has a Claude id", () => {
    sidebar({ sessions: [session()], activeSessionId: "sess-1" });

    expect(screen.queryByText("Copy resume command")).toBeNull();
  });

  /**
   * An empty catch made a refused clipboard — or an insecure origin, where
   * `navigator.clipboard` is undefined — look like a button that did nothing.
   */
  it("says so and reveals the command when the clipboard refuses", async () => {
    const user = userEvent.setup();
    setClipboard(async () => {
      throw new Error("denied");
    });

    sidebar({
      sessions: [session({ claudeSessionId: "claude-xyz" })],
      activeSessionId: "sess-1",
      claudeSessionId: "claude-xyz",
    });

    await user.click(screen.getByRole("button", { name: /resume Debug Issue in a terminal/i }));

    expect(await screen.findByText("Copy failed")).toBeTruthy();
    // Selectable fallback, because the title tooltip is mouse-only.
    expect(
      screen.getByText("cd '/Users/george/agent-flow' && claude --resume claude-xyz")
    ).toBeTruthy();
  });

  it("lists the folder's Claude Code sessions with their own resume commands", () => {
    sidebar({ claudeSessions: [claudeSession({ title: "Investigate the crash" })] });

    expect(screen.getByText("Investigate the crash")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /resume "Investigate the crash" in a terminal/i })
    ).toBeTruthy();
  });

  it("tells the user what to do when nothing is running", () => {
    sidebar({ projectPath: null });
    expect(screen.getByText(/Open a project folder/i)).toBeTruthy();

    sidebar({ projectPath: "/repo" });
    expect(screen.getByText(/Press Run/i)).toBeTruthy();
  });

  it("marks the selected session for assistive technology, not by colour alone", async () => {
    const onSelect = vi.fn();
    sidebar({ sessions: [session()], activeSessionId: "sess-1", onSelect });

    const row = screen.getByRole("button", { current: true });
    expect(row.textContent).toContain("Debug Issue");

    await userEvent.setup().click(row);
    expect(onSelect).toHaveBeenCalled();
  });
});
