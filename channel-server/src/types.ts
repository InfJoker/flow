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
}

export interface PickTransitionPayload {
  sessionId: string;
  stateId: string;
  options: { to: string; description: string }[];
}

export interface ActionCompleteResult {
  sessionId: string;
  stateId: string;
  results: string;
}

export interface TransitionReply {
  sessionId: string;
  stateId: string;
  picked: string; // target state ID
  reason: string;
}

export interface SessionInfo {
  sessionId: string;
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
  | { type: "error"; data: { message: string }; runId?: string };
