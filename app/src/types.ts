export interface Workflow {
  id: string;
  name: string;
  description: string;
  states: WorkflowState[];
  transitions: Transition[];
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkflowState {
  id: string;
  name: string;
  subagent?: boolean;
  /**
   * Marks a state as requiring real user interaction (e.g. a brainstorming
   * prompt that expects the user to reply). Interactive states must not be
   * marked complete until the user has actually responded in a subsequent
   * turn — see channel-server/src/server.ts formatExecuteContent.
   */
  interactive?: boolean;
  actions?: Action[];
  subflow?: WorkflowRef;
  position?: { x: number; y: number };
}

export type ModelOverride = "sonnet" | "opus" | "haiku";

export interface Action {
  type: "prompt" | "script";
  content: string;
  agent?: string;
  model?: ModelOverride;
  shell?: "bash" | "python";
}

export interface WorkflowRef {
  workflowId: string;
}

export interface Transition {
  from: string;
  to: string;
  description: string;
}

export interface Skill {
  name: string;
  description: string;
  source: string;
  content: string;
  path: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  updatedAt?: string;
}

// React Flow node data
export interface StateNodeData {
  state: WorkflowState;
  selected?: boolean;
}
