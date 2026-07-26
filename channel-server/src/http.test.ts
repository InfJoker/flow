import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startHttpServer, broadcastSSE, setRunId } from "./http.js";
import type { SessionInfo } from "./types.js";

const info: SessionInfo = {
  sessionId: "sess-1",
  port: 0,
  workflowId: "wf",
  workflowName: "WF",
  pid: process.pid,
  startedAt: new Date().toISOString(),
};

let port: number;

beforeEach(async () => {
  setRunId("");
  port = await startHttpServer({
    get sessionInfo() {
      return info;
    },
    onExecute: async () => {},
    onTransition: async () => {},
  });
});

afterEach(() => {
  setRunId("");
});

/** Reads the SSE stream for a moment, then returns the raw text received. */
async function readStream(lastEventId?: string, ms = 60): Promise<string> {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/events`, {
    signal: controller.signal,
    headers: lastEventId ? { "Last-Event-ID": lastEventId } : undefined,
  });

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), 20)
      ),
    ]);
    if (chunk.value) text += decoder.decode(chunk.value, { stream: true });
    if (chunk.done && Date.now() >= deadline) break;
  }

  controller.abort();
  return text;
}

function seqIds(text: string): number[] {
  return [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
}

describe("SSE delivery", () => {
  // The window between the app's POST and its EventSource handshake is exactly
  // where a fast backend answers; without buffering the run waits forever.
  it("replays events emitted before any client connected", async () => {
    broadcastSSE({ type: "error", data: { message: "emitted early" } });

    const text = await readStream();

    expect(text).toContain("emitted early");
  });

  // EventSource auto-reconnects and sends Last-Event-ID. Re-delivering events it
  // already handled would settle the current iteration of a cyclic workflow with
  // an earlier iteration's result.
  it("replays only events newer than Last-Event-ID on reconnect", async () => {
    broadcastSSE({ type: "error", data: { message: "first" } });
    broadcastSSE({ type: "error", data: { message: "second" } });

    const initial = await readStream();
    const ids = seqIds(initial);
    expect(ids).toHaveLength(2);
    expect(initial).toContain("first");
    expect(initial).toContain("second");

    broadcastSSE({ type: "error", data: { message: "third" } });

    const resumed = await readStream(String(ids[1]));

    expect(resumed).not.toContain("first");
    expect(resumed).not.toContain("second");
    expect(resumed).toContain("third");
  });

  it("sends the whole buffer to a client that presents no Last-Event-ID", async () => {
    broadcastSSE({ type: "error", data: { message: "alpha" } });
    broadcastSSE({ type: "error", data: { message: "beta" } });

    const text = await readStream();

    expect(text).toContain("alpha");
    expect(text).toContain("beta");
  });

  it("stamps events with the current run id", async () => {
    setRunId("run-abc");
    broadcastSSE({ type: "error", data: { message: "x" } });

    const text = await readStream();

    expect(text).toContain('"runId":"run-abc"');
  });

  // A registration starts a new run; the previous run's events must not reach it.
  it("drops the previous run's buffered events when a new run registers", async () => {
    setRunId("run-1");
    broadcastSSE({ type: "error", data: { message: "from-run-1" } });

    setRunId("run-2");
    broadcastSSE({ type: "error", data: { message: "from-run-2" } });

    const text = await readStream();

    expect(text).not.toContain("from-run-1");
    expect(text).toContain("from-run-2");
  });

  // Ids must keep climbing across runs, or a Last-Event-ID from an earlier run
  // would suppress the new run's events.
  it("keeps event ids monotonic across runs", async () => {
    setRunId("run-1");
    broadcastSSE({ type: "error", data: { message: "a" } });
    const first = seqIds(await readStream());

    setRunId("run-2");
    broadcastSSE({ type: "error", data: { message: "b" } });
    const second = seqIds(await readStream());

    expect(second[0]).toBeGreaterThan(first[0]);
  });
});
