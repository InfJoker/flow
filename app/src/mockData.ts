import type { Workflow } from "./types";

export const debugWorkflow: Workflow = {
  id: "debug-issue",
  name: "Debug Issue",
  description: "Automated debug workflow: fetch, analyze, fix, review, commit",
  states: [
    {
      id: "fetch",
      name: "Fetch Issue",
      actions: [
        {
          type: "prompt",
          content: "Fetch the issue details from the tracker and summarize the bug report",
        },
      ],
    },
    {
      id: "summarize",
      name: "Summarize",
      actions: [
        {
          type: "prompt",
          content: "Create a concise summary of the issue including reproduction steps and expected behavior",
        },
      ],
    },
    {
      id: "root-cause",
      name: "Root Cause Tracing",
      actions: [
        {
          type: "prompt",
          content: "Trace the root cause of the issue through the codebase. Use grep, read files, and analyze the call stack",
        },
      ],
    },
    {
      id: "review",
      name: "Review Investigation",
      actions: [
        {
          type: "prompt",
          content: "Review the root cause analysis. Is the investigation thorough? Are we confident in the cause?",
        },
      ],
    },
    {
      id: "implement",
      name: "Implement Fix",
      actions: [
        {
          type: "prompt",
          content: "Implement a fix for the root cause identified. Make minimal changes.",
        },
      ],
    },
    {
      id: "judge",
      name: "Judge Fix Quality",
      subagent: true,
      actions: [
        {
          type: "prompt",
          content: "Review the implementation for correctness and side effects",
          agent: "code-review:code-reviewer",
        },
        {
          type: "prompt",
          content: "Check for security vulnerabilities in the fix",
          agent: "code-review:security-auditor",
        },
      ],
    },
    {
      id: "test",
      name: "Run Tests",
      actions: [
        {
          type: "script",
          content: "npm test",
          shell: "bash",
        },
      ],
    },
    {
      id: "commit",
      name: "Commit",
      actions: [
        {
          type: "prompt",
          content: "Create a well-formatted commit with a descriptive message",
        },
      ],
    },
  ],
  transitions: [
    { from: "fetch", to: "summarize", description: "Issue details loaded" },
    { from: "summarize", to: "root-cause", description: "Summary complete" },
    { from: "root-cause", to: "review", description: "Root cause identified" },
    {
      from: "review",
      to: "implement",
      description: "Investigation is thorough and root cause is clear",
    },
    {
      from: "review",
      to: "root-cause",
      description: "Investigation needs more depth or confidence is low",
    },
    { from: "implement", to: "judge", description: "Fix implemented" },
    {
      from: "judge",
      to: "test",
      description: "Review score is 4 or above, fix looks good",
    },
    {
      from: "judge",
      to: "implement",
      description: "Review score below 4, changes needed",
    },
    { from: "test", to: "commit", description: "All tests pass" },
    {
      from: "test",
      to: "implement",
      description: "Tests fail, fix needs adjustment",
    },
  ],
};
