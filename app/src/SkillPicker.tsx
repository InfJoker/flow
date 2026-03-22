import { useMemo, useState } from "react";
import type { Skill } from "./types";

interface SkillPickerProps {
  skills: Skill[];
  onSelect: (content: string) => void;
  onClose: () => void;
}

export default function SkillPicker({ skills, onSelect, onClose }: SkillPickerProps) {
  const [search, setSearch] = useState("");

  const filtered = skills.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.content.toLowerCase().includes(search.toLowerCase()) ||
      s.description.toLowerCase().includes(search.toLowerCase())
  );

  // Group by source (plugin name), sorted alphabetically
  const grouped = useMemo(() => {
    const groups: Record<string, Skill[]> = {};
    for (const skill of filtered) {
      const key = skill.source;
      if (!groups[key]) groups[key] = [];
      groups[key].push(skill);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <div className="skill-picker-overlay" onClick={onClose}>
      <div className="skill-picker" onClick={(e) => e.stopPropagation()}>
        <div className="skill-picker-header">
          <span>Import Skill</span>
          <span className="skill-picker-count">{filtered.length} items</span>
          <button className="panel-close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3L11 11M11 3L3 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        <input
          className="skill-picker-search"
          placeholder="Search skills, commands, agents..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
        <div className="skill-picker-list">
          {grouped.map(([group, items]) => (
            <div key={group}>
              <div className="skill-picker-group">{group}</div>
              {items.map((skill) => (
                <button
                  key={skill.name + skill.path}
                  className="skill-picker-item"
                  onClick={() => onSelect(skill.content)}
                >
                  <span className="skill-picker-name">{skill.name}</span>
                  <span className="skill-picker-preview">
                    {skill.description ||
                      (skill.content.length > 80
                        ? skill.content.slice(0, 80) + "..."
                        : skill.content)}
                  </span>
                </button>
              ))}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="skill-picker-empty">No skills found</div>
          )}
        </div>
      </div>
    </div>
  );
}
