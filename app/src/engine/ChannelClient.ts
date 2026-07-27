export interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
  /** The run this event belongs to; see ChannelClient.runId. */
  runId?: string;
}

async function checkedFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return res;
}

export class ChannelClient {
  private baseUrl: string;
  private eventSource: EventSource | null = null;
  private listeners = new Set<(event: SSEEvent) => void>();

  constructor(port: number) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  /**
   * The run this client registered. The channel server outlives any single run,
   * so events are stamped with the run that produced them and anything from an
   * earlier run must be ignored — a stale action_complete would otherwise settle
   * the current run's waiter and desync the workflow.
   *
   * Undefined against a channel server too old to send one, in which case no
   * filtering happens and behaviour matches the previous version.
   */
  runId: string | undefined;

  async register(
    workflowId: string,
    workflowName: string
  ): Promise<{ sessionId: string; runId?: string }> {
    const res = await checkedFetch(`${this.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId, workflowName }),
    });
    const body = await res.json();
    this.runId = body.runId;
    return body;
  }

  async getStatus(): Promise<Record<string, unknown>> {
    const res = await checkedFetch(`${this.baseUrl}/status`);
    return res.json();
  }

  async executeState(payload: {
    sessionId: string;
    stateId: string;
    stateName: string;
    actions: { type: string; content: string; agent?: string; model?: string; shell?: string }[];
    subagent: boolean;
    interactive?: boolean;
  }): Promise<void> {
    await checkedFetch(`${this.baseUrl}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async pickTransition(payload: {
    sessionId: string;
    stateId: string;
    options: { to: string; description: string }[];
  }): Promise<void> {
    await checkedFetch(`${this.baseUrl}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /**
   * Deliver a user message into the session's Claude.
   *
   * Fire-and-ack like the others: this resolves when the server has accepted the
   * message, not when Claude has replied. The reply arrives as activity and a
   * `chat_complete` event.
   */
  async sendChat(payload: {
    sessionId: string;
    attemptId: string;
    text: string;
  }): Promise<void> {
    await checkedFetch(`${this.baseUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /** End the current turn while leaving the session usable. */
  async interrupt(): Promise<void> {
    await checkedFetch(`${this.baseUrl}/interrupt`, { method: "POST" });
  }

  subscribe(callback: (event: SSEEvent) => void): () => void {
    this.listeners.add(callback);

    if (!this.eventSource) {
      this.eventSource = new EventSource(`${this.baseUrl}/events`);
      this.eventSource.onmessage = (msg) => {
        try {
          const event: SSEEvent = JSON.parse(msg.data);
          for (const listener of this.listeners) {
            listener(event);
          }
        } catch (err) {
          console.warn("SSE parse error:", err, msg.data);
        }
      };
      this.eventSource.onerror = () => {
        // EventSource auto-reconnects on transient errors; readyState goes
        // back to CONNECTING (0). Only treat CLOSED (2) as a fatal drop so
        // we don't bail out of long-running waits on a brief blip.
        if (this.eventSource?.readyState !== EventSource.CLOSED) return;
        for (const listener of this.listeners) {
          listener({ type: "error", data: { message: "SSE connection lost" } });
        }
      };
    }

    return () => {
      this.listeners.delete(callback);
      if (this.listeners.size === 0) {
        this.eventSource?.close();
        this.eventSource = null;
      }
    };
  }

  disconnect(): void {
    this.eventSource?.close();
    this.eventSource = null;
    this.listeners.clear();
  }
}
