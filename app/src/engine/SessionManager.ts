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
 * Sessions whose working directory is the given project.
 *
 * A session's `cwd` is the folder its Claude reads and writes, and runs use
 * `acceptEdits` by default — so attaching to a session belonging to a different
 * folder means edits and shell commands land in the wrong repository. Sessions
 * predating the `cwd` field are excluded rather than assumed to match: an
 * unknown working directory cannot be shown to the user as a consent surface.
 */
export function sessionsForProject(
  sessions: SessionInfo[],
  projectPath: string | null
): SessionInfo[] {
  if (!projectPath) return [];
  return sessions.filter((s) => s.cwd === projectPath);
}

/**
 * Choose which discovered session a run should attach to.
 *
 * `discover_sessions` returns entries in `read_dir` order, so the first element
 * is arbitrary — frequently a stale session left over from an earlier day. Honour
 * the user's sidebar selection when it is still alive, and otherwise fall back to
 * the most recently started session rather than whichever the filesystem listed
 * first.
 *
 * Candidates are restricted to the active project first. Without that filter the
 * fallback picks the newest session anywhere on the machine: measured on the
 * development machine, that was a scratchpad directory rather than the repo the
 * user had open, which would have handed an edit-capable Claude the wrong folder.
 */
export function pickSession(
  sessions: SessionInfo[],
  activeSessionId: string | null,
  projectPath: string | null = null
): SessionInfo | undefined {
  const candidates = projectPath ? sessionsForProject(sessions, projectPath) : sessions;

  const selected = candidates.find((s) => s.sessionId === activeSessionId);
  if (selected) return selected;

  return [...candidates].sort(
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
