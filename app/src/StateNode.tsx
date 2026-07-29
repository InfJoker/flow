import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { StateNodeData } from "./types";

function StateNode({
  data,
  selected,
}: NodeProps & {
  data: StateNodeData & { runStatus?: string; visits?: number; filtered?: boolean };
}) {
  const { state, runStatus, visits = 0, filtered } = data;
  const hasSubagent = state.subagent;
  const hasSubflow = !!state.subflow;
  const actionCount = state.actions?.length ?? 0;

  const statusClass = runStatus ? `run-${runStatus}` : "";

  return (
    <div
      className={`state-node ${selected ? "selected" : ""} ${hasSubagent ? "subagent" : ""} ${statusClass} ${filtered ? "filtered" : ""}`}
    >
      <Handle type="target" position={Position.Left} />

      <div className="state-node-header">
        <span className="state-node-name">{state.name}</span>
        <div className="state-node-badges">
          {hasSubagent && <span className="state-node-badge subagent-badge">subagent</span>}
          {/* Only from the second visit on: a linear workflow should carry no
              extra noise, but a loop that has been round several times is
              exactly what the user needs to see at a glance. */}
          {visits > 1 && (
            <span className="state-node-badge visits-badge" title={`Visited ${visits} times`}>
              ×{visits}
            </span>
          )}
          {runStatus === "done" && <span className="state-node-badge done-badge">done</span>}
          {runStatus === "active" && <span className="state-node-badge active-badge">running</span>}
        </div>
      </div>

      <div className="state-node-body">
        {state.actions?.map((action, i) => (
          <div key={i} className={`state-node-action ${action.type}`}>
            <span className="action-icon">
              {action.type === "prompt" ? ">" : "$"}
            </span>
            <span className="action-content">
              {action.agent ? `[${action.agent}] ` : ""}
              {action.content.length > 40
                ? action.content.slice(0, 40) + "..."
                : action.content}
            </span>
            {action.shell && (
              <span className="action-shell">{action.shell}</span>
            )}
          </div>
        ))}
        {hasSubflow && (
          <div className="state-node-action subflow">
            <span className="action-icon">~</span>
            <span className="action-content">
              subflow: {state.subflow!.workflowId}
            </span>
          </div>
        )}
        {actionCount === 0 && !hasSubflow && (
          <div className="state-node-empty">No actions</div>
        )}
        {actionCount > 1 && (
          <div className="state-node-parallel">parallel ({actionCount})</div>
        )}
      </div>

      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export default memo(StateNode);
