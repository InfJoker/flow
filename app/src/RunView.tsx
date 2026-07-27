import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  type Node,
  type Edge,
} from "@xyflow/react";
import { nodeTypes } from "./graphUtils";
import SessionsSidebar from "./SessionsSidebar";
import ActivityPanel from "./ActivityPanel";
import type { ExecutionState } from "./engine/StateMachineEngine";
import type { SessionInfo } from "./engine/SessionManager";
import type { SessionCapabilities } from "./hooks/useExecution";
import type { ClaudeSession } from "./hooks/useClaudeSessions";

interface RunViewProps {
  nodes: Node[];
  edges: Edge[];
  executionState: ExecutionState;
  sessions: SessionInfo[];
  claudeSessions: ClaudeSession[];
  activeSessionId: string | null;
  capabilities: SessionCapabilities;
  claudeSessionId: string | null;
  projectPath: string | null;
  filterStateId: string | null;
  onFilterState: (stateId: string | null) => void;
  onSelectSession: (session: SessionInfo) => void;
  onRefreshSessions: () => void;
  onSendChat: (text: string) => void;
  onInterrupt: () => void;
}

export default function RunView({
  nodes,
  edges,
  executionState,
  sessions,
  claudeSessions,
  activeSessionId,
  capabilities,
  claudeSessionId,
  projectPath,
  filterStateId,
  onFilterState,
  onSelectSession,
  onRefreshSessions,
  onSendChat,
  onInterrupt,
}: RunViewProps) {
  // How many times each state has been visited, so a node can show that a loop
  // has gone round more than once without opening the transcript.
  const visitCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of executionState.attempts) {
      if (a.stateId) counts.set(a.stateId, (counts.get(a.stateId) ?? 0) + 1);
    }
    return counts;
  }, [executionState.attempts]);

  // Memoized: activity lands often, and rebuilding this array on every event
  // re-renders the whole canvas.
  const runNodes = useMemo(
    () =>
      nodes.map((n) => {
        const exec = executionState.history.find((h) => h.stateId === n.id);
        let runStatus = "pending";
        if (exec) {
          if (exec.status === "done") runStatus = "done";
          else if (exec.status === "running") runStatus = "active";
        }
        return {
          ...n,
          data: {
            ...n.data,
            runStatus,
            visits: visitCounts.get(n.id) ?? 0,
            filtered: filterStateId === n.id,
          },
        };
      }),
    [nodes, executionState.history, visitCounts, filterStateId]
  );

  return (
    <div className="run-view">
      <SessionsSidebar
        sessions={sessions}
        claudeSessions={claudeSessions}
        activeSessionId={activeSessionId}
        claudeSessionId={claudeSessionId}
        projectPath={projectPath}
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
          onNodeClick={(_, node) =>
            onFilterState(filterStateId === node.id ? null : node.id)
          }
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color="#21262d"
          />
        </ReactFlow>
      </div>

      <ActivityPanel
        executionState={executionState}
        capabilities={capabilities}
        filterStateId={filterStateId}
        onClearFilter={() => onFilterState(null)}
        onFilterState={onFilterState}
        onSendChat={onSendChat}
        onInterrupt={onInterrupt}
      />
    </div>
  );
}
