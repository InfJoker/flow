import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Attempt, ActivityEntry, ExecutionState } from "./engine/StateMachineEngine";
import type { SessionCapabilities } from "./hooks/useExecution";

interface ActivityPanelProps {
  executionState: ExecutionState;
  capabilities: SessionCapabilities;
  /** When set, only this state's attempts are shown. */
  filterStateId: string | null;
  onClearFilter: () => void;
  onFilterState: (stateId: string) => void;
  onSendChat: (text: string) => void;
  onInterrupt: () => void;
}

/**
 * How many attempts to render at once.
 *
 * An hour-long research loop produces far more than a scrollable list needs, but
 * truncation is announced rather than silent — a panel that claims to be the
 * whole record must not quietly drop the beginning of it.
 */
const WINDOW = 60;

function duration(attempt: Attempt): string {
  const end = attempt.completedAt ? Date.parse(attempt.completedAt) : Date.now();
  const secs = Math.max(0, Math.round((end - Date.parse(attempt.startedAt)) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`;
}

function ToolRow({ entry }: { entry: ActivityEntry }) {
  const failed = entry.kind === "tool_result" && entry.ok === false;
  return (
    <div className={`activity-tool ${failed ? "failed" : ""}`}>
      <span className="activity-tool-name">{entry.tool}</span>
      {entry.detail && <span className="activity-tool-detail">{entry.detail}</span>}
      {entry.kind === "tool_result" && (
        <span className="activity-tool-status" aria-label={failed ? "failed" : "succeeded"}>
          {failed ? "failed" : "ok"}
        </span>
      )}
    </div>
  );
}

function ActivityList({ entries }: { entries: ActivityEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="activity-entries">
      {entries.map((entry) =>
        entry.kind === "assistant_text" || entry.kind === "note" ? (
          <p key={entry.seq} className={`activity-text ${entry.kind === "note" ? "note" : ""}`}>
            {entry.text}
          </p>
        ) : (
          <ToolRow key={entry.seq} entry={entry} />
        )
      )}
    </div>
  );
}

/**
 * One visit to a state, or one chat exchange.
 *
 * Collapsible, and that is what makes repeats readable: five visits to a state
 * are five one-line summaries you can open independently — including two at
 * once, which a tab strip would prevent even though comparing runs is the point.
 */
function AttemptCard({
  attempt,
  openByDefault,
  onFilterState,
}: {
  attempt: Attempt;
  openByDefault: boolean;
  onFilterState: (stateId: string) => void;
}) {
  if (attempt.kind === "chat") {
    return (
      <div className="attempt chat">
        <p className="chat-message">{attempt.prompt}</p>
        {attempt.status === "running" && <p className="chat-pending">Waiting for a reply…</p>}
        {attempt.result && <p className="chat-reply">{attempt.result}</p>}
        {attempt.error && <p className="chat-error">Could not deliver: {attempt.error}</p>}
      </div>
    );
  }

  return (
    <details className={`attempt state ${attempt.status}`} open={openByDefault}>
      <summary className="attempt-summary">
        <span className={`attempt-dot ${attempt.status}`} aria-hidden="true" />
        {/* A button inside summary would swallow the disclosure toggle, so the
            state name filters via its own control placed after the label. */}
        <span className="attempt-name">{attempt.label}</span>
        {attempt.index > 1 && (
          <span className="attempt-index" title={`Visit ${attempt.index} to this state`}>
            run {attempt.index}
          </span>
        )}
        <span className="attempt-meta">
          {attempt.status === "running" ? "running" : duration(attempt)}
        </span>
      </summary>

      <div className="attempt-body">
        <button
          type="button"
          className="attempt-filter-link"
          onClick={() => attempt.stateId && onFilterState(attempt.stateId)}
        >
          Show only {attempt.label}
        </button>

        <ActivityList entries={attempt.activity} />

        {attempt.result && (
          <div className="attempt-result">
            <div className="attempt-result-label">Result</div>
            <p>{attempt.result}</p>
          </div>
        )}
        {attempt.error && <p className="attempt-error">{attempt.error}</p>}
        {attempt.transition && (
          <div className="attempt-transition">
            → {attempt.transition.picked}
            <span className="attempt-transition-reason">{attempt.transition.reason}</span>
          </div>
        )}
      </div>
    </details>
  );
}

export default function ActivityPanel({
  executionState,
  capabilities,
  filterStateId,
  onClearFilter,
  onFilterState,
  onSendChat,
  onInterrupt,
}: ActivityPanelProps) {
  const [draft, setDraft] = useState("");
  const [pinned, setPinned] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);

  const { attempts, status } = executionState;

  const visible = useMemo(() => {
    const scoped = filterStateId
      ? attempts.filter((a) => a.stateId === filterStateId)
      : attempts;
    return { rows: scoped.slice(-WINDOW), hidden: Math.max(0, scoped.length - WINDOW) };
  }, [attempts, filterStateId]);

  const filteredName = filterStateId
    ? attempts.find((a) => a.stateId === filterStateId)?.label ?? filterStateId
    : null;

  // Follow the tail only while the user is already at the bottom; yanking the
  // viewport while they are reading an earlier attempt is the fastest way to
  // make a long run unusable.
  useLayoutEffect(() => {
    if (!pinned) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.rows, pinned]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      setPinned(atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSendChat(text);
    setDraft("");
  };

  const running = status === "running";
  const lastIndex = visible.rows.length - 1;

  return (
    <div className="run-activity">
      <div className="activity-header">
        <div className="panel-label">Activity</div>
        {running && capabilities.interrupt && (
          <button className="panel-btn-sm" onClick={onInterrupt} title="End the current step">
            Interrupt step
          </button>
        )}
      </div>

      {filterStateId && (
        <div className="activity-filter">
          <button className="activity-filter-back" onClick={onClearFilter}>
            ‹ All activity
          </button>
          <span className="activity-filter-name">{filteredName}</span>
        </div>
      )}

      {!capabilities.activity && attempts.length > 0 && (
        <p className="activity-notice">
          This session reports results only — step-by-step activity is available on
          sessions Agent Flow starts itself.
        </p>
      )}

      <div className="activity-scroll" ref={scrollRef}>
        {visible.hidden > 0 && (
          <p className="activity-truncated">
            {visible.hidden} earlier {visible.hidden === 1 ? "entry" : "entries"} not shown.
            {!filterStateId && " Open a state to see all of its runs."}
          </p>
        )}

        {visible.rows.map((attempt, i) => (
          <AttemptCard
            key={attempt.attemptId}
            attempt={attempt}
            // Only the newest card starts open. Earlier ones stay collapsed and
            // are never closed again by the app — a card that collapses itself
            // while being read drops focus and destroys what you were reading.
            openByDefault={i === lastIndex}
            onFilterState={onFilterState}
          />
        ))}

        {attempts.length === 0 && (
          <p className="activity-empty">
            Nothing yet. Run a workflow and each state's work appears here as it happens.
          </p>
        )}
      </div>

      <div className="activity-composer">
        <textarea
          className="composer-input"
          value={draft}
          rows={2}
          placeholder={
            capabilities.chat
              ? running
                ? "Send a message — delivered after this step finishes"
                : "Send a message to the agent"
              : "This session does not accept messages"
          }
          disabled={!capabilities.chat}
          onChange={(e) => setDraft(e.target.value)}
          // Enter sends, but never mid-composition: committing a Japanese,
          // Chinese or Korean candidate also presses Enter.
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !composing.current) {
              e.preventDefault();
              send();
            }
          }}
          aria-label="Message the agent"
        />
        <button
          className="composer-send"
          onClick={send}
          disabled={!capabilities.chat || !draft.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
