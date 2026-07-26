import type { SessionInfo } from "./engine/SessionManager";

interface SessionsSidebarProps {
  sessions: SessionInfo[];
  activeSessionId: string | null;
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

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function SessionsSidebar({
  sessions,
  activeSessionId,
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
        return (
          <button
            key={s.sessionId}
            className={`run-session-item ${isActive ? "active" : ""}`}
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
              {/* What this run can read and write. Worth the row: without it the
                  user has no way to tell which project a session acts on. */}
              {s.cwd && (
                <span className="session-cwd" title={s.cwd}>
                  {shortenPath(s.cwd)}
                </span>
              )}
            </div>
          </button>
        );
      })}
      {sessions.length === 0 && (
        <div className="sessions-empty">
          <p>No active sessions</p>
          <p className="sessions-hint">
            Start Claude Code with:
            <br />
            claude --dangerously-load-development-channels server:agent-flow
          </p>
        </div>
      )}
    </div>
  );
}
