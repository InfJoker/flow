import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createChannelServer, sendExecuteState, sendPickTransition } from "./server.js";
import { startHttpServer, broadcastSSE } from "./http.js";
import { SdkBackend } from "./sdk-backend.js";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { writeSessionFile, cleanupSessionFile } from "./session.js";
import type { ExecuteStatePayload, PickTransitionPayload } from "./types.js";

let sessionInfo = {
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

  const sdk =
    backendKind === "sdk"
      ? new SdkBackend(
          broadcastSSE,
          cwd,
          process.env.AGENT_FLOW_MODEL,
          process.env.AGENT_FLOW_PERMISSION_MODE as PermissionMode | undefined
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
