export interface Workflow {
  id: string;
  name: string;
  description: string;
  states: WorkflowState[];
  transitions: Transition[];
}

export interface WorkflowState {
  id: string;
  name: string;
  subagent?: boolean;
  actions?: Action[];
  subflow?: WorkflowRef;
}

export interface Action {
  type: "prompt" | "script";
  content: string;
  agent?: string;
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

// React Flow node data
export interface StateNodeData {
  state: WorkflowState;
  selected?: boolean;
}
