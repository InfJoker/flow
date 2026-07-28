import { useState, useCallback, useRef } from "react";
import type { Workflow } from "../types";
import { ChannelClient } from "../engine/ChannelClient";
import { StateMachineEngine, type ExecutionState } from "../engine/StateMachineEngine";
import { isTauri, invoke } from "@tauri-apps/api/core";
import {
  discoverSessions,
  killSession,
  pickSession,
  sessionsForProject,
  type SessionInfo,
} from "../engine/SessionManager";

/**
 * What a session can do. The channel backend cannot stream activity — it learns
 * nothing until Claude calls `report_action_complete` — and owns no session to
 * chat into, so the UI has to be able to say so rather than showing empty panels
 * that read as broken.
 */
export interface SessionCapabilities {
  activity: boolean;
  chat: boolean;
  interrupt: boolean;
}

const NO_CAPABILITIES: SessionCapabilities = { activity: false, chat: false, interrupt: false };

export type LaunchState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "failed"; message: string };

export interface RunOptions {
  model?: string;
  permissionMode?: string;
}

export function useExecution(projectPath: string | null) {
  const [executionState, setExecutionState] = useState<ExecutionState>({
    status: "idle",
    currentStateId: null,
    history: [],
    attempts: [],
    output: [],
  });
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<SessionCapabilities>(NO_CAPABILITIES);
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [launchState, setLaunchState] = useState<LaunchState>({ kind: "idle" });
  // Whether a run is attached that can carry a chat message. A session can
  // advertise chat support while we are only observing it, and an engine-less
  // send would silently discard what the user typed.
  const [chatReady, setChatReady] = useState(false);

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
    setCapabilities(NO_CAPABILITIES);
    setClaudeSessionId(null);
    setChatReady(false);
  }, []);

  const refreshSessions = useCallback(async () => {
    const found = await discoverSessions();
    setSessions(found);
    return found;
  }, []);

  /**
   * Open a channel to a session without claiming it.
   *
   * Deliberately does NOT register. `/register` mints a new run id and clears the
   * server's event buffer, so registering merely to look at a session destroys
   * the transcript of the run already in flight and orphans whichever client was
   * attached — every later event fails that client's run-id check and it waits
   * forever. Selecting a session in the sidebar is an observation, so it gets an
   * observer's connection.
   */
  const attachToSession = useCallback(
    (session: SessionInfo): ChannelClient => {
      cleanup();

      const client = new ChannelClient(session.port);
      clientRef.current = client;
      setActiveSessionId(session.sessionId);
      setClaudeSessionId(session.claudeSessionId ?? null);

      // Capabilities and Claude's session id arrive on the same stream the engine
      // reads; a second listener keeps that concern out of the engine.
      unsubRef.current = client.subscribe((event) => {
        if (event.type !== "session_meta") return;
        const data = event.data as {
          capabilities?: SessionCapabilities;
          claudeSessionId?: string;
        };
        if (data.capabilities) setCapabilities(data.capabilities);
        if (data.claudeSessionId) setClaudeSessionId(data.claudeSessionId);
      });

      return client;
    },
    [cleanup]
  );

  /** Attach, then claim the session for a new run of `workflow`. */
  const connectToSession = useCallback(
    async (session: SessionInfo, workflow: Workflow) => {
      const client = attachToSession(session);

      // Registering is what scopes the run: it mints the run id the engine uses
      // to reject events left over from a previous run, and clears the server's
      // buffer of them. A run started without it would accept those stale events
      // and settle the wrong state, so this can no longer be swallowed.
      await client.register(workflow.id, workflow.name);
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

      const engine = new StateMachineEngine(
        workflow,
        client,
        session.sessionId,
        (state) => setExecutionState(state)
      );
      engineRef.current = engine;
      setChatReady(true);

      return engine;
    },
    [attachToSession]
  );

  /**
   * Start a channel server for the open project.
   *
   * Spawning is what pins the working directory: a reused session's `cwd` was
   * fixed when it started, and may not be the folder the user has open.
   */
  const launchSession = useCallback(
    async (workflow: Workflow, options: RunOptions): Promise<SessionInfo> => {
      if (!projectPath) throw new Error("Open a project folder first.");
      return invoke<SessionInfo>("start_session", {
        project: projectPath,
        workflowId: workflow.id,
        workflowName: workflow.name,
        model: options.model ?? null,
        permissionMode: options.permissionMode ?? null,
        channelServerPath: null,
      });
    },
    [projectPath]
  );

  const startExecution = useCallback(
    async (workflow: Workflow, startStateId?: string, options: RunOptions = {}) => {
      if (!isTauri()) {
        setLaunchState({ kind: "failed", message: "Running a workflow needs the desktop app." });
        return;
      }
      if (!projectPath) {
        setLaunchState({
          kind: "failed",
          message: "Open a project folder first — a run needs a directory to work in.",
        });
        return;
      }

      setLaunchState({ kind: "starting" });

      // Prefer a live session already pointed at this project; otherwise start
      // one. Never reuse a session belonging to a different folder: its Claude
      // can edit files and run shell commands, and it would do so somewhere the
      // user did not choose.
      const found = await refreshSessions();
      let session = pickSession(found, activeSessionId, projectPath);

      if (!session) {
        try {
          session = await launchSession(workflow, options);
          setSessions((prev) => [...prev, session!]);
        } catch (err) {
          setLaunchState({ kind: "failed", message: String(err) });
          return;
        }
      }

      let engine;
      try {
        engine = await connectToSession(session, workflow);
      } catch (err) {
        setLaunchState({
          kind: "failed",
          message: `Could not register with the channel server: ${err}`,
        });
        return;
      }

      setLaunchState({ kind: "idle" });
      await engine.start(startStateId);
    },
    [projectPath, refreshSessions, activeSessionId, launchSession, connectToSession]
  );

  const pause = useCallback(() => engineRef.current?.pause(), []);
  const resume = useCallback(() => engineRef.current?.resume(), []);
  const interrupt = useCallback(async () => {
    await engineRef.current?.interrupt();
  }, []);
  /** Resolves false when there is no run to carry the message. */
  const sendChat = useCallback(async (text: string): Promise<boolean> => {
    const engine = engineRef.current;
    if (!engine) return false;
    await engine.sendChat(text);
    return true;
  }, []);
  const dismissLaunchError = useCallback(() => setLaunchState({ kind: "idle" }), []);

  const stop = useCallback(async () => {
    const sid = activeSessionId;
    const sess = sessions;
    cleanup();
    setActiveSessionId(null);

    if (sid) {
      const session = sess.find((s) => s.sessionId === sid);
      if (session) await killSession(session.pid);
    }
    await refreshSessions();
  }, [activeSessionId, sessions, cleanup, refreshSessions]);

  return {
    executionState,
    // Only sessions working in the open project. The rest belong to other
    // folders and must not be offered as somewhere to run.
    sessions: sessionsForProject(sessions, projectPath),
    activeSessionId,
    capabilities,
    chatReady,
    claudeSessionId,
    launchState,
    dismissLaunchError,
    refreshSessions,
    startExecution,
    attachToSession,
    connectToSession,
    sendChat,
    interrupt,
    pause,
    resume,
    stop,
  };
}
