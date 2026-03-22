import { useState } from "react";

interface Skill {
  name: string;
  source: string;
  content: string;
}

const mockSkills: Skill[] = [
  {
    name: "git:analyze-issue",
    source: "commands",
    content: "Analyze the GitHub issue and create a detailed technical specification with reproduction steps, root cause hypothesis, and proposed fix.",
  },
  {
    name: "git:commit",
    source: "commands",
    content: "Create a well-formatted commit with conventional commit message and emoji prefix.",
  },
  {
    name: "sdd:developer",
    source: "agents",
    content: "Implement the task following acceptance criteria, leveraging existing codebase patterns to deliver production-ready code that passes all tests.",
  },
  {
    name: "code-review:code-reviewer",
    source: "agents",
    content: "Review code for adherence to project guidelines, style guides, and best practices.",
  },
  {
    name: "code-review:security-auditor",
    source: "agents",
    content: "Review code to identify security vulnerabilities and risks.",
  },
  {
    name: "code-review:bug-hunter",
    source: "agents",
    content: "Identify bugs and critical issues through systematic root cause analysis.",
  },
  {
    name: "kaizen:root-cause-tracing",
    source: "skills",
    content: "Systematically trace bugs backward through call stack, adding instrumentation when needed, to identify source of invalid data or incorrect behavior.",
  },
  {
    name: "tdd:write-tests",
    source: "skills",
    content: "Systematically add test coverage for all local code changes using specialized review and development agents.",
  },
  {
    name: "reflexion:reflect",
    source: "skills",
    content: "Reflect on previous response and output based on self-refinement framework for iterative improvement.",
  },
];

interface SkillPickerProps {
  onSelect: (content: string) => void;
  onClose: () => void;
}

export default function SkillPicker({ onSelect, onClose }: SkillPickerProps) {
  const [search, setSearch] = useState("");

  const filtered = mockSkills.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.content.toLowerCase().includes(search.toLowerCase())
  );

  const grouped = {
    commands: filtered.filter((s) => s.source === "commands"),
    agents: filtered.filter((s) => s.source === "agents"),
    skills: filtered.filter((s) => s.source === "skills"),
  };

  return (
    <div className="skill-picker-overlay" onClick={onClose}>
      <div className="skill-picker" onClick={(e) => e.stopPropagation()}>
        <div className="skill-picker-header">
          <span>Import Skill</span>
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
          {Object.entries(grouped).map(([group, items]) =>
            items.length > 0 ? (
              <div key={group}>
                <div className="skill-picker-group">{group}</div>
                {items.map((skill) => (
                  <button
                    key={skill.name}
                    className="skill-picker-item"
                    onClick={() => onSelect(skill.content)}
                  >
                    <span className="skill-picker-name">{skill.name}</span>
                    <span className="skill-picker-preview">
                      {skill.content.length > 60
                        ? skill.content.slice(0, 60) + "..."
                        : skill.content}
                    </span>
                  </button>
                ))}
              </div>
            ) : null
          )}
          {filtered.length === 0 && (
            <div className="skill-picker-empty">No skills found</div>
          )}
        </div>
      </div>
    </div>
  );
}
