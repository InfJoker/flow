import { useEffect, useMemo } from "react";
import type { useUpdater } from "./hooks/useUpdater";

type UpdaterApi = ReturnType<typeof useUpdater>;

interface Props {
  updater: UpdaterApi;
  onClose: () => void;
}

function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDate(iso?: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

export default function SettingsModal({ updater, onClose }: Props) {
  const {
    settings,
    updateSettings,
    currentVersion,
    releases,
    releasesLoading,
    releasesError,
    loadReleases,
    status,
    checkNow,
    installUpdate,
  } = updater;

  // Fetch releases once when modal opens (cache-aware inside the hook)
  useEffect(() => {
    loadReleases();
  }, [loadReleases]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const pinValue = settings.pinnedVersion || "";

  const onPinChange = (nextTag: string) => {
    // Picking a pinned version can downgrade — Tauri's updater will accept
    // any version that differs from the current one. Confirm before applying
    // so the user doesn't accidentally roll back mid-task.
    if (nextTag && nextTag !== pinValue) {
      const confirmed = window.confirm(
        `Pin this app to ${nextTag}?\n\n` +
          `The next update check will install exactly this version, including ` +
          `rolling back if it's older than what you currently have.`
      );
      if (!confirmed) return;
    }
    updateSettings({ pinnedVersion: nextTag || undefined });
  };

  const statusLine = useMemo(() => {
    switch (status.kind) {
      case "idle":
        return null;
      case "checking":
        return <span className="settings-status">Checking…</span>;
      case "up-to-date":
        return <span className="settings-status success">You're up to date.</span>;
      case "available":
        return (
          <div className="settings-update">
            <div className="settings-update-title">
              Update available: <strong>{status.update.version}</strong>
              {status.update.date && (
                <span className="settings-muted"> — {formatDate(status.update.date)}</span>
              )}
            </div>
            {status.update.body && (
              <pre className="settings-update-notes">{status.update.body}</pre>
            )}
            <button className="top-btn primary" onClick={installUpdate}>
              Download &amp; install
            </button>
          </div>
        );
      case "downloading": {
        const pct = status.total > 0 ? Math.round((status.downloaded / status.total) * 100) : 0;
        return (
          <div className="settings-progress">
            <div className="settings-progress-bar">
              <div className="settings-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="settings-muted">
              {formatBytes(status.downloaded)}
              {status.total > 0 ? ` / ${formatBytes(status.total)}` : ""}
            </span>
          </div>
        );
      }
      case "installed":
        return <span className="settings-status success">Installed. Relaunching…</span>;
      case "error":
        return <span className="settings-status error">Error: {status.message}</span>;
    }
  }, [status, installUpdate]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
              <path
                d="M2 2L10 10M10 2L2 10"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="settings-body">
          <section className="settings-section">
            <div className="settings-row">
              <span className="settings-label">Current version</span>
              <span className="settings-value">{currentVersion || "unknown"}</span>
            </div>
          </section>

          <section className="settings-section">
            <h3 className="settings-section-title">Updates</h3>

            <label
              className="settings-toggle"
              title="When off, Agent Flow won't check on startup. You can still check manually below."
            >
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => updateSettings({ enabled: e.target.checked })}
              />
              <span>Automatically check for updates on startup</span>
            </label>
            <span className="settings-help">
              Manual checks below still work when this is off.
            </span>

            <div className="settings-row column">
              <span className="settings-label">Use specific version</span>
              <select
                className="settings-select"
                value={pinValue}
                onChange={(e) => onPinChange(e.target.value)}
                disabled={releasesLoading}
              >
                <option value="">Latest from main (dev)</option>
                {releases.map((r) => (
                  <option key={r.tagName} value={r.tagName}>
                    {r.tagName}
                    {r.prerelease ? " (prerelease)" : ""}
                    {r.publishedAt ? ` — ${formatDate(r.publishedAt)}` : ""}
                  </option>
                ))}
              </select>
              {releasesLoading && <span className="settings-help">Loading releases…</span>}
              {!releasesLoading && releasesError && (
                <span className="settings-help error">
                  Couldn't fetch releases: {releasesError}
                </span>
              )}
              {!releasesLoading && !releasesError && releases.length === 0 && (
                <span className="settings-help">
                  No pinnable releases yet — only the rolling dev build is published today.
                </span>
              )}
              {!releasesLoading && !releasesError && releases.length > 0 && (
                <span className="settings-help">
                  Pinning installs that exact version on the next check, even if it's older.
                </span>
              )}
            </div>

            <div className="settings-actions">
              <button
                className="top-btn"
                onClick={checkNow}
                disabled={status.kind === "checking" || status.kind === "downloading"}
              >
                Check for updates now
              </button>
            </div>

            {statusLine && <div className="settings-status-area">{statusLine}</div>}
          </section>
        </div>
      </div>
    </div>
  );
}
