export interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
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

  async register(workflowId: string, workflowName: string): Promise<{ sessionId: string }> {
    const res = await checkedFetch(`${this.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId, workflowName }),
    });
    return res.json();
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
