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
