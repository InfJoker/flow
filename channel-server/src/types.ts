export interface Action {
  type: "prompt" | "script";
  content: string;
  agent?: string;
  model?: string;
  shell?: "bash" | "python";
}

export interface ExecuteStatePayload {
  sessionId: string;
  stateId: string;
  stateName: string;
  actions: Action[];
  subagent: boolean;
  interactive?: boolean;
  /**
   * Identifies this particular run of this state.
   *
   * A cyclic workflow re-enters the same state — a research loop may visit
   * "Judge Quality" five times — so `stateId` alone cannot say which visit an
   * activity event belongs to, and attempt N's tool calls would be appended to
   * attempt N-1's transcript.
   *
   * Minted by the engine *before* it POSTs, never by the server: the engine has
   * to be able to file events that arrive before the POST response does, which
   * fire-and-ack makes routine. Optional so an older app still works, with
   * activity simply unattributed.
   */
  attemptId?: string;
}

export interface PickTransitionPayload {
  sessionId: string;
  stateId: string;
  options: { to: string; description: string }[];
  attemptId?: string;
}

/** A message the user typed, delivered into the same Claude session. */
export interface ChatTurnPayload {
  sessionId: string;
  /** Minted by the app, for the same reason as `ExecuteStatePayload.attemptId`. */
  attemptId: string;
  text: string;
}

export interface ActionCompleteResult {
  sessionId: string;
  stateId: string;
  results: string;
  attemptId?: string;
}

export interface TransitionReply {
  sessionId: string;
  stateId: string;
  picked: string; // target state ID
  reason: string;
  attemptId?: string;
}

/**
 * One thing the agent did, streamed while it happens.
 *
 * This is what makes "see what it is doing in each state" possible: without it
 * the UI only learns anything when the whole state finishes.
 */
export type ActivityKind = "assistant_text" | "tool_use" | "tool_result" | "note";

export interface ActivityData {
  attemptId: string;
  /**
   * The state this activity belongs to, or null for a chat turn — chat is
   * modelled as an attempt with no state, so one timeline holds both.
   */
  stateId: string | null;
  kind: ActivityKind;
  /** Assistant prose, or the text of a note. */
  text?: string;
  /** Tool name, for `tool_use` and `tool_result`. */
  tool?: string;
  /** Short, already-truncated summary of the tool's input. Never the full input. */
  detail?: string;
  /** Whether a `tool_result` succeeded. */
  ok?: boolean;
}

export interface ChatCompleteData {
  attemptId: string;
  result: string;
  /**
   * Set when the chat turn failed.
   *
   * Deliberately reported here and NOT as an `error` SSE event: the app's
   * execution engine treats `error` as a fatal channel drop and rejects whatever
   * state or transition it is waiting on, so a failed chat message would abort a
   * healthy workflow run.
   */
  error?: string;
}

/**
 * Facts about the session that are only knowable once it is running.
 *
 * `claudeSessionId` in particular is unknown until Claude's first turn reports
 * it, and it is what lets the user reopen the run in a terminal with
 * `claude --resume <id>`.
 */
export interface SessionMetaData {
  claudeSessionId?: string;
  backend: "channel" | "sdk";
  cwd: string;
  /**
   * What this session can do, so the UI degrades honestly instead of showing an
   * empty panel that looks broken. The channel backend cannot stream activity —
   * it learns nothing until Claude calls `report_action_complete` — and cannot
   * accept chat, because there is no session it owns to send a message into.
   */
  capabilities: { activity: boolean; chat: boolean; interrupt: boolean };
}

export interface SessionInfo {
  sessionId: string;
  /** Claude's own session id — the argument to `claude --resume`. */
  claudeSessionId?: string;
  port: number;
  workflowId: string;
  workflowName: string;
  pid: number;
  startedAt: string;
  /** Which backend drives Claude for this session. */
  backend?: "channel" | "sdk";
  /**
   * Directory the workflow's actions run in. Under the channel backend this is
   * wherever the user launched Claude Code; under the SDK backend the server
   * chooses it. Either way the app needs it to show what a run can touch.
   */
  cwd?: string;
}

// SSE event types sent to the Tauri app.
//
// `runId` identifies the registration the event belongs to. The server outlives
// any single workflow run, so without it a late event from a finished run —
// replayed or delivered live — can settle the next run's waiter and desync the
// whole workflow. Assigned by the server on /register; clients ignore events
// stamped with any other run.
export type SSEEvent =
  | { type: "action_complete"; data: ActionCompleteResult; runId?: string }
  | { type: "transition_picked"; data: TransitionReply; runId?: string }
  | { type: "status"; data: { state: string; message: string }; runId?: string }
  | { type: "error"; data: { message: string }; runId?: string }
  | { type: "activity"; data: ActivityData; runId?: string }
  | { type: "chat_complete"; data: ChatCompleteData; runId?: string }
  | { type: "session_meta"; data: SessionMetaData; runId?: string };

/**
 * Events that must survive buffer eviction and be replayed to a late or
 * reconnecting client.
 *
 * Everything here either settles a waiter in the engine or carries state the UI
 * cannot recover by other means. `activity` is deliberately excluded: it is
 * high-volume narration, and losing some of it costs detail, whereas losing an
 * `action_complete` hangs the run forever.
 */
export const CRITICAL_EVENT_TYPES: ReadonlySet<SSEEvent["type"]> = new Set([
  "action_complete",
  "transition_picked",
  "error",
  "chat_complete",
  "session_meta",
] as const);

export function isCriticalEvent(event: SSEEvent): boolean {
  return CRITICAL_EVENT_TYPES.has(event.type);
}
