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

/** One thing the agent did, as it happened. */
export interface ActivityEntry {
  /** Local monotonic id — a stable React key, since events carry no id of their own. */
  seq: number;
  kind: "assistant_text" | "tool_use" | "tool_result" | "note";
  text?: string;
  tool?: string;
  detail?: string;
  ok?: boolean;
}

/**
 * One visit to a state, or one chat exchange.
 *
 * Append-only, and this is the point. A research loop re-enters the same state
 * repeatedly — "score below 4, go back and revise" — and the previous model
 * (one record per state, updated in place) destroyed every earlier visit's
 * result. Attempts are what make "what did it do in each state" answerable
 * after the fact rather than only while it is happening.
 */
export interface Attempt {
  attemptId: string;
  kind: "state" | "chat";
  /** Null for chat, which belongs to the run rather than to any one state. */
  stateId: string | null;
  /** Display label: the state's name, or "You" for a chat message. */
  label: string;
  /** 1-based ordinal among this state's visits. Always 1 for chat. */
  index: number;
  status: "running" | "done" | "error" | "stopped";
  startedAt: string;
  completedAt?: string;
  activity: ActivityEntry[];
  /** The state's summary, or the agent's reply to a chat message. */
  result?: string;
  error?: string;
  /** The message the user sent, on a chat attempt. */
  prompt?: string;
  /** Why the run went where it went next. The answer to "why did it loop". */
  transition?: { picked: string; reason: string };
}

export interface ExecutionState {
  status: ExecutionStatus;
  currentStateId: string | null;
  /** Per-state view, derived from the most recent attempt at each state. */
  history: StateExecution[];
  /** Every visit, in order. */
  attempts: Attempt[];
  /** Milestone lines only — activity lives on attempts, not here. */
  output: string[];
  error?: string;
}

type StateChangeCallback = (state: ExecutionState) => void;

const MAX_STEPS = 500;

// Neither action waits nor transition waits have a time-based timeout. Claude
// Code sessions can legitimately run for hours — interactive states wait for
// the user, long scripts/agents wait for completion, and a transition pick may
// sit idle while Claude is doing other work in the background. We bail out only
// on a fatal SSE disconnect, which signals the channel is actually dead rather
// than just slow.

export class StateMachineEngine {
  private workflow: Workflow;
  private client: ChannelClient;
  private sessionId: string;
  private state: ExecutionState;
  private onChange: StateChangeCallback;
  private resolveAction: (() => void) | null = null;
  private rejectAction: ((err: Error) => void) | null = null;
  private resolveTransition: ((picked: string) => void) | null = null;
  private rejectTransition: ((err: Error) => void) | null = null;
  // Which state's completion / transition this engine will accept right now.
  // Null between states, so a stray event settles nothing.
  private awaitingStateId: string | null = null;
  private awaitingTransitionFrom: string | null = null;
  // The attempt currently collecting activity.
  private currentAttemptId: string | null = null;
  private resumeResolve: (() => void) | null = null;
  // Set by stop(). The loop checks it rather than being unblocked into
  // continuing: resolving the waiter instead would let the current iteration run
  // on and POST a transition, starting a fresh Claude turn *after* the user
  // pressed Stop.
  private stopped = false;
  private activitySeq = 0;
  private notifyQueued = false;

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
      attempts: [],
      output: [],
    };

    this.client.subscribe((event) => {
      // The channel server outlives a single run and replays buffered events to
      // every client that attaches, so an event from an earlier run can arrive
      // here. Settling a waiter with one would mark the wrong state done and
      // desync every state after it.
      if (event.runId && this.client.runId && event.runId !== this.client.runId) {
        return;
      }

      if (event.type === "activity") {
        this.recordActivity(event.data as Record<string, unknown>);
      } else if (event.type === "action_complete") {
        const data = event.data as { stateId: string; results: string; attemptId?: string };
        // Only the state currently being awaited may settle this waiter; a
        // duplicate or late event for any other state is a no-op. On the channel
        // backend state_id comes from Claude's tool call and is not validated
        // server-side, so a wrong one would otherwise hang the run with no
        // explanation — say so rather than dropping it silently.
        if (data.stateId !== this.awaitingStateId) {
          if (this.awaitingStateId) {
            this.addOutput(
              `[Ignored] completion for "${data.stateId}" while waiting on "${this.awaitingStateId}"`
            );
            this.notify();
          }
          return;
        }
        this.addOutput(`[${data.stateId}] Done: ${data.results}`);
        this.closeAttempt(data.attemptId ?? this.currentAttemptId, "done", data.results);
        this.updateStateExecution(data.stateId, "done", data.results);
        this.resolveAction?.();
        this.resolveAction = null;
        this.rejectAction = null;
      } else if (event.type === "transition_picked") {
        const data = event.data as { picked: string; reason: string; stateId?: string };
        if (data.stateId && data.stateId !== this.awaitingTransitionFrom) {
          if (this.awaitingTransitionFrom) {
            this.addOutput(
              `[Ignored] transition from "${data.stateId}" while waiting on "${this.awaitingTransitionFrom}"`
            );
            this.notify();
          }
          return;
        }
        this.addOutput(`[Transition] → ${data.picked}: ${data.reason}`);
        // Record it against the attempt it followed, so re-reading a visit shows
        // why the run went where it did next.
        this.attachTransition(data.stateId ?? this.awaitingTransitionFrom, {
          picked: data.picked,
          reason: data.reason,
        });
        this.resolveTransition?.(data.picked);
        this.resolveTransition = null;
        this.rejectTransition = null;
      } else if (event.type === "chat_complete") {
        const data = event.data as { attemptId: string; result: string; error?: string };
        // Chat never settles a run waiter — that is the whole point of it having
        // its own completion event rather than reusing `error`.
        this.closeAttempt(
          data.attemptId,
          data.error ? "error" : "done",
          data.result,
          data.error
        );
        this.notify();
      } else if (event.type === "session_meta") {
        // Carries the Claude session id once the first turn reveals it; the hook
        // above the engine surfaces it. Nothing here settles.
        this.notify();
      } else if (event.type === "error") {
        const data = event.data as { message: string };
        this.addOutput(`[Error] ${data.message}`);
        this.closeAttempt(this.currentAttemptId, "error", undefined, data.message);
        // Fatal channel drop — abort any in-flight wait so the workflow
        // fails fast instead of hanging forever.
        this.rejectAction?.(new Error(data.message));
        this.rejectAction = null;
        this.resolveAction = null;
        this.rejectTransition?.(new Error(data.message));
        this.rejectTransition = null;
        this.resolveTransition = null;
        // addOutput only mutates state; without this the error text sits
        // invisible until some later change happens to trigger a render.
        this.notify();
      }
    });
  }

  // ---- attempts -----------------------------------------------------------

  private openAttempt(attempt: Omit<Attempt, "activity" | "startedAt" | "status" | "index">): Attempt {
    const index =
      attempt.stateId === null
        ? 1
        : this.state.attempts.filter((a) => a.stateId === attempt.stateId).length + 1;

    const created: Attempt = {
      ...attempt,
      index,
      status: "running",
      startedAt: new Date().toISOString(),
      activity: [],
    };
    this.state.attempts = [...this.state.attempts, created];
    return created;
  }

  private closeAttempt(
    attemptId: string | null | undefined,
    status: Attempt["status"],
    result?: string,
    error?: string
  ): void {
    if (!attemptId) return;
    this.state.attempts = this.state.attempts.map((a) =>
      a.attemptId === attemptId && a.status === "running"
        ? { ...a, status, result: result ?? a.result, error, completedAt: new Date().toISOString() }
        : a
    );
  }

  private attachTransition(stateId: string | null, transition: { picked: string; reason: string }): void {
    if (!stateId) return;
    // The most recent attempt at that state is the one the transition followed.
    for (let i = this.state.attempts.length - 1; i >= 0; i--) {
      if (this.state.attempts[i].stateId === stateId) {
        const updated = [...this.state.attempts];
        updated[i] = { ...updated[i], transition };
        this.state.attempts = updated;
        return;
      }
    }
  }

  private recordActivity(data: Record<string, unknown>): void {
    const attemptId = (data.attemptId as string) || this.currentAttemptId;
    if (!attemptId) return;

    const entry: ActivityEntry = {
      seq: ++this.activitySeq,
      kind: (data.kind as ActivityEntry["kind"]) ?? "note",
      ...(typeof data.text === "string" ? { text: data.text } : {}),
      ...(typeof data.tool === "string" ? { tool: data.tool } : {}),
      ...(typeof data.detail === "string" ? { detail: data.detail } : {}),
      ...(typeof data.ok === "boolean" ? { ok: data.ok } : {}),
    };

    const index = this.state.attempts.findIndex((a) => a.attemptId === attemptId);
    if (index === -1) return;

    const updated = [...this.state.attempts];
    updated[index] = { ...updated[index], activity: [...updated[index].activity, entry] };
    this.state.attempts = updated;
    // Coalesced: a busy tool loop emits activity far faster than the UI needs to
    // repaint, and this state object is replaced wholesale on every notify.
    this.scheduleNotify();
  }

  // ---- chat ---------------------------------------------------------------

  /**
   * Send a message into the run's Claude session.
   *
   * The reply is not awaited here: it arrives as activity and a `chat_complete`
   * event, exactly like a state's work does. A message sent while a state is
   * running is answered *after* that state's turn, because the server serializes
   * turns onto one session — it is queued, never interleaved.
   */
  async sendChat(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    const attemptId = newAttemptId();
    this.openAttempt({
      attemptId,
      kind: "chat",
      stateId: null,
      label: "You",
      prompt: trimmed,
    });
    this.notify();

    try {
      await this.client.sendChat({ sessionId: this.sessionId, attemptId, text: trimmed });
    } catch (err) {
      this.closeAttempt(attemptId, "error", undefined, String(err));
      this.notify();
    }
  }

  /** End the current turn without ending the run. */
  async interrupt(): Promise<void> {
    try {
      await this.client.interrupt();
    } catch (err) {
      this.addOutput(`[Error] Could not interrupt: ${err}`);
      this.notify();
    }
  }

  // ---- run loop -----------------------------------------------------------

  async start(startStateId?: string): Promise<void> {
    let startState = startStateId
      ? this.workflow.states.find((s) => s.id === startStateId)
      : undefined;

    if (!startState) {
      const incomingTargets = new Set(this.workflow.transitions.map((t) => t.to));
      startState = this.workflow.states.find((s) => !incomingTargets.has(s.id))
        ?? this.workflow.states[0];
    }

    if (!startState) {
      this.setError("No states in workflow");
      return;
    }

    this.state.status = "running";
    this.notify();

    await this.runLoop(startState.id);
  }

  /** Blocks while paused. Returns false when the run should stop entirely. */
  private async awaitResume(): Promise<boolean> {
    if (this.state.status !== "paused") return true;
    await new Promise<void>((resolve) => {
      this.resumeResolve = resolve;
    });
    return !this.stopped && this.state.status === "running";
  }

  // Iterative execution loop — no recursion, no stack overflow on cycles
  private async runLoop(startStateId: string): Promise<void> {
    let currentId: string | null = startStateId;
    let steps = 0;

    while (currentId) {
      if (this.stopped) break;
      if (!(await this.awaitResume())) break;

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

      // Kept past the action so the transition turn's activity can be filed
      // against the visit it followed, rather than being dropped for want of an
      // attempt to belong to.
      let stateAttemptId: string | null = null;

      // Execute actions with timeout
      const actions = wfState.actions ?? [];
      if (actions.length > 0) {
        // Minted here, before the POST, and sent with it. The server stamps every
        // event it produces with this id, which is what keeps attempt N's tool
        // calls out of attempt N-1's transcript when a loop revisits a state.
        // It has to be minted client-side: fire-and-ack routinely delivers events
        // before the POST resolves, so only a value we already hold can file them.
        const attemptId = newAttemptId();
        stateAttemptId = attemptId;
        this.openAttempt({
          attemptId,
          kind: "state",
          stateId: wfState.id,
          label: wfState.name,
        });
        this.currentAttemptId = attemptId;
        this.notify();

        // Arm the waiter BEFORE sending. A backend can answer faster than the
        // POST round-trip — the SDK backend refuses interactive states and
        // reports spawn failures without awaiting anything — and an event that
        // arrives while resolveAction is still null is dropped, leaving this
        // loop awaiting a promise nothing can ever settle.
        this.awaitingStateId = wfState.id;
        const completion = new Promise<void>((resolve, reject) => {
          this.resolveAction = resolve;
          this.rejectAction = reject;
        });
        // Because the waiter is armed before the POST, a fast failure can reject
        // this promise while nothing is awaiting it yet. Mark it handled here;
        // the rejection is still delivered to the `await completion` below.
        completion.catch(() => {});

        try {
          await this.client.executeState({
            sessionId: this.sessionId,
            stateId: wfState.id,
            stateName: wfState.name,
            attemptId,
            actions: actions.map((a) => ({
              type: a.type,
              content: a.content,
              agent: a.agent,
              model: a.model,
              shell: a.shell,
            })),
            subagent: wfState.subagent ?? false,
            interactive: wfState.interactive ?? false,
          });
        } catch (err) {
          // Nothing will settle the waiter now; drop it so it cannot capture a
          // later state's completion event.
          this.resolveAction = null;
          this.rejectAction = null;
          this.awaitingStateId = null;
          this.closeAttempt(attemptId, "error", undefined, String(err));
          this.setError(`Failed to send state to channel: ${err}`);
          break;
        }

        // Wait for action completion. No time-based timeout — see note at
        // top of file. Only a fatal channel drop (SSE CLOSED) aborts.
        try {
          await completion;
        } catch (err) {
          // stop() rejects this waiter to break the loop. That is the user
          // asking the run to end, not a channel failure, so it must not be
          // reported as one — doing so left a deliberate Stop showing a red
          // "Channel error" and a status of error rather than stopped.
          if (this.stopped) break;
          this.setError(`Channel error while waiting for action: ${(err as Error).message}`);
          break;
        } finally {
          this.awaitingStateId = null;
        }
      }

      // Honour Stop and Pause *here*, before requesting a transition. Checking
      // only at the top of the loop would fire one more Claude turn — the
      // transition pick — after the user asked the run to stop or hold.
      if (this.stopped) break;
      if (!(await this.awaitResume())) break;

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

      // Armed before sending, for the same reason as the action waiter above.
      this.awaitingTransitionFrom = currentId!;
      const chosen = new Promise<string>((resolve, reject) => {
        this.resolveTransition = resolve;
        this.rejectTransition = reject;
      });
      chosen.catch(() => {});

      // Ask Claude to pick a transition
      try {
        await this.client.pickTransition({
          sessionId: this.sessionId,
          stateId: currentId!,
          // Without this the transition turn's activity carries no attempt and
          // is discarded, so the reasoning behind a loop-back is invisible.
          ...(stateAttemptId ? { attemptId: stateAttemptId } : {}),
          options: outgoing.map((t) => ({
            to: t.to,
            description: t.description || `Go to ${t.to}`,
          })),
        });
      } catch (err) {
        this.resolveTransition = null;
        this.rejectTransition = null;
        this.awaitingTransitionFrom = null;
        this.setError(`Failed to send transition request: ${err}`);
        break;
      }

      // Wait for Claude to pick a transition. Like action waits, no
      // time-based timeout — only a fatal channel drop aborts.
      let picked: string;
      try {
        picked = await chosen;
      } catch (err) {
        if (this.stopped) break;
        this.setError(`Channel error while waiting for transition: ${(err as Error).message}`);
        break;
      } finally {
        this.awaitingTransitionFrom = null;
        this.currentAttemptId = null;
      }

      currentId = picked;
    }
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
    this.stopped = true;
    this.state.status = "completed";
    this.addOutput("[Stopped by user]");
    // Reject rather than resolve. Resolving would let the current iteration run
    // on past `await completion` and POST a transition — a fresh Claude turn
    // started after the user pressed Stop.
    this.rejectAction?.(new Error("Stopped by user"));
    this.resolveAction = null;
    this.rejectAction = null;
    this.rejectTransition?.(new Error("Stopped by user"));
    this.resolveTransition = null;
    this.rejectTransition = null;
    // Not "error": the user asked for this, and a red card would read as a
    // failure they need to investigate.
    this.closeAttempt(this.currentAttemptId, "stopped", undefined, undefined);
    this.currentAttemptId = null;
    this.resumeResolve?.();
    this.resumeResolve = null;
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

  /**
   * Repaint at most once per frame.
   *
   * Activity can arrive tens of times a second during a busy tool loop, and
   * `notify` replaces the whole state object — which re-renders the ReactFlow
   * canvas alongside the transcript. This app has already had to fix an 18% idle
   * CPU regression, so activity is deliberately not allowed to drive the render
   * loop directly. Control events still notify synchronously.
   */
  private scheduleNotify() {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    const flush = () => {
      this.notifyQueued = false;
      this.notify();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }
}

function newAttemptId(): string {
  return crypto.randomUUID();
}
