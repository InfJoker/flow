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
  actions?: Action[];
  subflow?: WorkflowRef;
  position?: { x: number; y: number };
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
