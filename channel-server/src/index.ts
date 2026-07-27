import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createChannelServer, sendExecuteState, sendPickTransition } from "./server.js";
import { startHttpServer, broadcastSSE } from "./http.js";
import { SdkBackend } from "./sdk-backend.js";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { writeSessionFile, updateSessionFile, cleanupSessionFile } from "./session.js";
import type {
  ChatTurnPayload,
  ExecuteStatePayload,
  PickTransitionPayload,
  SessionInfo,
  SessionMetaData,
} from "./types.js";

let sessionInfo: SessionInfo = {
  sessionId: "",
  port: 0,
  workflowId: "",
  workflowName: "",
  pid: process.pid,
  startedAt: new Date().toISOString(),
};

async function main() {
  const workflowId = process.env.AGENT_FLOW_WORKFLOW_ID ?? "unknown";
  const workflowName = process.env.AGENT_FLOW_WORKFLOW_NAME ?? "Unknown Workflow";

  // "sdk" drives Claude directly via the Agent SDK; "channel" (the default) waits
  // for a Claude Code session to attach over MCP stdio. Both serve the same HTTP
  // endpoints, so the Tauri app is unaffected by the choice.
  const backendKind = process.env.AGENT_FLOW_BACKEND === "sdk" ? "sdk" : "channel";

  // Only the channel backend needs the MCP server, but constructing it is cheap and
  // keeps the stdio wiring below in one place.
  const server = createChannelServer();

  // The directory a run can read and write. Under the channel backend this is
  // inherited from wherever the user launched Claude Code; under the SDK backend
  // nothing else pins it down, so it is reported to the app either way.
  const cwd = process.env.AGENT_FLOW_CWD ?? process.cwd();

  // What this session supports, so the app degrades honestly rather than showing
  // an empty activity panel that looks broken. The channel backend learns nothing
  // until Claude calls report_action_complete, and owns no session to chat into.
  const sessionMeta = (): SessionMetaData => ({
    ...(sessionInfo.claudeSessionId ? { claudeSessionId: sessionInfo.claudeSessionId } : {}),
    backend: backendKind,
    cwd,
    capabilities: {
      activity: backendKind === "sdk",
      chat: backendKind === "sdk",
      interrupt: backendKind === "sdk",
    },
  });

  const sdk =
    backendKind === "sdk"
      ? new SdkBackend(
          broadcastSSE,
          cwd,
          process.env.AGENT_FLOW_MODEL,
          process.env.AGENT_FLOW_PERMISSION_MODE as PermissionMode | undefined,
          // Claude's session id is only knowable once its first turn reports it.
          // Persist it so the app can offer `claude --resume <id>`, and announce
          // it so an already-connected app updates without re-reading the file.
          (claudeSessionId) => {
            sessionInfo = { ...sessionInfo, claudeSessionId };
            updateSessionFile(sessionInfo);
            broadcastSSE({ type: "session_meta", data: sessionMeta() });
          }
        )
      : undefined;

  // Start HTTP server for Tauri app to connect
  const port = await startHttpServer({
    get sessionInfo() { return sessionInfo; },
    onExecute: async (payload: ExecuteStatePayload) => {
      // Fire-and-ack, matching the channel backend: the POST must return before
      // the result arrives, because the engine only installs its SSE waiter
      // after the POST resolves. Awaiting the turn here would both drop the
      // event into a null waiter (hanging the run forever) and hold the request
      // open for the whole turn, past the WebView's fetch timeout.
      if (sdk) void sdk.execute(payload);
      else await sendExecuteState(server, payload);
    },
    onTransition: async (payload: PickTransitionPayload) => {
      if (sdk) void sdk.transition(payload);
      else await sendPickTransition(server, payload);
    },
    // Both are SDK-only. Left undefined on the channel backend so the endpoints
    // answer 501 and the app can tell the difference between "not supported" and
    // "broken".
    ...(sdk
      ? {
          onChat: async (payload: ChatTurnPayload) => {
            void sdk.chat(payload);
          },
          onInterrupt: async () => {
            void sdk.interrupt();
          },
        }
      : {}),
    onRegister: () => {
      // A newly registered run needs the session's capabilities and, if the
      // session has already had a turn, the Claude session id. Registration
      // clears the event buffer, so this must be re-sent rather than relied on
      // from the previous run.
      broadcastSSE({ type: "session_meta", data: sessionMeta() });
    },
  });

  // Write session file for Tauri app discovery
  sessionInfo = writeSessionFile(port, workflowId, workflowName, backendKind, cwd);

  // Log to stderr (stdout is reserved for MCP stdio)
  process.stderr.write(
    `Agent Flow channel server started\n` +
    `  Backend: ${backendKind}\n` +
    `  Working dir: ${cwd}\n` +
    `  HTTP port: ${port}\n` +
    `  Session: ${sessionInfo.sessionId}\n` +
    `  Workflow: ${workflowName} (${workflowId})\n`
  );

  // Graceful shutdown
  const shutdown = () => {
    // The SDK installs its own process-exit hook that SIGTERMs spawned children,
    // so this is not what reaps Claude. It is here to abort the turn promptly and
    // to mark the backend stopped, so nothing queued behind it starts and no
    // phantom completion is reported during teardown. A child that ignores
    // SIGTERM still outlives us — the SDK's SIGKILL escalation is on an unref'd
    // timer that process.exit preempts.
    sdk?.stop();
    cleanupSessionFile();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("exit", () => cleanupSessionFile());

  // The SDK backend spawns its own Claude, so there is no parent Claude Code on
  // stdio to connect to — the HTTP server alone keeps the process alive.
  if (backendKind === "channel") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  cleanupSessionFile();
  process.exit(1);
});
