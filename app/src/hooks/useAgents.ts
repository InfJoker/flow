import { useMemo } from "react";
import type { Skill } from "../types";

export interface AgentOption {
  name: string;
  description: string;
  source: string;
}

const builtInAgents: AgentOption[] = [
  { name: "general-purpose", description: "General-purpose agent for complex tasks", source: "built-in" },
  { name: "Explore", description: "Fast codebase exploration agent", source: "built-in" },
  { name: "Plan", description: "Software architect for implementation plans", source: "built-in" },
];

export function useAgents(skills: Skill[]) {
  const agents = useMemo(() => {
    const pluginAgents: AgentOption[] = skills
      .filter((s) => s.path.includes("/agents/"))
      .map((s) => ({ name: s.name, description: s.description, source: s.source }));

    const pluginNames = new Set(pluginAgents.map((a) => a.name));
    const uniqueBuiltIn = builtInAgents.filter((a) => !pluginNames.has(a.name));

    return [...uniqueBuiltIn, ...pluginAgents];
  }, [skills]);

  return { agents };
}
