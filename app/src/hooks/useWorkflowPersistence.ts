import { useState, useEffect, useCallback, useRef } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import type { Workflow, WorkflowSummary } from "../types";

async function invokeCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    return invoke(cmd, args);
  }
  throw new Error("Not running in Tauri");
}

export function useWorkflowPersistence(workflow: Workflow | null, onLoad: (w: Workflow) => void) {
  const [workflowList, setWorkflowList] = useState<WorkflowSummary[]>([]);
  const inTauri = isTauri();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>("");

  const refreshList = useCallback(async () => {
    if (!inTauri) return;
    try {
      const list = await invokeCommand<WorkflowSummary[]>("list_workflows");
      setWorkflowList(list);
    } catch {
      // ignore
    }
  }, [inTauri]);

  const initialLoadDone = useRef(false);

  useEffect(() => {
    if (!inTauri || initialLoadDone.current) return;
    initialLoadDone.current = true;

    // Load the most recently saved workflow on startup
    (async () => {
      try {
        const list = await invokeCommand<WorkflowSummary[]>("list_workflows");
        setWorkflowList(list);
        if (list.length > 0) {
          const w = await invokeCommand<Workflow>("load_workflow", { id: list[0].id });
          onLoad(w);
        }
      } catch {
        // ignore
      }
    })();
  }, [inTauri, onLoad]);

  // Auto-save with debounce
  useEffect(() => {
    if (!inTauri || !workflow) return;

    const json = JSON.stringify(workflow);
    if (json === lastSavedRef.current) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      try {
        await invokeCommand("save_workflow", { workflow });
        lastSavedRef.current = json;
        refreshList();
      } catch (e) {
        console.error("Auto-save failed:", e);
      }
    }, 500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [workflow, inTauri, refreshList]);

  const load = useCallback(async (id: string) => {
    try {
      const w = await invokeCommand<Workflow>("load_workflow", { id });
      onLoad(w);
    } catch (e) {
      console.error("Load failed:", e);
    }
  }, [onLoad]);

  const save = useCallback(async () => {
    if (!workflow) return;
    try {
      await invokeCommand("save_workflow", { workflow });
      lastSavedRef.current = JSON.stringify(workflow);
      refreshList();
    } catch (e) {
      console.error("Save failed:", e);
    }
  }, [workflow, refreshList]);

  const remove = useCallback(async (id: string) => {
    try {
      await invokeCommand("delete_workflow", { id });
      refreshList();
    } catch (e) {
      console.error("Delete failed:", e);
    }
  }, [refreshList]);

  return { workflowList, load, save, remove, isTauri: inTauri, refreshList };
}
