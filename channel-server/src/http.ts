import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { SessionInfo, ExecuteStatePayload, PickTransitionPayload, SSEEvent } from "./types.js";
import { updateSessionFile } from "./session.js";

type ExecuteHandler = (payload: ExecuteStatePayload) => Promise<void>;
type TransitionHandler = (payload: PickTransitionPayload) => Promise<void>;
type RegisterHandler = (workflowId: string, workflowName: string) => void;

interface HttpServerOptions {
  onExecute: ExecuteHandler;
  onTransition: TransitionHandler;
  onRegister?: RegisterHandler;
  readonly sessionInfo: SessionInfo;
}

// Connected SSE clients
const sseClients: Set<ServerResponse> = new Set();

export function broadcastSSE(event: SSEEvent): void {
  const data = JSON.stringify(event);
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: ServerResponse, status: number, data: unknown): void {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function startHttpServer(options: HttpServerOptions): Promise<number> {
  const { onExecute, onTransition } = options;

  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      cors(res);

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = req.url ?? "/";

      try {
        // GET /status — session info
        if (req.method === "GET" && url === "/status") {
          json(res, 200, options.sessionInfo);
          return;
        }

        // GET /events — SSE stream
        if (req.method === "GET" && url === "/events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          });
          res.write("data: {\"type\":\"connected\"}\n\n");
          sseClients.add(res);
          req.on("close", () => sseClients.delete(res));
          return;
        }

        // POST /execute — forward state to Claude
        if (req.method === "POST" && url === "/execute") {
          const body = await readBody(req);
          const payload: ExecuteStatePayload = JSON.parse(body);
          await onExecute(payload);
          json(res, 200, { ok: true });
          return;
        }

        // POST /transition — forward transition options to Claude
        if (req.method === "POST" && url === "/transition") {
          const body = await readBody(req);
          const payload: PickTransitionPayload = JSON.parse(body);
          await onTransition(payload);
          json(res, 200, { ok: true });
          return;
        }

        // POST /register — Tauri app registers its workflow info
        if (req.method === "POST" && url === "/register") {
          const body = await readBody(req);
          const { workflowId, workflowName } = JSON.parse(body);
          const info = options.sessionInfo;
          info.workflowId = workflowId;
          info.workflowName = workflowName;
          updateSessionFile(info);
          options.onRegister?.(workflowId, workflowName);
          json(res, 200, { ok: true, sessionId: info.sessionId });
          return;
        }

        json(res, 404, { error: "Not found" });
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
    });

    // Bind to port 0 — OS picks an available port
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(port);
    });
  });
}
