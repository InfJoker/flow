import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Attempt, ActivityEntry, ExecutionState } from "./engine/StateMachineEngine";
import type { SessionCapabilities } from "./hooks/useExecution";

interface ActivityPanelProps {
  executionState: ExecutionState;
  capabilities: SessionCapabilities;
  /**
   * Whether a run is attached that can actually carry a message. A session can
   * advertise chat support while the app is only *observing* it, in which case
   * there is nothing to send through.
   */
  canChat: boolean;
  /** Display name for the filtered state, even if it has never run. */
  filterStateName: string | null;
  /** When set, only this state's attempts are shown. */
  filterStateId: string | null;
  onClearFilter: () => void;
  onFilterState: (stateId: string) => void;
  /** Resolves false when the message could not be dispatched. */
  onSendChat: (text: string) => Promise<boolean> | boolean;
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
  // Read once, at mount. `open` is a live DOM property, so leaving it driven by
  // a prop meant that the instant a newer attempt appended, this card's prop
  // flipped true→false and React closed it — collapsing the very card the user
  // was reading, on the most frequent event in the app. After mount, only the
  // user opens and closes cards.
  const initiallyOpen = useRef(openByDefault).current;

  if (attempt.kind === "chat") {
    return (
      <div className="attempt chat">
        <div className="chat-author">You</div>
        <p className="chat-message">{attempt.prompt}</p>
        {attempt.status === "running" && <p className="chat-pending">Waiting for a reply…</p>}
        {/* The reply is the payload the user is waiting on, so it gets the
            stronger treatment — not the message they just typed themselves. */}
        {attempt.result && <p className="chat-reply">{attempt.result}</p>}
        {attempt.error && <p className="chat-error">Could not deliver: {attempt.error}</p>}
      </div>
    );
  }

  return (
    <details className={`attempt state ${attempt.status}`} open={initiallyOpen || undefined}>
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
        {/* Text, not just the dot's colour: a collapsed failed visit and a
            collapsed successful one were otherwise byte-identical, so a failure
            in a long run could only be found by opening every card. */}
        <span className={`attempt-meta ${attempt.status === "error" ? "failed" : ""}`}>
          {attempt.status === "running"
            ? "running"
            : attempt.status === "stopped"
              ? "stopped"
              : attempt.status === "error"
                ? `failed · ${duration(attempt)}`
                : duration(attempt)}
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
  canChat,
  filterStateName,
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

  // Prefer the workflow's own name: a state that has not run yet has no attempt
  // to borrow a label from, and showing its raw id reads as a bug.
  const filteredName = filterStateId
    ? filterStateName ?? attempts.find((a) => a.stateId === filterStateId)?.label ?? filterStateId
    : null;

  const chatEnabled = capabilities.chat && canChat;

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

  // Only clear the box once the message is actually on its way. Clearing first
  // destroyed what the user typed whenever nothing was there to carry it.
  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    const dispatched = await onSendChat(text);
    if (dispatched !== false) setDraft("");
  };

  const running = status === "running";
  const lastIndex = visible.rows.length - 1;

  return (
    <div className="run-activity">
      <div className="activity-header">
        <div className="panel-label">Activity</div>
        {running && capabilities.interrupt && (
          <button
            className="panel-btn-sm"
            onClick={onInterrupt}
            /* Says what actually happens: the turn stops where it is, its partial
               work becomes the state's result, and the run carries on from there.
               "End the current step" implied the run would hold. */
            title="Stop this step now and continue with whatever it has done so far"
          >
            Interrupt step
          </button>
        )}
      </div>

      {/* Run-level outcome. Attempts show what each state did; without this a run
          that failed or finished looked identical to one still thinking. */}
      {(status === "error" || status === "completed" || status === "paused") && (
        <p className={`activity-run-status ${status}`} role="status">
          {status === "error"
            ? `Run failed — ${executionState.error ?? "see the last step"}`
            : status === "paused"
              ? "Run paused."
              : "Run finished."}
        </p>
      )}

      {filterStateId && (
        <div className="activity-filter">
          <button
            className="activity-filter-back"
            /* Clearing the filter unmounts this button. Focus would fall to
               <body>, stranding a keyboard user at the top of the document, so
               it is handed to the transcript they just returned to. */
            onClick={() => {
              onClearFilter();
              requestAnimationFrame(() => scrollRef.current?.focus());
            }}
          >
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

      {/* tabIndex -1 so it can receive focus programmatically when the filter is
          cleared, and so the transcript is reachable as a scrollable region. */}
      <div className="activity-scroll" ref={scrollRef} tabIndex={-1} aria-label="Run transcript">
        {visible.hidden > 0 && (
          <p className="activity-truncated">
            Showing the most recent {WINDOW}. {visible.hidden} earlier{" "}
            {visible.hidden === 1 ? "entry is" : "entries are"} not shown
            {!filterStateId && " — click a state to narrow to its own runs"}.
          </p>
        )}

        {filterStateId && visible.rows.length === 0 && (
          <p className="activity-empty">
            {filteredName} has not run yet.
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
            !capabilities.chat
              ? "This session does not accept messages"
              : !canChat
                ? "Watching this session — press Run to send messages"
                : running
                  ? "Send a message — delivered after this step finishes"
                  : "Send a message to the agent"
          }
          disabled={!chatEnabled}
          onChange={(e) => setDraft(e.target.value)}
          // Enter sends, but never mid-composition: committing a Japanese,
          // Chinese or Korean candidate also presses Enter.
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !composing.current) {
              e.preventDefault();
              void send();
            }
          }}
          aria-label="Message the agent"
        />
        <button
          className="composer-send"
          onClick={() => void send()}
          disabled={!chatEnabled || !draft.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
