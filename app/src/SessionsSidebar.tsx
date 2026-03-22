import type { SessionInfo } from "./engine/SessionManager";

interface SessionsSidebarProps {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onSelect: (session: SessionInfo) => void;
  onRefresh: () => void;
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
      {sessions.map((s) => (
        <button
          key={s.sessionId}
          className={`run-session-item ${s.sessionId === activeSessionId ? "active" : ""}`}
          onClick={() => onSelect(s)}
        >
          <span
            className={`session-dot ${s.sessionId === activeSessionId ? "running" : "paused"}`}
          />
          <div className="session-info">
            <span className="session-name">{s.workflowName}</span>
            <span className="session-time">{timeAgo(s.startedAt)}</span>
          </div>
        </button>
      ))}
      {sessions.length === 0 && (
        <div className="sessions-empty">
          <p>No active sessions</p>
          <p className="sessions-hint">
            Start Claude Code with the channel flag, or click Run in the editor
          </p>
        </div>
      )}
    </div>
  );
}
