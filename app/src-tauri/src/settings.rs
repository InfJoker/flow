use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

// Keep this in sync with the fallback endpoint in `tauri.conf.json`.
// `resolve_endpoint` below builds all runtime URLs from this constant.
const GITHUB_REPO: &str = "InfJoker/flow";
const DEV_TAG: &str = "dev";
const MANIFEST_FILE: &str = "latest.json";

/// App state holding a fetched update so that `download_and_install_update`
/// installs exactly what `check_for_update` promised (no TOCTOU if the user
/// changes pinned version between the banner showing and clicking Install).
pub struct PendingUpdate(pub Mutex<Option<Update>>);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UpdateSettings {
    pub enabled: bool,
    pub channel: String,
    #[serde(rename = "pinnedVersion", skip_serializing_if = "Option::is_none")]
    pub pinned_version: Option<String>,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            channel: "dev".to_string(),
            pinned_version: None,
        }
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct UpdateMetadata {
    pub version: String,
    #[serde(rename = "currentVersion")]
    pub current_version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ReleaseInfo {
    #[serde(rename = "tagName")]
    pub tag_name: String,
    pub name: String,
    pub prerelease: bool,
    #[serde(rename = "publishedAt", skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
}

fn settings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".agent-flow").join("settings.json"))
}

fn read_settings_from(path: &Path) -> UpdateSettings {
    let Ok(text) = fs::read_to_string(path) else {
        return UpdateSettings::default();
    };
    match serde_json::from_str(&text) {
        Ok(s) => s,
        Err(e) => {
            // Don't blow away user intent silently. Log and fall back to
            // defaults so the app stays usable, but keep the broken file
            // around for inspection.
            log::warn!("Failed to parse {}: {}", path.display(), e);
            UpdateSettings::default()
        }
    }
}

fn write_settings_to(path: &Path, settings: &UpdateSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create settings dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Serialize error: {}", e))?;

    // Atomic write: write to tmp then rename, matching `workflows.rs`.
    let tmp_path = match path.file_name() {
        Some(name) => path.with_file_name(format!(".{}.tmp", name.to_string_lossy())),
        None => return Err(format!("Invalid settings path: {}", path.display())),
    };
    fs::write(&tmp_path, json).map_err(|e| format!("Write error: {}", e))?;
    fs::rename(&tmp_path, path).map_err(|e| format!("Rename error: {}", e))?;
    Ok(())
}

fn resolve_endpoint(settings: &UpdateSettings) -> String {
    let tag = match &settings.pinned_version {
        Some(v) if !v.is_empty() => v.clone(),
        _ => DEV_TAG.to_string(),
    };
    format!(
        "https://github.com/{}/releases/download/{}/{}",
        GITHUB_REPO, tag, MANIFEST_FILE
    )
}

/// Build a configured updater for the given settings. When `pinned_version`
/// is set, we install that version regardless of semver direction (supports
/// downgrade / lateral moves between dev builds).
fn build_updater(
    app: &AppHandle,
    settings: &UpdateSettings,
) -> Result<tauri_plugin_updater::Updater, String> {
    let endpoint = resolve_endpoint(settings);
    let url = Url::parse(&endpoint)
        .map_err(|e| format!("Invalid update endpoint {}: {}", endpoint, e))?;

    let mut builder = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("Updater endpoints error: {}", e))?
        .timeout(Duration::from_secs(30));

    if settings.pinned_version.is_some() {
        // Default comparator is `update.version > current`. For pinned
        // versions we want "install anything that isn't the current version."
        builder = builder.version_comparator(|current, update| update.version != current);
    }

    builder
        .build()
        .map_err(|e| format!("Updater build error: {}", e))
}

#[tauri::command]
pub fn load_update_settings() -> Result<UpdateSettings, String> {
    let path = settings_path().ok_or("Could not determine home directory")?;
    Ok(read_settings_from(&path))
}

#[tauri::command]
pub fn save_update_settings(settings: UpdateSettings) -> Result<(), String> {
    let path = settings_path().ok_or("Could not determine home directory")?;
    write_settings_to(&path, &settings)
}

#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateMetadata>, String> {
    let path = settings_path().ok_or("Could not determine home directory")?;
    let settings = read_settings_from(&path);

    let updater = build_updater(&app, &settings)?;

    match updater.check().await {
        Ok(Some(update)) => {
            let metadata = UpdateMetadata {
                version: update.version.clone(),
                current_version: update.current_version.clone(),
                body: update.body.clone(),
                date: update.date.map(|d| d.to_string()),
            };
            // Stash the resolved Update so download_and_install consumes
            // exactly what we just advertised to the user.
            *pending.0.lock().unwrap() = Some(update);
            Ok(Some(metadata))
        }
        Ok(None) => {
            *pending.0.lock().unwrap() = None;
            Ok(None)
        }
        Err(e) => Err(format!("Update check failed: {}", e)),
    }
}

#[tauri::command]
pub async fn download_and_install_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<(), String> {
    // Consume the stashed update from the last check. If it's empty (e.g.
    // Rust process was restarted between check and install), fall back to
    // re-checking so the command still works but skip the TOCTOU protection.
    let update = {
        let mut guard = pending.0.lock().unwrap();
        guard.take()
    };

    let update = match update {
        Some(u) => u,
        None => {
            let path = settings_path().ok_or("Could not determine home directory")?;
            let settings = read_settings_from(&path);
            let updater = build_updater(&app, &settings)?;
            updater
                .check()
                .await
                .map_err(|e| format!("Update check failed: {}", e))?
                .ok_or_else(|| "No update available".to_string())?
        }
    };

    let app_progress = app.clone();
    let app_finished = app.clone();
    update
        .download_and_install(
            move |chunk_length, content_length| {
                let _ = app_progress.emit(
                    "update-progress",
                    serde_json::json!({
                        "chunkLength": chunk_length,
                        "contentLength": content_length,
                    }),
                );
            },
            move || {
                let _ = app_finished.emit("update-finished", ());
            },
        )
        .await
        .map_err(|e| format!("Download/install failed: {}", e))?;

    Ok(())
}

#[derive(Debug, Deserialize)]
struct RawAsset {
    name: String,
}

#[derive(Debug, Deserialize)]
struct RawRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<RawAsset>,
}

/// List published releases that have a `latest.json` updater manifest
/// attached. Releases without a manifest are filtered out so the user
/// can't pick a tag that would 404 the updater endpoint.
#[tauri::command]
pub async fn list_github_releases() -> Result<Vec<ReleaseInfo>, String> {
    let url = format!("https://api.github.com/repos/{}/releases", GITHUB_REPO);
    let client = reqwest::Client::builder()
        .user_agent("agent-flow-updater")
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("GitHub API request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("GitHub API returned {}", response.status()));
    }

    let releases: Vec<RawRelease> = response
        .json()
        .await
        .map_err(|e| format!("GitHub API JSON error: {}", e))?;

    let infos = releases
        .into_iter()
        .filter(|r| r.assets.iter().any(|a| a.name == MANIFEST_FILE))
        .map(|r| ReleaseInfo {
            tag_name: r.tag_name,
            name: r.name.unwrap_or_default(),
            prerelease: r.prerelease,
            published_at: r.published_at,
        })
        .collect();

    Ok(infos)
}

/// Install the `PendingUpdate` state in the Tauri app. Call from `lib.rs`.
pub fn init_state<R: tauri::Runtime>(app: &tauri::App<R>) {
    app.manage(PendingUpdate(Mutex::new(None)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_settings() {
        let s = UpdateSettings::default();
        assert!(s.enabled);
        assert_eq!(s.channel, "dev");
        assert!(s.pinned_version.is_none());
    }

    #[test]
    fn test_settings_roundtrip() {
        let tmp = std::env::temp_dir().join("agent-flow-settings-test.json");
        let _ = fs::remove_file(&tmp);

        let original = UpdateSettings {
            enabled: false,
            channel: "dev".to_string(),
            pinned_version: Some("v0.1.2".to_string()),
        };

        write_settings_to(&tmp, &original).unwrap();
        let loaded = read_settings_from(&tmp);

        assert_eq!(loaded.enabled, false);
        assert_eq!(loaded.channel, "dev");
        assert_eq!(loaded.pinned_version, Some("v0.1.2".to_string()));

        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn test_settings_atomic_write_leaves_no_tmp_file() {
        let tmp = std::env::temp_dir().join("agent-flow-settings-atomic.json");
        let _ = fs::remove_file(&tmp);
        let tmp_sidecar = tmp.with_file_name(".agent-flow-settings-atomic.json.tmp");
        let _ = fs::remove_file(&tmp_sidecar);

        write_settings_to(&tmp, &UpdateSettings::default()).unwrap();
        assert!(tmp.exists());
        assert!(!tmp_sidecar.exists());

        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn test_settings_missing_file_returns_defaults() {
        let tmp = std::env::temp_dir().join("agent-flow-settings-missing.json");
        let _ = fs::remove_file(&tmp);

        let loaded = read_settings_from(&tmp);
        assert!(loaded.enabled);
        assert_eq!(loaded.channel, "dev");
        assert!(loaded.pinned_version.is_none());
    }

    #[test]
    fn test_settings_corrupt_file_falls_back_to_defaults() {
        let tmp = std::env::temp_dir().join("agent-flow-settings-corrupt.json");
        fs::write(&tmp, "{not json").unwrap();

        let loaded = read_settings_from(&tmp);
        assert!(loaded.enabled);
        assert!(loaded.pinned_version.is_none());

        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn test_resolve_endpoint_dev_channel() {
        let settings = UpdateSettings::default();
        let url = resolve_endpoint(&settings);
        assert!(url.ends_with("/releases/download/dev/latest.json"));
    }

    #[test]
    fn test_resolve_endpoint_pinned_version() {
        let settings = UpdateSettings {
            enabled: true,
            channel: "dev".to_string(),
            pinned_version: Some("v0.1.5".to_string()),
        };
        let url = resolve_endpoint(&settings);
        assert!(url.contains("/releases/download/v0.1.5/latest.json"));
    }

    #[test]
    fn test_resolve_endpoint_empty_pinned_falls_back_to_dev() {
        let settings = UpdateSettings {
            enabled: true,
            channel: "dev".to_string(),
            pinned_version: Some("".to_string()),
        };
        let url = resolve_endpoint(&settings);
        assert!(url.ends_with("/releases/download/dev/latest.json"));
    }

    #[test]
    fn test_settings_serialization_uses_camelcase() {
        let s = UpdateSettings {
            enabled: true,
            channel: "dev".to_string(),
            pinned_version: Some("v1".to_string()),
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"pinnedVersion\""));
    }

    #[test]
    fn test_raw_release_parses_with_missing_optional_fields() {
        let json = r#"[{"tag_name":"v1","assets":[{"name":"latest.json"}]}]"#;
        let releases: Vec<RawRelease> = serde_json::from_str(json).unwrap();
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].tag_name, "v1");
        assert_eq!(releases[0].name, None);
        assert_eq!(releases[0].assets.len(), 1);
    }
}
