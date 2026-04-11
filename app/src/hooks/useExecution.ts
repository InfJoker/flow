import { useState, useCallback, useRef } from "react";
import type { Workflow } from "../types";
import { ChannelClient } from "../engine/ChannelClient";
import { StateMachineEngine, type ExecutionState } from "../engine/StateMachineEngine";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { discoverSessions, killSession, type SessionInfo } from "../engine/SessionManager";

export function useExecution() {
  const [executionState, setExecutionState] = useState<ExecutionState>({
    status: "idle",
    currentStateId: null,
    history: [],
    output: [],
  });
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const engineRef = useRef<StateMachineEngine | null>(null);
  const clientRef = useRef<ChannelClient | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const cleanup = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    engineRef.current?.stop();
    engineRef.current = null;
    clientRef.current?.disconnect();
    clientRef.current = null;
  }, []);

  const refreshSessions = useCallback(async () => {
    const found = await discoverSessions();
    setSessions(found);
    return found;
  }, []);

  const connectToSession = useCallback(
    async (session: SessionInfo, workflow: Workflow) => {
      cleanup();

      const client = new ChannelClient(session.port);
      clientRef.current = client;

      // Register workflow info with channel server + update session file
      try {
        await client.register(workflow.id, workflow.name);
      } catch { /* non-critical */ }
      if (isTauri()) {
        try {
          await invoke("update_session_workflow", {
            sessionId: session.sessionId,
            workflowId: workflow.id,
            workflowName: workflow.name,
          });
        } catch { /* non-critical */ }
      }

      // Reflect the updated workflow name in local state so the sidebar
      // doesn't keep showing the channel-server default ("Unknown Workflow").
      setSessions((prev) =>
        prev.map((s) =>
          s.sessionId === session.sessionId
            ? { ...s, workflowId: workflow.id, workflowName: workflow.name }
            : s
        )
      );

      setActiveSessionId(session.sessionId);

      const engine = new StateMachineEngine(
        workflow,
        client,
        session.sessionId,
        (state) => setExecutionState(state)
      );
      engineRef.current = engine;

      return engine;
    },
    [cleanup]
  );

  const startExecution = useCallback(
    async (workflow: Workflow, startStateId?: string) => {
      const found = await refreshSessions();

      if (found.length === 0) {
        setExecutionState((s) => ({
          ...s,
          status: "error",
          error: "No Claude Code session found.",
          output: [
            ...s.output,
            "[Error] No session found.",
            "Run: claude --channels server:/path/to/channel-server/dist/index.js",
          ],
        }));
        return;
      }

      const session = found[0];
      const engine = await connectToSession(session, workflow);
      await engine.start(startStateId);
    },
    [refreshSessions, connectToSession]
  );

  const pause = useCallback(() => engineRef.current?.pause(), []);
  const resume = useCallback(() => engineRef.current?.resume(), []);

  const stop = useCallback(async () => {
    const sid = activeSessionId;
    const sess = sessions;
    cleanup();
    setActiveSessionId(null);

    if (sid) {
      const session = sess.find((s) => s.sessionId === sid);
      if (session) await killSession(session.pid);
    }
  }, [activeSessionId, sessions, cleanup]);

  return {
    executionState,
    sessions,
    activeSessionId,
    refreshSessions,
    startExecution,
    connectToSession,
    pause,
    resume,
    stop,
  };
}
