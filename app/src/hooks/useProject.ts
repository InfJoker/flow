import { useCallback, useEffect, useState } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface Project {
  path: string;
  name: string;
  lastOpenedAt: string;
}

export interface ProjectStore {
  active?: string;
  recent: Project[];
}

/**
 * The folder a run reads and writes.
 *
 * This is a safety-relevant choice, not a convenience: a run's Claude edits
 * files and executes shell commands inside it. Nothing is assumed on a first
 * launch — with no project open the app asks rather than guessing at a default.
 */
export function useProject() {
  const [store, setStore] = useState<ProjectStore>({ recent: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) {
      setLoading(false);
      return;
    }
    invoke<ProjectStore>("load_projects")
      .then(setStore)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const activePath = store.active ?? null;
  const active = store.recent.find((p) => p.path === activePath) ?? null;

  const openPath = useCallback(async (path: string) => {
    setError(null);
    try {
      setStore(await invoke<ProjectStore>("open_project", { path }));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  /** Native folder picker. Resolves to false when the user cancels. */
  const chooseFolder = useCallback(async (): Promise<boolean> => {
    if (!isTauri()) return false;
    const picked = await open({ directory: true, multiple: false, title: "Open project folder" });
    if (typeof picked !== "string") return false;
    await openPath(picked);
    return true;
  }, [openPath]);

  const forget = useCallback(async (path: string) => {
    try {
      setStore(await invoke<ProjectStore>("remove_recent_project", { path }));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  return { store, active, activePath, recent: store.recent, loading, error, chooseFolder, openPath, forget };
}
