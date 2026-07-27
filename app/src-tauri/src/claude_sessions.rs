//! Reading Claude Code's own session transcripts.
//!
//! A workflow run driven by the SDK backend *is* an ordinary Claude Code session:
//! it writes `~/.claude/projects/<mangled-cwd>/<session-id>.jsonl` exactly like a
//! terminal session does, and `claude --resume <session-id>` picks it back up with
//! full context. Surfacing those files lets the app show a project's Claude Code
//! history alongside its live Agent Flow sessions.
//!
//! Read-only. Nothing here ever writes to `~/.claude`.

use serde::Serialize;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

/// Transcripts routinely reach tens of megabytes, and the app only needs the
/// header fields. Read a bounded prefix instead of the whole file.
///
/// Generous because the opening entries can include a large `deferred_tools`
/// attachment blob before the first real user message.
const HEAD_BYTES: u64 = 256 * 1024;

/// Cap the number of transcripts inspected per project so a folder with hundreds
/// of sessions cannot stall the UI. Newest first, so the cut falls on old ones.
const MAX_SESSIONS: usize = 50;

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct ClaudeSession {
    /// The id to hand to `claude --resume`.
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// First user message, truncated — what the session was about.
    pub title: String,
    /// Directory recorded inside the transcript. Authoritative, unlike the
    /// directory name (see `mangle_path`).
    pub cwd: String,
    #[serde(rename = "gitBranch", skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    #[serde(rename = "startedAt", skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// File mtime — when the session was last active.
    #[serde(rename = "modifiedAt")]
    pub modified_at: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

/// Claude Code's directory naming: every character that is not alphanumeric
/// becomes `-`.
///
/// Verified against every directory present on this machine, including a path
/// under `/private/tmp` and one containing `.claude`.
///
/// **This is lossy** — `/a/b` and `/a-b` both mangle to `-a-b`. So the name alone
/// is a lookup hint, never proof: `list_sessions` confirms each transcript really
/// belongs to the folder by checking the `cwd` recorded inside it.
pub fn mangle_path(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

fn system_time_to_rfc3339(t: std::time::SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Utc> = t.into();
    dt.to_rfc3339()
}

/// Pull the user-visible text out of a `message.content` field, which is either a
/// plain string or an array of typed content blocks.
fn extract_text(content: &serde_json::Value) -> Option<String> {
    match content {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .and_then(|b| b.get("text").and_then(|t| t.as_str()))
            .map(str::to_string),
        _ => None,
    }
}

fn truncate_title(text: &str) -> String {
    let cleaned = text.trim().replace(['\n', '\r'], " ");
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.chars().count() <= 80 {
        return cleaned;
    }
    let head: String = cleaned.chars().take(80).collect();
    format!("{}…", head.trim_end())
}

/// Parse the bounded prefix of one transcript into a summary.
///
/// Returns `None` when the file carries no usable entry — an empty or truncated
/// transcript is not worth showing.
fn read_session(path: &Path) -> Option<ClaudeSession> {
    let session_id = path.file_stem()?.to_string_lossy().to_string();
    let meta = fs::metadata(path).ok()?;
    let modified_at = meta.modified().ok().map(system_time_to_rfc3339)?;

    let mut buf = String::new();
    File::open(path)
        .ok()?
        .take(HEAD_BYTES)
        .read_to_string(&mut buf)
        .ok()?;

    let mut cwd: Option<String> = None;
    let mut git_branch: Option<String> = None;
    let mut started_at: Option<String> = None;
    let mut title: Option<String> = None;

    for line in buf.lines() {
        // The final line of a bounded read is usually cut mid-object; skipping
        // unparseable lines handles that without special-casing.
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        if cwd.is_none() {
            cwd = entry.get("cwd").and_then(|v| v.as_str()).map(str::to_string);
        }
        if git_branch.is_none() {
            git_branch = entry
                .get("gitBranch")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string);
        }
        if started_at.is_none() {
            started_at = entry
                .get("timestamp")
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }

        if title.is_none()
            && entry.get("type").and_then(|v| v.as_str()) == Some("user")
            // Sidechain entries are subagent traffic, not what the user typed.
            && entry.get("isSidechain").and_then(|v| v.as_bool()) != Some(true)
        {
            title = entry
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(extract_text)
                .map(|t| truncate_title(&t))
                .filter(|t| !t.is_empty());
        }

        if cwd.is_some() && title.is_some() && git_branch.is_some() {
            break;
        }
    }

    Some(ClaudeSession {
        session_id,
        title: title.unwrap_or_else(|| "(no prompt recorded)".to_string()),
        cwd: cwd?,
        git_branch,
        started_at,
        modified_at,
        size_bytes: meta.len(),
    })
}

/// List the Claude Code sessions belonging to a project folder, newest first.
///
/// Returns an empty list — never an error — when the folder has no Claude Code
/// history, since "you have not used Claude Code here yet" is a normal state and
/// not a failure the user needs to act on.
#[tauri::command]
pub fn list_claude_sessions(project_path: String) -> Result<Vec<ClaudeSession>, String> {
    let Some(projects) = claude_projects_dir() else {
        return Ok(Vec::new());
    };

    // Canonicalize so a project opened through a symlink still matches the `cwd`
    // Claude recorded, which is always the resolved path.
    let canonical = Path::new(&project_path)
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| project_path.clone());

    let dir = projects.join(mangle_path(&canonical));
    if !dir.is_dir() {
        return Ok(Vec::new());
    }

    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };

    // Sort by mtime before parsing, so the MAX_SESSIONS cap keeps the newest
    // rather than whatever the filesystem happened to list first.
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|p| {
            let t = fs::metadata(&p).ok()?.modified().ok()?;
            Some((t, p))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));

    let sessions = files
        .into_iter()
        .take(MAX_SESSIONS)
        .filter_map(|(_, p)| read_session(&p))
        // The directory name is ambiguous, so confirm each transcript actually
        // belongs to this folder rather than to one that mangles identically.
        .filter(|s| s.cwd == canonical)
        .collect();

    Ok(sessions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /// Checked against the real directories present under ~/.claude/projects.
    #[test]
    fn test_mangle_matches_observed_directory_names() {
        assert_eq!(
            mangle_path("/Users/george/agent-flow"),
            "-Users-george-agent-flow"
        );
        // A dot becomes a dash too, which is why `.claude` shows up as `-claude`.
        assert_eq!(
            mangle_path("/Users/george/receipt-parser/.claude/worktrees/admiring-mayer-643363"),
            "-Users-george-receipt-parser--claude-worktrees-admiring-mayer-643363"
        );
        assert_eq!(
            mangle_path("/private/tmp/claude-501/-Users-george-agent-flow/scratchpad"),
            "-private-tmp-claude-501--Users-george-agent-flow-scratchpad"
        );
    }

    /// The transform collides, which is exactly why `list_claude_sessions`
    /// re-checks the `cwd` stored inside each transcript.
    #[test]
    fn test_mangling_is_ambiguous() {
        assert_eq!(mangle_path("/a/b"), mangle_path("/a-b"));
    }

    #[test]
    fn test_extract_text_handles_plain_string_content() {
        let v = serde_json::json!("just a string");
        assert_eq!(extract_text(&v).as_deref(), Some("just a string"));
    }

    /// The SDK backend sends content as typed blocks rather than a bare string.
    #[test]
    fn test_extract_text_handles_content_blocks() {
        let v = serde_json::json!([
            {"type": "text", "text": "Execute workflow state \"Probe\""},
        ]);
        assert_eq!(
            extract_text(&v).as_deref(),
            Some("Execute workflow state \"Probe\"")
        );
    }

    #[test]
    fn test_truncate_title_collapses_whitespace_and_caps_length() {
        assert_eq!(truncate_title("  hello\n  world  "), "hello world");
        let long = "x".repeat(200);
        let t = truncate_title(&long);
        assert!(t.chars().count() <= 81, "got {} chars", t.chars().count());
        assert!(t.ends_with('…'));
    }

    #[test]
    fn test_read_session_extracts_metadata_and_skips_a_truncated_tail() {
        let dir = env::temp_dir().join("agent-flow-test-claude-sessions");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("11111111-2222-3333-4444-555555555555.jsonl");

        // Shaped like a real transcript: a queue-operation with no cwd, the first
        // user message, then a line cut off mid-object by the byte budget.
        let content = concat!(
            r#"{"type":"queue-operation","operation":"enqueue","sessionId":"s"}"#,
            "\n",
            r#"{"type":"user","cwd":"/tmp/demo","gitBranch":"main","timestamp":"2026-07-27T12:00:00Z","message":{"role":"user","content":"Fix the failing test"}}"#,
            "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tex"#,
        );
        fs::write(&path, content).unwrap();

        let s = read_session(&path).expect("should parse");
        assert_eq!(s.session_id, "11111111-2222-3333-4444-555555555555");
        assert_eq!(s.title, "Fix the failing test");
        assert_eq!(s.cwd, "/tmp/demo");
        assert_eq!(s.git_branch.as_deref(), Some("main"));

        fs::remove_dir_all(&dir).ok();
    }

    /// Subagent traffic must not become the session's title.
    #[test]
    fn test_read_session_ignores_sidechain_entries_when_titling() {
        let dir = env::temp_dir().join("agent-flow-test-claude-sidechain");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("abc.jsonl");

        let content = concat!(
            r#"{"type":"user","isSidechain":true,"cwd":"/tmp/demo","message":{"role":"user","content":"subagent instructions"}}"#,
            "\n",
            r#"{"type":"user","isSidechain":false,"cwd":"/tmp/demo","message":{"role":"user","content":"the real prompt"}}"#,
        );
        fs::write(&path, content).unwrap();

        let s = read_session(&path).expect("should parse");
        assert_eq!(s.title, "the real prompt");

        fs::remove_dir_all(&dir).ok();
    }

    /// A folder with no Claude Code history is a normal state, not an error.
    #[test]
    fn test_listing_an_unknown_folder_returns_empty_not_error() {
        let result = list_claude_sessions("/nonexistent/folder/xyz".to_string());
        assert_eq!(result, Ok(Vec::new()));
    }
}
