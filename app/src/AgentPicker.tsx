import { useMemo, useState } from "react";
import type { AgentOption } from "./hooks/useAgents";

interface AgentPickerProps {
  agents: AgentOption[];
  current?: string;
  onSelect: (name: string | undefined) => void;
  onClose: () => void;
}

export default function AgentPicker({ agents, current, onSelect, onClose }: AgentPickerProps) {
  const [search, setSearch] = useState("");

  const filtered = agents.filter(
    (a) =>
      a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.description.toLowerCase().includes(search.toLowerCase())
  );

  const grouped = useMemo(() => {
    const groups: Record<string, AgentOption[]> = {};
    for (const agent of filtered) {
      if (!groups[agent.source]) groups[agent.source] = [];
      groups[agent.source].push(agent);
    }
    return Object.entries(groups).sort(([a], [b]) => {
      if (a === "built-in") return -1;
      if (b === "built-in") return 1;
      return a.localeCompare(b);
    });
  }, [filtered]);

  return (
    <div className="skill-picker-overlay" onClick={onClose}>
      <div className="skill-picker" onClick={(e) => e.stopPropagation()}>
        <div className="skill-picker-header">
          <span>Choose Agent</span>
          <span className="skill-picker-count">{filtered.length} agents</span>
          <button className="panel-close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3L11 11M11 3L3 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        <input
          className="skill-picker-search"
          placeholder="Search agents..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
        <div className="skill-picker-list">
          <button
            className={`skill-picker-item ${!current ? "active" : ""}`}
            onClick={() => onSelect(undefined)}
          >
            <span className="skill-picker-name">default</span>
            <span className="skill-picker-preview">Use the default Claude Code agent</span>
          </button>
          {grouped.map(([group, items]) => (
            <div key={group}>
              <div className="skill-picker-group">{group}</div>
              {items.map((agent) => (
                <button
                  key={agent.name}
                  className={`skill-picker-item ${current === agent.name ? "active" : ""}`}
                  onClick={() => onSelect(agent.name)}
                >
                  <span className="skill-picker-name">{agent.name}</span>
                  <span className="skill-picker-preview">{agent.description}</span>
                </button>
              ))}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="skill-picker-empty">No agents found</div>
          )}
        </div>
      </div>
    </div>
  );
}
