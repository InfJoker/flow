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

// SSE event types sent to the Tauri app
export type SSEEvent =
  | { type: "action_complete"; data: ActionCompleteResult }
  | { type: "transition_picked"; data: TransitionReply }
  | { type: "status"; data: { state: string; message: string } }
  | { type: "error"; data: { message: string } };
