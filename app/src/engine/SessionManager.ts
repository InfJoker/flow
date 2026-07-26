import { isTauri, invoke } from "@tauri-apps/api/core";

export interface SessionInfo {
  sessionId: string;
  port: number;
  workflowId: string;
  workflowName: string;
  pid: number;
  startedAt: string;
  /** Absent on sessions written by older channel servers. */
  backend?: "channel" | "sdk";
  /** Directory this session's actions read and write. */
  cwd?: string;
}

/**
 * Choose which discovered session a run should attach to.
 *
 * `discover_sessions` returns entries in `read_dir` order, so the first element
 * is arbitrary — frequently a stale session left over from an earlier day. Honour
 * the user's sidebar selection when it is still alive, and otherwise fall back to
 * the most recently started session rather than whichever the filesystem listed
 * first.
 */
export function pickSession(
  sessions: SessionInfo[],
  activeSessionId: string | null
): SessionInfo | undefined {
  const selected = sessions.find((s) => s.sessionId === activeSessionId);
  if (selected) return selected;

  return [...sessions].sort(
    (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)
  )[0];
}

export async function discoverSessions(): Promise<SessionInfo[]> {
  if (!isTauri()) return [];
  return invoke("discover_sessions");
}

export async function launchClaude(
  workflowId: string,
  workflowName: string,
  channelServerPath: string
): Promise<number> {
  if (!isTauri()) throw new Error("Not running in Tauri");
  return invoke("launch_claude", {
    workflowId,
    workflowName,
    channelServerPath,
  });
}

export async function killSession(pid: number): Promise<void> {
  if (!isTauri()) return;
  return invoke("kill_session", { pid });
}
