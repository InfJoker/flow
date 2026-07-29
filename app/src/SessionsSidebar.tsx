import { useState } from "react";
import type { SessionInfo } from "./engine/SessionManager";
import type { ClaudeSession } from "./hooks/useClaudeSessions";

interface SessionsSidebarProps {
  sessions: SessionInfo[];
  claudeSessions: ClaudeSession[];
  activeSessionId: string | null;
  /** Claude's session id for the live run, once its first turn reveals it. */
  claudeSessionId: string | null;
  projectPath: string | null;
  onSelect: (session: SessionInfo) => void;
  onRefresh: () => void;
}

/**
 * Shorten a path for display, keeping the tail — the last couple of segments are
 * what identify the project, and the sidebar is too narrow for a full path.
 */
export function shortenPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 2) return path;
  return `…/${segments.slice(-2).join("/")}`;
}

/** The command that reopens a run in a terminal, with its full context. */
export function resumeCommand(cwd: string, claudeSessionId: string): string {
  return `cd '${cwd}' && claude --resume ${claudeSessionId}`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Copy-to-clipboard button that confirms in place rather than via a toast. */
function CopyCommand({ command, label }: { command: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const text =
    state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy resume command";

  return (
    <>
      <button
        className={`resume-copy ${state === "failed" ? "failed" : ""}`}
        title={command}
        /* The accessible name has to carry the outcome too. A static aria-label
           overrides the button's text, so a screen reader would keep hearing
           "Copy resume command" after the copy had already happened. */
        aria-label={state === "idle" ? label : `${text}. ${label}`}
        onClick={async (e) => {
          e.stopPropagation();
          try {
            await navigator.clipboard.writeText(command);
            setState("copied");
            setTimeout(() => setState("idle"), 1500);
          } catch {
            // Clipboard access can be refused outright, and `navigator.clipboard`
            // is undefined on an insecure origin. Say so and show the command,
            // rather than looking like the click did nothing.
            setState("failed");
          }
        }}
      >
        {text}
      </button>
      {/* Selectable fallback: if the clipboard is unavailable the command still
          has to be obtainable, and a title tooltip is mouse-only. */}
      {state === "failed" && <code className="resume-fallback">{command}</code>}
    </>
  );
}

export default function SessionsSidebar({
  sessions,
  claudeSessions,
  activeSessionId,
  claudeSessionId,
  projectPath,
  onSelect,
  onRefresh,
}: SessionsSidebarProps) {
  return (
    <div className="run-sessions">
      <div className="sessions-header">
        <div className="panel-label">Sessions</div>
        <button className="panel-btn-sm" onClick={onRefresh}>
          Refresh
        </button>
      </div>

      {sessions.map((s) => {
        const isActive = s.sessionId === activeSessionId;
        // Prefer the live id learned over SSE: the session file is only rewritten
        // on the first turn, so a freshly attached session may not carry it yet.
        const resumeId = isActive ? claudeSessionId ?? s.claudeSessionId : s.claudeSessionId;
        return (
          <div key={s.sessionId} className={`run-session-item ${isActive ? "active" : ""}`}>
            <button
              className="run-session-main"
              onClick={() => onSelect(s)}
              /* aria-current, not aria-pressed: these are one-of-many choices,
                 and "pressed" would imply clicking again deselects. */
              aria-current={isActive ? "true" : undefined}
            >
              {/* The dot is decorative — its meaning is carried by aria-current
                  above and the visible text below, since colour alone is not a
                  usable signal. */}
              <span
                className={`session-dot ${isActive ? "running" : "paused"}`}
                aria-hidden="true"
              />
              <div className="session-info">
                <span className="session-name">{s.workflowName}</span>
                <span className="session-time">
                  {isActive ? "Selected · " : ""}
                  {timeAgo(s.startedAt)}
                  {s.backend === "sdk" ? " · built-in engine" : ""}
                </span>
              </div>
            </button>
            {resumeId && s.cwd && (
              <CopyCommand
                command={resumeCommand(s.cwd, resumeId)}
                label={`Copy the command to resume ${s.workflowName} in a terminal`}
              />
            )}
          </div>
        );
      })}

      {sessions.length === 0 && (
        <div className="sessions-empty">
          <p>No running sessions</p>
          <p className="sessions-hint">
            {projectPath
              ? "Press Run and Agent Flow starts one in this folder."
              : "Open a project folder to run a workflow."}
          </p>
        </div>
      )}

      {claudeSessions.length > 0 && (
        <>
          <div className="sessions-header sessions-subhead">
            <div className="panel-label">Claude Code here</div>
          </div>
          <p className="sessions-hint sessions-interop" id="claude-interop-note">
            Runs started here are ordinary Claude Code sessions — resume one in a
            terminal to carry on with its full context.
          </p>
          {claudeSessions.slice(0, 8).map((c) => (
            <div key={c.sessionId} className="claude-session-item">
              <span className="claude-session-title" title={c.title}>
                {c.title}
              </span>
              <span className="session-time">
                {timeAgo(c.modifiedAt)}
                {c.gitBranch ? ` · ${c.gitBranch}` : ""}
              </span>
              <CopyCommand
                command={resumeCommand(c.cwd, c.sessionId)}
                label={`Copy the command to resume "${c.title}" in a terminal`}
              />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
