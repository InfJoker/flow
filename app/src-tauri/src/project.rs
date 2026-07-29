//! Folder-as-project: the directory a workflow run reads and writes.
//!
//! Kept in its own file (`~/.agent-flow/projects.json`) rather than added to
//! `settings.json`. That file is `UpdateSettings` serialized at the top level, so
//! new keys there would be a format change on a file older builds already parse.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// How many folders to remember. Enough to cover the handful of repos someone
/// switches between, small enough that the picker stays scannable.
const MAX_RECENT: usize = 12;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct Project {
    /// Absolute path. The identity of a project — everything else is derived.
    pub path: String,
    /// Final path segment, cached so the UI need not re-derive it every render.
    pub name: String,
    #[serde(rename = "lastOpenedAt")]
    pub last_opened_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ProjectStore {
    /// The project the app reopens on launch. `None` on a first run, which the
    /// UI shows as a "choose a folder" empty state rather than guessing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<String>,
    #[serde(default)]
    pub recent: Vec<Project>,
}

fn projects_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".agent-flow").join("projects.json"))
}

/// A corrupt or unreadable store must not brick the app — the worst case is a
/// forgotten recents list, so fall back to empty rather than surfacing an error.
fn read_store_from(path: &Path) -> ProjectStore {
    let Ok(text) = fs::read_to_string(path) else {
        return ProjectStore::default();
    };
    serde_json::from_str(&text).unwrap_or_else(|e| {
        log::warn!("Failed to parse {}: {}", path.display(), e);
        ProjectStore::default()
    })
}

/// Atomic write via tmp+rename, matching `settings.rs` and `workflows.rs`. A
/// torn projects.json would lose the recents list on the next launch.
fn write_store_to(path: &Path, store: &ProjectStore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| format!("Serialize error: {}", e))?;
    let tmp = match path.file_name() {
        Some(name) => path.with_file_name(format!(".{}.tmp", name.to_string_lossy())),
        None => return Err(format!("Invalid projects path: {}", path.display())),
    };
    fs::write(&tmp, json).map_err(|e| format!("Write error: {}", e))?;
    fs::rename(&tmp, path).map_err(|e| format!("Rename error: {}", e))?;
    Ok(())
}

/// Derive the display name from the final path segment, falling back to the
/// whole path so a root-level or unusual folder still shows something.
pub fn project_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// Insert at the front, deduplicating by path and capping the list.
///
/// Split out from `open_project` so it is testable without touching `$HOME`.
pub fn promote(store: &mut ProjectStore, project: Project) {
    store.recent.retain(|p| p.path != project.path);
    store.recent.insert(0, project.clone());
    store.recent.truncate(MAX_RECENT);
    store.active = Some(project.path);
}

#[tauri::command]
pub fn load_projects() -> Result<ProjectStore, String> {
    let path = projects_path().ok_or("Could not determine home directory")?;
    let mut store = read_store_from(&path);

    // Folders get moved, renamed, and deleted between launches. Offering one
    // that no longer exists would fail at spawn time with a confusing error, so
    // drop them here instead.
    store.recent.retain(|p| Path::new(&p.path).is_dir());
    if let Some(active) = &store.active {
        if !Path::new(active).is_dir() {
            store.active = None;
        }
    }

    Ok(store)
}

/// Open a folder as the active project, recording it in recents.
///
/// Validates before recording: a run spawned against a path that is not a
/// directory fails deep inside the channel server, where the cause is invisible.
#[tauri::command]
pub fn open_project(path: String) -> Result<ProjectStore, String> {
    let dir = PathBuf::from(&path);
    if !dir.exists() {
        return Err(format!("Folder does not exist: {}", path));
    }
    if !dir.is_dir() {
        return Err(format!("Not a folder: {}", path));
    }

    // Store the canonical path so the same folder reached via a symlink or a
    // relative path is one entry, not several. Also required for matching a
    // session's `cwd` back to its project.
    let canonical = dir.canonicalize().unwrap_or(dir);
    let canonical_str = canonical.to_string_lossy().to_string();

    let store_path = projects_path().ok_or("Could not determine home directory")?;
    let mut store = read_store_from(&store_path);

    promote(
        &mut store,
        Project {
            name: project_name(&canonical),
            path: canonical_str,
            last_opened_at: chrono::Utc::now().to_rfc3339(),
        },
    );

    write_store_to(&store_path, &store)?;
    Ok(store)
}

/// Forget a folder. Does not touch the folder itself.
#[tauri::command]
pub fn remove_recent_project(path: String) -> Result<ProjectStore, String> {
    let store_path = projects_path().ok_or("Could not determine home directory")?;
    let mut store = read_store_from(&store_path);

    store.recent.retain(|p| p.path != path);
    if store.active.as_deref() == Some(path.as_str()) {
        store.active = None;
    }

    write_store_to(&store_path, &store)?;
    Ok(store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn project(path: &str) -> Project {
        Project {
            path: path.into(),
            name: project_name(Path::new(path)),
            last_opened_at: "2026-07-27T00:00:00Z".into(),
        }
    }

    #[test]
    fn test_promote_moves_existing_project_to_front_without_duplicating() {
        let mut store = ProjectStore::default();
        promote(&mut store, project("/a"));
        promote(&mut store, project("/b"));
        promote(&mut store, project("/a"));

        assert_eq!(
            store.recent.iter().map(|p| p.path.as_str()).collect::<Vec<_>>(),
            vec!["/a", "/b"],
            "reopening a project should reorder, not append a second entry"
        );
        assert_eq!(store.active.as_deref(), Some("/a"));
    }

    #[test]
    fn test_promote_caps_the_recent_list() {
        let mut store = ProjectStore::default();
        for i in 0..(MAX_RECENT + 5) {
            promote(&mut store, project(&format!("/p{}", i)));
        }
        assert_eq!(store.recent.len(), MAX_RECENT);
        // Newest kept, oldest dropped.
        assert_eq!(store.recent[0].path, format!("/p{}", MAX_RECENT + 4));
    }

    #[test]
    fn test_project_name_is_the_final_segment() {
        assert_eq!(project_name(Path::new("/Users/george/agent-flow")), "agent-flow");
        // A trailing slash must not produce an empty name.
        assert_eq!(project_name(Path::new("/Users/george/agent-flow/")), "agent-flow");
    }

    /// A store written by a newer build, or hand-edited into nonsense, must not
    /// stop the app from starting.
    #[test]
    fn test_unparseable_store_falls_back_to_empty() {
        let dir = env::temp_dir().join("agent-flow-test-projects-parse");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("projects.json");
        fs::write(&path, "{ not json at all").unwrap();

        let store = read_store_from(&path);
        assert!(store.recent.is_empty());
        assert_eq!(store.active, None);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_store_round_trips_through_disk() {
        let dir = env::temp_dir().join("agent-flow-test-projects-roundtrip");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("projects.json");

        let mut store = ProjectStore::default();
        promote(&mut store, project("/Users/george/agent-flow"));
        write_store_to(&path, &store).unwrap();

        let read_back = read_store_from(&path);
        assert_eq!(read_back.active.as_deref(), Some("/Users/george/agent-flow"));
        assert_eq!(read_back.recent.len(), 1);
        assert_eq!(read_back.recent[0].name, "agent-flow");

        fs::remove_dir_all(&dir).ok();
    }

    /// `active` is skipped when absent, so a first-run store stays `{"recent":[]}`
    /// rather than carrying an explicit null that older parsers may reject.
    #[test]
    fn test_absent_active_is_omitted_on_write() {
        let store = ProjectStore::default();
        let json = serde_json::to_string(&store).unwrap();
        assert!(!json.contains("active"), "got: {json}");
    }
}
