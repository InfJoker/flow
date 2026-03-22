import { useState } from "react";
import SkillPicker from "./SkillPicker";
import type { WorkflowState, Action, Transition } from "./types";

interface StatePanelProps {
  state: WorkflowState;
  transitions: Transition[];
  allStateNames: { id: string; name: string }[];
  onUpdate: (state: WorkflowState) => void;
  onUpdateTransitions: (transitions: Transition[]) => void;
  onDelete: () => void;
  onClose: () => void;
}

export default function StatePanel({
  state,
  transitions,
  allStateNames,
  onUpdate,
  onUpdateTransitions,
  onDelete,
  onClose,
}: StatePanelProps) {
  const [importingActionIndex, setImportingActionIndex] = useState<number | null>(null);
  const outgoing = transitions.filter((t) => t.from === state.id);

  const updateName = (name: string) => {
    onUpdate({ ...state, name });
  };

  const toggleSubagent = () => {
    onUpdate({ ...state, subagent: !state.subagent });
  };

  const addAction = (type: "prompt" | "script") => {
    const newAction: Action = {
      type,
      content: "",
      ...(type === "script" ? { shell: "bash" as const } : {}),
    };
    onUpdate({ ...state, actions: [...(state.actions ?? []), newAction] });
  };

  const updateAction = (index: number, action: Action) => {
    const actions = [...(state.actions ?? [])];
    actions[index] = action;
    onUpdate({ ...state, actions });
  };

  const removeAction = (index: number) => {
    const actions = [...(state.actions ?? [])];
    actions.splice(index, 1);
    onUpdate({ ...state, actions });
  };

  const addTransition = () => {
    const availableTargets = allStateNames.filter((s) => s.id !== state.id);
    if (availableTargets.length === 0) return;
    const newTransition: Transition = {
      from: state.id,
      to: availableTargets[0].id,
      description: "",
    };
    onUpdateTransitions([...transitions, newTransition]);
  };

  const updateTransition = (
    index: number,
    field: "to" | "description",
    value: string
  ) => {
    const allTransitions = [...transitions];
    const outgoingIndices = allTransitions
      .map((t, i) => (t.from === state.id ? i : -1))
      .filter((i) => i >= 0);
    const globalIndex = outgoingIndices[index];
    allTransitions[globalIndex] = {
      ...allTransitions[globalIndex],
      [field]: value,
    };
    onUpdateTransitions(allTransitions);
  };

  const removeTransition = (index: number) => {
    const allTransitions = [...transitions];
    const outgoingIndices = allTransitions
      .map((t, i) => (t.from === state.id ? i : -1))
      .filter((i) => i >= 0);
    const globalIndex = outgoingIndices[index];
    allTransitions.splice(globalIndex, 1);
    onUpdateTransitions(allTransitions);
  };

  return (
    <div className="state-panel">
      <div className="panel-header">
        <span className="panel-title">State</span>
        <div className="panel-header-actions">
          <button
            className="panel-btn-danger-text"
            onClick={onDelete}
            title="Delete state"
          >
            Delete
          </button>
          <button className="panel-close" onClick={onClose} title="Close (Esc)">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3L11 11M11 3L3 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>

      <div className="panel-header-section">
        <div className="panel-field">
          <label className="panel-label">Name</label>
          <input
            className="panel-input"
            value={state.name}
            onChange={(e) => updateName(e.target.value)}
          />
        </div>
        <label className="panel-toggle">
          <input
            type="checkbox"
            checked={state.subagent ?? false}
            onChange={toggleSubagent}
          />
          <span>Subagent</span>
        </label>
      </div>

      <div className="panel-section panel-section-primary">
        <div className="panel-section-header">
          <label className="panel-label">Actions</label>
          <div className="panel-actions-buttons">
            <button className="panel-btn-sm" onClick={() => addAction("prompt")}>
              + Prompt
            </button>
            <button className="panel-btn-sm" onClick={() => addAction("script")}>
              + Script
            </button>
          </div>
        </div>

        {(state.actions ?? []).map((action, i) => (
          <div key={i} className="panel-action-item">
            <div className="panel-action-header">
              <span className={`action-type-badge ${action.type}`}>
                {action.type}
              </span>
              {action.type === "script" && (
                <select
                  className="panel-select-sm"
                  value={action.shell ?? "bash"}
                  onChange={(e) =>
                    updateAction(i, {
                      ...action,
                      shell: e.target.value as "bash" | "python",
                    })
                  }
                >
                  <option value="bash">bash</option>
                  <option value="python">python</option>
                </select>
              )}
              {state.subagent && action.type === "prompt" && (
                <input
                  className="panel-input-sm"
                  placeholder="agent (e.g. sdd:developer)"
                  value={action.agent ?? ""}
                  onChange={(e) =>
                    updateAction(i, { ...action, agent: e.target.value || undefined })
                  }
                />
              )}
              <button
                className="panel-btn-danger"
                onClick={() => removeAction(i)}
                title="Remove action"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
            <textarea
              className="panel-textarea"
              placeholder={
                action.type === "prompt"
                  ? "Agent instruction..."
                  : "Script command..."
              }
              value={action.content}
              onChange={(e) =>
                updateAction(i, { ...action, content: e.target.value })
              }
              rows={4}
            />
            {action.type === "prompt" && (
              <button
                className="panel-btn-import"
                onClick={() => setImportingActionIndex(i)}
              >
                Import Skill
              </button>
            )}
          </div>
        ))}

        {(state.actions ?? []).length === 0 && (
          <div className="panel-empty">No actions yet</div>
        )}
      </div>

      <details className="panel-section-collapsible" open>
        <summary className="panel-collapsible-header">
          <label className="panel-label">Transitions</label>
          <button className="panel-btn-sm" onClick={(e) => { e.preventDefault(); addTransition(); }}>
            + Add
          </button>
        </summary>

        <div className="panel-collapsible-content">
          {outgoing.map((t, i) => (
            <div key={i} className="panel-transition-item">
              <div className="panel-transition-header">
                <span className="transition-arrow">&rarr;</span>
                <select
                  className="panel-select"
                  value={t.to}
                  onChange={(e) => updateTransition(i, "to", e.target.value)}
                >
                  {allStateNames
                    .filter((s) => s.id !== state.id)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
                <button
                  className="panel-btn-danger"
                  onClick={() => removeTransition(i)}
                  title="Remove transition"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
              <input
                className="panel-input"
                placeholder="When to take this path..."
                value={t.description}
                onChange={(e) => updateTransition(i, "description", e.target.value)}
              />
            </div>
          ))}

          {outgoing.length === 0 && (
            <div className="panel-empty">No transitions — will ask user</div>
          )}
        </div>
      </details>

      {importingActionIndex !== null && (
        <SkillPicker
          onSelect={(content) => {
            const action = (state.actions ?? [])[importingActionIndex];
            if (action) {
              const separator = action.content ? "\n\n" : "";
              updateAction(importingActionIndex, {
                ...action,
                content: action.content + separator + content,
              });
            }
            setImportingActionIndex(null);
          }}
          onClose={() => setImportingActionIndex(null)}
        />
      )}
    </div>
  );
}
