import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SessionInfo } from "../engine/SessionManager";

// Every ChannelClient built during a test, so we can count teardowns.
const built: { port: number; disconnect: ReturnType<typeof vi.fn> }[] = [];

vi.mock("../engine/ChannelClient", () => ({
  ChannelClient: class {
    disconnect = vi.fn();
    subscribe = vi.fn(() => () => {});
    register = vi.fn(async () => ({ sessionId: "s", runId: "r" }));
    constructor(public port: number) {
      built.push(this as unknown as { port: number; disconnect: ReturnType<typeof vi.fn> });
    }
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(async () => []),
}));

vi.mock("../engine/SessionManager", async (importOriginal) => ({
  // Keep the real pickSession/sessionsForProject — their behaviour is the point
  // of the sibling suite, and stubbing them here would hide a regression.
  ...(await importOriginal<typeof import("../engine/SessionManager")>()),
  discoverSessions: vi.fn(async () => []),
  killSession: vi.fn(async () => {}),
}));

const { useExecution } = await import("./useExecution");

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "sess-1",
    port: 5001,
    workflowId: "wf",
    workflowName: "WF",
    pid: 1,
    startedAt: new Date().toISOString(),
    backend: "sdk",
    cwd: "/repo",
    ...over,
  };
}

beforeEach(() => {
  built.length = 0;
});

describe("attaching to a session", () => {
  /**
   * The critical regression. Selecting a session ran cleanup(), and cleanup()
   * stops the engine — so clicking the row for the run you were already watching
   * tore that run down. Re-selecting the attached session must do nothing.
   */
  it("does not rebuild the channel when the same session is selected again", () => {
    const { result } = renderHook(() => useExecution("/repo"));
    const s = session();

    act(() => {
      result.current.attachToSession(s);
    });
    expect(built).toHaveLength(1);

    act(() => {
      result.current.attachToSession(s);
    });

    expect(built).toHaveLength(1);
    expect(built[0].disconnect).not.toHaveBeenCalled();
    expect(result.current.activeSessionId).toBe("sess-1");
  });

  it("does tear down and rebuild when a different session is selected", () => {
    const { result } = renderHook(() => useExecution("/repo"));

    act(() => {
      result.current.attachToSession(session());
    });
    act(() => {
      result.current.attachToSession(session({ sessionId: "sess-2", port: 5002 }));
    });

    expect(built).toHaveLength(2);
    expect(built[0].disconnect).toHaveBeenCalled();
    expect(result.current.activeSessionId).toBe("sess-2");
  });

  // Watching is not participating: there is no engine to carry a message, so the
  // composer must be told, or it silently discards what the user typed.
  it("reports that chat cannot be sent while only observing", async () => {
    const { result } = renderHook(() => useExecution("/repo"));

    act(() => {
      result.current.attachToSession(session());
    });

    expect(result.current.chatReady).toBe(false);
    await act(async () => {
      expect(await result.current.sendChat("hello")).toBe(false);
    });
  });
});

describe("scoping to the open project", () => {
  // A run edits files and runs shell commands in its session's cwd, so a session
  // belonging to another folder must never be offered as somewhere to run.
  it("hides sessions whose working directory is a different folder", async () => {
    const { discoverSessions } = await import("../engine/SessionManager");
    vi.mocked(discoverSessions).mockResolvedValueOnce([
      session({ sessionId: "here", cwd: "/repo" }),
      session({ sessionId: "elsewhere", cwd: "/somewhere/else" }),
    ]);

    const { result } = renderHook(() => useExecution("/repo"));
    await act(async () => {
      await result.current.refreshSessions();
    });

    expect(result.current.sessions.map((s) => s.sessionId)).toEqual(["here"]);
  });

  it("refuses to start a run with no project folder open", async () => {
    const { result } = renderHook(() => useExecution(null));

    await act(async () => {
      await result.current.startExecution(
        { id: "wf", name: "WF", description: "", states: [], transitions: [] },
        undefined
      );
    });

    expect(result.current.launchState).toMatchObject({ kind: "failed" });
    expect((result.current.launchState as { message: string }).message).toMatch(/project folder/i);
  });
});
