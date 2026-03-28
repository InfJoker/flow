import { useState, useEffect, useCallback } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import type { Skill } from "../types";

const mockSkills: Skill[] = [
  { name: "git:analyze-issue", description: "Analyze GitHub issue", source: "commands", content: "Analyze the GitHub issue and create a detailed technical specification.", path: "" },
  { name: "git:commit", description: "Create well-formatted commit", source: "commands", content: "Create a well-formatted commit with conventional commit message.", path: "" },
  { name: "sdd:developer", description: "Implement tasks", source: "agents", content: "Implement the task following acceptance criteria.", path: "" },
  { name: "code-review:code-reviewer", description: "Review code quality", source: "agents", content: "Review code for adherence to project guidelines.", path: "" },
  { name: "code-review:security-auditor", description: "Security review", source: "agents", content: "Review code to identify security vulnerabilities.", path: "" },
];

async function invokeSkillScan(): Promise<Skill[]> {
  if (isTauri()) {
    return invoke("scan_skills");
  }
  return mockSkills;
}

export function useSkills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invokeSkillScan();
      setSkills(result);
    } catch {
      setSkills(mockSkills);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { skills, loading, refresh };
}
