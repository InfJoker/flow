import {
  ReactFlow,
  Background,
  BackgroundVariant,
  type Node,
  type Edge,
} from "@xyflow/react";
import { nodeTypes } from "./graphUtils";
import SessionsSidebar from "./SessionsSidebar";
import LiveOutput from "./LiveOutput";
import type { ExecutionState } from "./engine/StateMachineEngine";
import type { SessionInfo } from "./engine/SessionManager";
import type { WorkflowState } from "./types";

interface RunViewProps {
  nodes: Node[];
  edges: Edge[];
  executionState: ExecutionState;
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onSelectSession: (session: SessionInfo) => void;
  onRefreshSessions: () => void;
}

export default function RunView({
  nodes,
  edges,
  executionState,
  sessions,
  activeSessionId,
  onSelectSession,
  onRefreshSessions,
}: RunViewProps) {
  // Map execution state to node run status
  const runNodes = nodes.map((n) => {
    const exec = executionState.history.find((h) => h.stateId === n.id);
    let runStatus = "pending";
    if (exec) {
      if (exec.status === "done") runStatus = "done";
      else if (exec.status === "running") runStatus = "active";
    }
    return {
      ...n,
      data: { ...n.data, runStatus },
    };
  });

  const currentStateName = executionState.currentStateId
    ? (nodes.find((n) => n.id === executionState.currentStateId)?.data as { state: WorkflowState })
        ?.state?.name ?? executionState.currentStateId
    : null;

  return (
    <div className="run-view">
      <SessionsSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={onSelectSession}
        onRefresh={onRefreshSessions}
      />

      <div className="run-flow">
        <ReactFlow
          nodes={runNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color="#21262d"
          />
        </ReactFlow>
      </div>

      <LiveOutput output={executionState.output} currentState={currentStateName} />
    </div>
  );
}
