import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createChannelServer, sendExecuteState, sendPickTransition } from "./server.js";
import { startHttpServer } from "./http.js";
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

  // Create MCP server with channel capability
  const server = createChannelServer();

  // Start HTTP server for Tauri app to connect
  const port = await startHttpServer({
    get sessionInfo() { return sessionInfo; },
    onExecute: async (payload: ExecuteStatePayload) => {
      await sendExecuteState(server, payload);
    },
    onTransition: async (payload: PickTransitionPayload) => {
      await sendPickTransition(server, payload);
    },
  });

  // Write session file for Tauri app discovery
  sessionInfo = writeSessionFile(port, workflowId, workflowName);

  // Log to stderr (stdout is reserved for MCP stdio)
  process.stderr.write(
    `Agent Flow channel server started\n` +
    `  HTTP port: ${port}\n` +
    `  Session: ${sessionInfo.sessionId}\n` +
    `  Workflow: ${workflowName} (${workflowId})\n`
  );

  // Graceful shutdown
  const shutdown = () => {
    cleanupSessionFile();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("exit", () => cleanupSessionFile());

  // Connect MCP server to Claude Code via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  cleanupSessionFile();
  process.exit(1);
});
