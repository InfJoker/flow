use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionInfo {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub port: u32,
    #[serde(rename = "workflowId")]
    pub workflow_id: String,
    #[serde(rename = "workflowName")]
    pub workflow_name: String,
    pub pid: u32,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    /// Which backend drives Claude. Absent in session files written by older
    /// channel servers, so it stays optional rather than failing the parse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    /// Directory the workflow's actions run in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Any field this binary does not know about.
    ///
    /// `update_session_workflow` rewrites the whole file, so without this an app
    /// older than the channel server that wrote the file would silently strip the
    /// fields it does not model. Capturing them keeps rewrites lossless.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[tauri::command]
pub fn update_session_workflow(
    session_id: String,
    workflow_id: String,
    workflow_name: String,
) -> Result<(), String> {
    let dir = sessions_dir().ok_or("No sessions dir")?;
    let path = dir.join(format!("{}.json", session_id));

    if !path.exists() {
        return Err("Session file not found".to_string());
    }

    let text = fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;
    let mut info: SessionInfo =
        serde_json::from_str(&text).map_err(|e| format!("Parse error: {}", e))?;

    info.workflow_id = workflow_id;
    info.workflow_name = workflow_name;

    let json =
        serde_json::to_string_pretty(&info).map_err(|e| format!("Serialize error: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Write error: {}", e))?;

    Ok(())
}

fn sessions_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".agent-flow").join("sessions"))
}

#[tauri::command]
pub fn discover_sessions() -> Vec<SessionInfo> {
    let dir = match sessions_dir() {
        Some(d) if d.exists() => d,
        _ => return Vec::new(),
    };

    let mut sessions = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return sessions,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(info) = serde_json::from_str::<SessionInfo>(&text) {
                    // Check if process is still alive
                    if is_process_alive(info.pid) {
                        sessions.push(info);
                    } else {
                        // Stale session file, clean up
                        let _ = fs::remove_file(&path);
                    }
                }
            }
        }
    }

    sessions
}

#[tauri::command]
pub fn launch_claude(
    workflow_id: String,
    workflow_name: String,
    channel_server_path: String,
) -> Result<u32, String> {
    let child = Command::new("claude")
        .args([
            "--channels",
            &format!("server:{}", channel_server_path),
        ])
        .env("AGENT_FLOW_WORKFLOW_ID", &workflow_id)
        .env("AGENT_FLOW_WORKFLOW_NAME", &workflow_name)
        .spawn()
        .map_err(|e| format!("Failed to launch claude: {}", e))?;

    Ok(child.id())
}

#[tauri::command]
pub fn kill_session(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        unsafe {
            let result = libc::kill(pid as i32, libc::SIGTERM);
            if result != 0 {
                return Err(format!("Failed to kill process {}", pid));
            }
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        Err(format!("kill_session not supported on this platform"))
    }
}

#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(not(unix))]
fn is_process_alive(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Session files written before `backend`/`cwd` existed are still on disk.
    /// If they failed to parse, `discover_sessions` would return nothing and the
    /// app could not attach to any running session.
    #[test]
    fn test_session_info_parses_without_backend_or_cwd() {
        let json = r#"{
            "sessionId": "abc",
            "port": 53740,
            "workflowId": "wf",
            "workflowName": "WF",
            "pid": 42,
            "startedAt": "2026-05-06T08:24:16.828Z"
        }"#;

        let info: SessionInfo = serde_json::from_str(json).expect("legacy file should parse");
        assert_eq!(info.session_id, "abc");
        assert_eq!(info.backend, None);
        assert_eq!(info.cwd, None);
    }

    #[test]
    fn test_session_info_parses_backend_and_cwd() {
        let json = r#"{
            "sessionId": "abc",
            "port": 53740,
            "workflowId": "wf",
            "workflowName": "WF",
            "pid": 42,
            "startedAt": "2026-05-06T08:24:16.828Z",
            "backend": "sdk",
            "cwd": "/Users/george/agent-flow"
        }"#;

        let info: SessionInfo = serde_json::from_str(json).expect("new file should parse");
        assert_eq!(info.backend.as_deref(), Some("sdk"));
        assert_eq!(info.cwd.as_deref(), Some("/Users/george/agent-flow"));
    }

    /// The optional fields are skipped when absent, so rewriting a legacy file
    /// (as `update_session_workflow` does) must not inject nulls that an older
    /// channel server would then read back.
    #[test]
    fn test_absent_optional_fields_are_omitted_on_write() {
        let info = SessionInfo {
            session_id: "abc".into(),
            port: 1,
            workflow_id: "wf".into(),
            workflow_name: "WF".into(),
            pid: 1,
            started_at: "2026-05-06T08:24:16.828Z".into(),
            backend: None,
            cwd: None,
            extra: Default::default(),
        };

        let json = serde_json::to_string(&info).unwrap();
        assert!(!json.contains("backend"), "got: {json}");
        assert!(!json.contains("cwd"), "got: {json}");
    }

    /// A newer channel server may write fields this binary does not model.
    /// Rewriting the file (as update_session_workflow does) must not drop them.
    #[test]
    fn test_unknown_fields_survive_a_rewrite() {
        let json = r#"{
            "sessionId": "abc",
            "port": 1,
            "workflowId": "wf",
            "workflowName": "WF",
            "pid": 1,
            "startedAt": "2026-05-06T08:24:16.828Z",
            "claudeSessionId": "claude-xyz",
            "somethingNewer": {"nested": true}
        }"#;

        let info: SessionInfo = serde_json::from_str(json).unwrap();
        let rewritten = serde_json::to_string(&info).unwrap();

        assert!(rewritten.contains("somethingNewer"), "got: {rewritten}");
        assert!(rewritten.contains("nested"), "got: {rewritten}");
        assert!(rewritten.contains("claude-xyz"), "got: {rewritten}");
    }
}
