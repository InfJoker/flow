import type { Workflow } from "../types";
import { ChannelClient } from "./ChannelClient";

export type ExecutionStatus = "idle" | "running" | "paused" | "waiting_user" | "completed" | "error";

export interface StateExecution {
  stateId: string;
  status: "pending" | "running" | "done" | "skipped";
  results?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ExecutionState {
  status: ExecutionStatus;
  currentStateId: string | null;
  history: StateExecution[];
  output: string[];
  error?: string;
}

type StateChangeCallback = (state: ExecutionState) => void;

const ACTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const TRANSITION_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const MAX_STEPS = 500;

export class StateMachineEngine {
  private workflow: Workflow;
  private client: ChannelClient;
  private sessionId: string;
  private state: ExecutionState;
  private onChange: StateChangeCallback;
  private resolveAction: (() => void) | null = null;
  private resolveTransition: ((picked: string) => void) | null = null;
  private resumeResolve: (() => void) | null = null;

  constructor(
    workflow: Workflow,
    client: ChannelClient,
    sessionId: string,
    onChange: StateChangeCallback
  ) {
    this.workflow = workflow;
    this.client = client;
    this.sessionId = sessionId;
    this.onChange = onChange;
    this.state = {
      status: "idle",
      currentStateId: null,
      history: workflow.states.map((s) => ({
        stateId: s.id,
        status: "pending" as const,
      })),
      output: [],
    };

    this.client.subscribe((event) => {
      if (event.type === "action_complete") {
        const data = event.data as { stateId: string; results: string };
        this.addOutput(`[${data.stateId}] Done: ${data.results}`);
        this.updateStateExecution(data.stateId, "done", data.results);
        this.resolveAction?.();
        this.resolveAction = null;
      } else if (event.type === "transition_picked") {
        const data = event.data as { picked: string; reason: string };
        this.addOutput(`[Transition] → ${data.picked}: ${data.reason}`);
        this.resolveTransition?.(data.picked);
        this.resolveTransition = null;
      } else if (event.type === "error") {
        const data = event.data as { message: string };
        this.addOutput(`[Error] ${data.message}`);
      }
    });
  }

  async start(): Promise<void> {
    const incomingTargets = new Set(this.workflow.transitions.map((t) => t.to));
    const startState = this.workflow.states.find((s) => !incomingTargets.has(s.id))
      ?? this.workflow.states[0];

    if (!startState) {
      this.setError("No states in workflow");
      return;
    }

    this.state.status = "running";
    this.notify();

    await this.runLoop(startState.id);
  }

  // Iterative execution loop — no recursion, no stack overflow on cycles
  private async runLoop(startStateId: string): Promise<void> {
    let currentId: string | null = startStateId;
    let steps = 0;

    while (currentId) {
      // Check pause
      if (this.state.status === "paused") {
        await new Promise<void>((resolve) => {
          this.resumeResolve = resolve;
        });
        if (this.state.status !== "running") break;
      }

      if (this.state.status === "error" || this.state.status === "completed") break;

      // Safety limit
      if (++steps > MAX_STEPS) {
        this.setError(`Maximum steps (${MAX_STEPS}) reached — possible infinite loop`);
        break;
      }

      const wfState = this.workflow.states.find((s) => s.id === currentId);
      if (!wfState) {
        this.state.status = "completed";
        this.addOutput("[Workflow complete]");
        this.notify();
        break;
      }

      // Mark as running
      this.state.currentStateId = currentId;
      this.updateStateExecution(currentId, "running");
      this.addOutput(`\n--- State: ${wfState.name} ---`);
      this.notify();

      // Execute actions with timeout
      const actions = wfState.actions ?? [];
      if (actions.length > 0) {
        try {
          await this.client.executeState({
            sessionId: this.sessionId,
            stateId: wfState.id,
            stateName: wfState.name,
            actions: actions.map((a) => ({
              type: a.type,
              content: a.content,
              agent: a.agent,
              model: a.model,
              shell: a.shell,
            })),
            subagent: wfState.subagent ?? false,
          });
        } catch (err) {
          this.setError(`Failed to send state to channel: ${err}`);
          break;
        }

        // Wait for action completion with timeout
        const actionResult = await this.waitWithTimeout<void>(
          new Promise<void>((resolve) => { this.resolveAction = resolve; }),
          ACTION_TIMEOUT_MS,
          "Action execution timed out"
        );
        if (!actionResult.ok) {
          this.setError(actionResult.error);
          break;
        }
      }

      // Find outgoing transitions
      const outgoing = this.workflow.transitions.filter((t) => t.from === currentId);

      if (outgoing.length === 0) {
        this.state.status = "completed";
        this.addOutput("[Workflow complete — no more transitions]");
        this.notify();
        break;
      }

      if (outgoing.length === 1 && !outgoing[0].description) {
        currentId = outgoing[0].to;
        continue;
      }

      // Ask Claude to pick a transition
      try {
        await this.client.pickTransition({
          sessionId: this.sessionId,
          stateId: currentId!,
          options: outgoing.map((t) => ({
            to: t.to,
            description: t.description || `Go to ${t.to}`,
          })),
        });
      } catch (err) {
        this.setError(`Failed to send transition request: ${err}`);
        break;
      }

      const transitionResult = await this.waitWithTimeout<string>(
        new Promise<string>((resolve) => { this.resolveTransition = resolve; }),
        TRANSITION_TIMEOUT_MS,
        "Transition decision timed out"
      );
      if (!transitionResult.ok) {
        this.setError(transitionResult.error);
        break;
      }

      currentId = transitionResult.value;
    }
  }

  private waitWithTimeout<T>(
    promise: Promise<T>,
    ms: number,
    timeoutMessage: string
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    return Promise.race([
      promise.then((value) => ({ ok: true as const, value })),
      new Promise<{ ok: false; error: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, error: timeoutMessage }), ms)
      ),
    ]);
  }

  pause(): void {
    if (this.state.status === "running") {
      this.state.status = "paused";
      this.addOutput("[Paused by user]");
      this.notify();
    }
  }

  resume(): void {
    if (this.state.status === "paused") {
      this.state.status = "running";
      this.addOutput("[Resumed]");
      this.notify();
      // Unblock the paused runLoop
      this.resumeResolve?.();
      this.resumeResolve = null;
    }
  }

  stop(): void {
    this.state.status = "completed";
    this.addOutput("[Stopped by user]");
    this.resolveAction?.();
    this.resolveTransition?.("");
    this.resumeResolve?.();
    this.client.disconnect();
    this.notify();
  }

  getState(): ExecutionState {
    return { ...this.state };
  }

  private updateStateExecution(stateId: string, status: StateExecution["status"], results?: string) {
    const now = new Date().toISOString();
    this.state.history = this.state.history.map((h) =>
      h.stateId === stateId
        ? {
            ...h,
            status,
            results,
            startedAt: status === "running" ? now : h.startedAt,
            completedAt: status === "done" ? now : h.completedAt,
          }
        : h
    );
  }

  private addOutput(line: string) {
    this.state.output = [...this.state.output, line];
  }

  private setError(message: string) {
    this.state.status = "error";
    this.state.error = message;
    this.addOutput(`[Error] ${message}`);
    this.notify();
  }

  private notify() {
    this.onChange({ ...this.state });
  }
}
