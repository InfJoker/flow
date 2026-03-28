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
}

// SSE event types sent to the Tauri app
export type SSEEvent =
  | { type: "action_complete"; data: ActionCompleteResult }
  | { type: "transition_picked"; data: TransitionReply }
  | { type: "status"; data: { state: string; message: string } }
  | { type: "error"; data: { message: string } };
