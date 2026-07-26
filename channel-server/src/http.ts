import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
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

// SSE has no replay, so an event broadcast between the app's POST and its
// EventSource handshake would be lost outright and the run would wait forever.
// Every event is buffered for the current run and replayed to each client that
// attaches. Buffering unconditionally — rather than only when the client set is
// empty — matters: a socket that has died but not yet been reaped still looks
// connected, and writes into a half-closed stream succeed silently. Bounded so
// a long-lived server cannot grow without limit.
//
// Replaying to every client means a reconnecting client sees events it already
// handled. That is safe because the app ignores events from other runs and only
// settles a waiter for the state it is actually waiting on, so duplicates no-op.
const MAX_PENDING = 200;
let pending: { seq: number; data: string }[] = [];

// Monotonic across the server's life, never reset. Emitted as the SSE `id:`
// field, which EventSource echoes back as Last-Event-ID when it auto-reconnects,
// so a reconnecting client is replayed only what it has not already seen.
// Without this, replaying the whole buffer re-delivers an event the client
// already handled — harmless in a linear workflow, but a cyclic one revisiting
// a state settles the current iteration's waiter with the previous iteration's
// result while the backend is still working.
let seq = 0;

// Identifies the current registration. Reset on /register, so events left over
// from a previous run are never delivered to the next one — a stale
// action_complete settling the wrong waiter silently desyncs the whole workflow.
let currentRunId = "";

export function setRunId(runId: string): void {
  currentRunId = runId;
  pending = [];
}

export function broadcastSSE(event: SSEEvent): void {
  const data = JSON.stringify({ ...event, runId: currentRunId });
  const id = ++seq;
  const frame = `id: ${id}\ndata: ${data}\n\n`;

  pending.push({ seq: id, data });
  if (pending.length > MAX_PENDING) pending.shift();

  for (const client of sseClients) {
    // A socket can die between the TCP close and its "close" event, so writing
    // here can throw or emit on a destroyed stream. One dead client must not
    // take down the server or stop the remaining clients being served.
    try {
      client.write(frame);
    } catch {
      sseClients.delete(client);
    }
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
          // Replay what this client has not already seen. EventSource sends
          // Last-Event-ID automatically when it auto-reconnects, so a reconnect
          // mid-run resumes rather than re-delivering events already handled —
          // re-delivery would settle the current iteration of a cyclic workflow
          // with a previous iteration's result. A first-time client sends no
          // header and receives the whole buffer, which is what closes the
          // connect race.
          const lastSeen = Number(req.headers["last-event-id"]);
          const after = Number.isFinite(lastSeen) ? lastSeen : 0;
          for (const entry of pending) {
            if (entry.seq > after) {
              res.write(`id: ${entry.seq}\ndata: ${entry.data}\n\n`);
            }
          }
          sseClients.add(res);
          req.on("close", () => sseClients.delete(res));
          // Without a listener, a stream "error" event is an uncaught exception
          // that would kill the server and orphan the session file.
          res.on("error", () => sseClients.delete(res));
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
          // A registration starts a new run: mint an id and drop anything
          // buffered for the previous one.
          const runId = randomUUID();
          setRunId(runId);
          options.onRegister?.(workflowId, workflowName);
          json(res, 200, { ok: true, sessionId: info.sessionId, runId });
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
