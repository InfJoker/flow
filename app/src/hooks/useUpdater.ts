import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateChannel = "dev";

export interface UpdateSettings {
  enabled: boolean;
  channel: UpdateChannel;
  pinnedVersion?: string;
}

export interface UpdateMetadata {
  version: string;
  currentVersion: string;
  body?: string;
  date?: string;
}

export interface ReleaseInfo {
  tagName: string;
  name: string;
  prerelease: boolean;
  publishedAt?: string;
}

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "available"; update: UpdateMetadata }
  | { kind: "downloading"; downloaded: number; total: number }
  | { kind: "installed" }
  | { kind: "error"; message: string };

const DEFAULT_SETTINGS: UpdateSettings = {
  enabled: true,
  channel: "dev",
};

// GitHub API rate limit is 60 req/hr unauthenticated. Cache release list for
// 5 minutes so reopening the settings modal doesn't burn the quota.
const RELEASES_CACHE_TTL_MS = 5 * 60 * 1000;

async function invokeCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("Not running in Tauri");
  return invoke(cmd, args);
}

export function useUpdater() {
  const inTauri = isTauri();
  const [settings, setSettings] = useState<UpdateSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [releases, setReleases] = useState<ReleaseInfo[]>([]);
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [releasesError, setReleasesError] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  // Progress counters live in a ref so we can reset them at the start of each
  // install without chasing renders, and without leaking state across retries.
  const progressRef = useRef({ downloaded: 0, total: 0 });
  // Track startup check per "enabled session": toggling off then on triggers
  // a fresh check, but toggling while on does not spam checks.
  const startupCheckedForEnabled = useRef(false);
  const releasesCache = useRef<{ at: number; data: ReleaseInfo[] } | null>(null);

  // Load settings + current version on mount
  useEffect(() => {
    if (!inTauri) {
      setSettingsLoaded(true);
      return;
    }
    (async () => {
      try {
        const loaded = await invokeCommand<UpdateSettings>("load_update_settings");
        setSettings(loaded);
      } catch (e) {
        console.error("load_update_settings failed:", e);
      }
      try {
        const v = await getVersion();
        setCurrentVersion(v);
      } catch (e) {
        console.error("getVersion failed:", e);
      }
      setSettingsLoaded(true);
    })();
  }, [inTauri]);

  // Listen for backend progress events. The listener mutates the ref then
  // pushes a snapshot into state — that way back-to-back downloads never
  // inherit stale counters.
  useEffect(() => {
    if (!inTauri) return;
    let unlistenProgress: UnlistenFn | undefined;
    let unlistenFinished: UnlistenFn | undefined;

    (async () => {
      unlistenProgress = await listen<{ chunkLength: number; contentLength?: number }>(
        "update-progress",
        (event) => {
          const { chunkLength, contentLength } = event.payload;
          if (contentLength && progressRef.current.total === 0) {
            progressRef.current.total = contentLength;
          }
          progressRef.current.downloaded += chunkLength;
          setStatus({
            kind: "downloading",
            downloaded: progressRef.current.downloaded,
            total: progressRef.current.total,
          });
        }
      );
      unlistenFinished = await listen("update-finished", () => {
        setStatus({ kind: "installed" });
      });
    })();

    return () => {
      unlistenProgress?.();
      unlistenFinished?.();
    };
  }, [inTauri]);

  const updateSettings = useCallback(
    async (patch: Partial<UpdateSettings>) => {
      const next = { ...settings, ...patch };
      setSettings(next);
      if (!inTauri) return;
      try {
        await invokeCommand("save_update_settings", { settings: next });
      } catch (e) {
        console.error("save_update_settings failed:", e);
      }
    },
    [settings, inTauri]
  );

  const loadReleases = useCallback(
    async (force = false) => {
      if (!inTauri) return;
      const cached = releasesCache.current;
      if (!force && cached && Date.now() - cached.at < RELEASES_CACHE_TTL_MS) {
        setReleases(cached.data);
        return;
      }
      setReleasesLoading(true);
      setReleasesError(null);
      try {
        const list = await invokeCommand<ReleaseInfo[]>("list_github_releases");
        releasesCache.current = { at: Date.now(), data: list };
        setReleases(list);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("list_github_releases failed:", e);
        setReleasesError(message);
      } finally {
        setReleasesLoading(false);
      }
    },
    [inTauri]
  );

  const checkNow = useCallback(async (): Promise<UpdateMetadata | null> => {
    if (!inTauri) return null;
    setStatus({ kind: "checking" });
    try {
      const result = await invokeCommand<UpdateMetadata | null>("check_for_update");
      if (result) {
        setStatus({ kind: "available", update: result });
        return result;
      }
      setStatus({ kind: "up-to-date" });
      return null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus({ kind: "error", message });
      return null;
    }
  }, [inTauri]);

  const installUpdate = useCallback(async () => {
    if (!inTauri) return;
    // Reset counters so a retry or second install starts from zero.
    progressRef.current = { downloaded: 0, total: 0 };
    setStatus({ kind: "downloading", downloaded: 0, total: 0 });
    try {
      await invokeCommand("download_and_install_update");
      setStatus({ kind: "installed" });
      await relaunch();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus({ kind: "error", message });
    }
  }, [inTauri]);

  // Silent startup check when auto-updates are enabled. Runs once per
  // enable-edge: disabling then re-enabling during the session re-fires.
  useEffect(() => {
    if (!inTauri || !settingsLoaded) return;
    if (!settings.enabled) {
      // Release the latch so a later re-enable can trigger one more check.
      startupCheckedForEnabled.current = false;
      return;
    }
    if (startupCheckedForEnabled.current) return;
    startupCheckedForEnabled.current = true;
    checkNow().catch(() => {
      // silent — errors surface via `status` and the user can inspect in settings
    });
  }, [inTauri, settingsLoaded, settings.enabled, checkNow]);

  // Clear any banner-dismissal latch whenever the available version changes,
  // so the user is re-notified about a *new* version even after dismissing
  // an older one.
  const availableVersion = status.kind === "available" ? status.update.version : null;
  const bannerVisible = useMemo(() => {
    if (!availableVersion) return false;
    return dismissedVersion !== availableVersion;
  }, [availableVersion, dismissedVersion]);
  const dismissBanner = useCallback(() => {
    if (availableVersion) setDismissedVersion(availableVersion);
  }, [availableVersion]);

  return {
    inTauri,
    settings,
    settingsLoaded,
    updateSettings,
    currentVersion,
    releases,
    releasesLoading,
    releasesError,
    loadReleases,
    status,
    checkNow,
    installUpdate,
    bannerVisible,
    dismissBanner,
  };
}
