import { useCallback, useEffect, useState } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";

export interface ClaudeSession {
  sessionId: string;
  title: string;
  cwd: string;
  gitBranch?: string;
  startedAt?: string;
  modifiedAt: string;
  sizeBytes: number;
}

/**
 * Claude Code's own sessions for a project folder.
 *
 * A run Agent Flow drives is an ordinary Claude Code session — it writes the
 * same transcript and `claude --resume` reopens it with full context — so this
 * list is both "your Claude Code history here" and "the runs you can pick back
 * up in a terminal".
 */
export function useClaudeSessions(projectPath: string | null) {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);

  const refresh = useCallback(async () => {
    if (!isTauri() || !projectPath) {
      setSessions([]);
      return;
    }
    try {
      setSessions(await invoke<ClaudeSession[]>("list_claude_sessions", { projectPath }));
    } catch {
      // A folder with no Claude Code history is normal, not a failure worth
      // putting in front of the user.
      setSessions([]);
    }
  }, [projectPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { claudeSessions: sessions, refreshClaudeSessions: refresh };
}
