import { isTauri, invoke } from "@tauri-apps/api/core";

export interface SessionInfo {
  sessionId: string;
  port: number;
  workflowId: string;
  workflowName: string;
  pid: number;
  startedAt: string;
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
