//! Spawning the channel server from the app, so a run needs no terminal.
//!
//! Two requirements here were established by experiment, not from documentation,
//! and both are silent failures if got wrong:
//!
//! 1. **`USER` must reach the child.** `claude` reads its stored login from the
//!    macOS Keychain and that lookup needs `USER`; without it every turn fails
//!    with "Not logged in · Please run /login". `LOGNAME` and `SHELL` do not
//!    substitute. So the child inherits this process's environment and we only
//!    *add* variables — never `env_clear()`.
//!
//! 2. **`node` must be an absolute path.** A Finder-launched `.app` gets
//!    `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, which contains no Homebrew, nvm, fnm
//!    or volta directory, so bare `node` is ENOENT for most users.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::process::SessionInfo;

/// How long to wait for the spawned server to publish its session file. Node
/// cold-start plus an HTTP listen is well under a second in practice; the margin
/// covers a loaded machine.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Absolute `node` locations to try before falling back to a login shell.
/// Ordered by how common they are on a developer Mac, then Linux.
const NODE_CANDIDATES: &[&str] = &[
    "/opt/homebrew/bin/node", // Apple Silicon Homebrew
    "/usr/local/bin/node",    // Intel Homebrew, and many Linux installs
    "/usr/bin/node",
    "/snap/bin/node",
];

/// Servers this app started, so they can be reaped when it quits.
///
/// A spawned child is reparented to init if we exit without killing it, and it
/// keeps holding a port and a session file. That is not hypothetical: ten
/// orphaned servers were found on the development machine, seven of them a day
/// old.
fn spawned() -> &'static Mutex<Vec<u32>> {
    static SPAWNED: OnceLock<Mutex<Vec<u32>>> = OnceLock::new();
    SPAWNED.get_or_init(|| Mutex::new(Vec::new()))
}

/// Locate a usable `node`, remembering the answer for the process lifetime.
///
/// Tries fixed paths first because it is instant, then a login shell, which is
/// the only way to see a version manager's shim (nvm exports a shell function,
/// not a binary on the default PATH).
pub fn resolve_node() -> Result<PathBuf, String> {
    static RESOLVED: OnceLock<Option<PathBuf>> = OnceLock::new();

    let found = RESOLVED.get_or_init(|| {
        for candidate in NODE_CANDIDATES {
            let p = Path::new(candidate);
            if p.is_file() {
                return Some(p.to_path_buf());
            }
        }

        // `-l` so profile files run; a bare `-c` would see the same bare PATH we
        // already know is insufficient.
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let out = Command::new(&shell)
            .args(["-lc", "command -v node"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!path.is_empty() && Path::new(&path).is_file()).then(|| PathBuf::from(path))
    });

    found.clone().ok_or_else(|| {
        "Could not find Node.js. Agent Flow runs its channel server with Node, and a \
         desktop app does not inherit your shell's PATH. Install Node 18+ (for example \
         `brew install node`) and reopen Agent Flow."
            .to_string()
    })
}

/// Find `channel-server/dist/index.js`.
///
/// Checked in order: an explicit override, then the bundled copy in a shipped
/// `.app`, then the repo layout so `tauri dev` works without configuration.
pub fn resolve_channel_server(
    override_path: Option<&str>,
    resource_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    resolve_channel_server_from(override_path, resource_dir, std::env::current_exe().ok().as_deref())
}

/// The search itself, with every environment lookup passed in.
///
/// Split out so tests can drive the dev fallback with a controlled executable
/// path — the real `current_exe()` sits inside this repo, so a test asserting
/// "nothing found" would otherwise discover the actual checked-out server.
fn resolve_channel_server_from(
    override_path: Option<&str>,
    resource_dir: Option<&Path>,
    exe: Option<&Path>,
) -> Result<PathBuf, String> {
    let mut tried: Vec<String> = Vec::new();

    if let Some(explicit) = override_path.filter(|s| !s.is_empty()) {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Ok(p);
        }
        tried.push(explicit.to_string());
    }

    if let Some(dir) = resource_dir {
        let p = dir.join("channel-server").join("dist").join("index.js");
        if p.is_file() {
            return Ok(p);
        }
        tried.push(p.to_string_lossy().to_string());
    }

    // Development: the binary lives in app/src-tauri/target/<profile>/, so the
    // repo root is a few levels up. Walk ancestors rather than hardcoding depth,
    // which differs between debug, release and `tauri dev`.
    if let Some(exe) = exe {
        for ancestor in exe.ancestors().take(8) {
            let p = ancestor
                .join("channel-server")
                .join("dist")
                .join("index.js");
            if p.is_file() {
                return Ok(p);
            }
        }
    }

    Err(format!(
        "Could not find the channel server. Build it with `cd channel-server && npm install && \
         npm run build`.{}",
        if tried.is_empty() {
            String::new()
        } else {
            format!(" Looked in: {}", tried.join(", "))
        }
    ))
}

fn sessions_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".agent-flow").join("sessions"))
}

fn logs_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".agent-flow").join("logs"))
}

/// Find the session file the spawned server wrote, identified by its pid.
///
/// Matching on pid rather than "newest file" matters: two runs started close
/// together would otherwise each attach to whichever file landed last.
fn find_session_for_pid(pid: u32) -> Option<SessionInfo> {
    let dir = sessions_dir()?;
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(info) = serde_json::from_str::<SessionInfo>(&text) {
                    if info.pid == pid {
                        return Some(info);
                    }
                }
            }
        }
    }
    None
}

/// Last few lines of the server log, for reporting a startup failure with the
/// actual cause instead of a bare timeout.
fn log_tail(path: &Path, lines: usize) -> String {
    let mut buf = String::new();
    if let Ok(f) = File::open(path) {
        // Bounded: a failing server can produce a lot of output.
        let _ = f.take(64 * 1024).read_to_string(&mut buf);
    }
    let collected: Vec<&str> = buf.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = collected.len().saturating_sub(lines);
    collected[start..].join("\n")
}

/// Start a channel server for a project folder and wait until it is discoverable.
///
/// Returns only once the server has published its session file, so the caller can
/// connect immediately rather than polling for a session that may never appear.
///
/// `async` and dispatched to the blocking pool on purpose: Tauri runs synchronous
/// commands on the main thread, and this one sleeps in a poll loop for up to
/// `STARTUP_TIMEOUT`, which would freeze the window for that whole time.
#[tauri::command]
pub async fn start_session(
    project: String,
    workflow_id: String,
    workflow_name: String,
    model: Option<String>,
    permission_mode: Option<String>,
    channel_server_path: Option<String>,
    app: tauri::AppHandle,
) -> Result<SessionInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        start_session_blocking(
            project,
            workflow_id,
            workflow_name,
            model,
            permission_mode,
            channel_server_path,
            app,
        )
    })
    .await
    .map_err(|e| format!("Failed to start the launcher task: {}", e))?
}

fn start_session_blocking(
    project: String,
    workflow_id: String,
    workflow_name: String,
    model: Option<String>,
    permission_mode: Option<String>,
    channel_server_path: Option<String>,
    app: tauri::AppHandle,
) -> Result<SessionInfo, String> {
    let project_dir = PathBuf::from(&project);
    if !project_dir.is_dir() {
        return Err(format!("Project folder does not exist: {}", project));
    }

    let node = resolve_node()?;
    let resource_dir = {
        use tauri::Manager;
        app.path().resource_dir().ok()
    };
    let server = resolve_channel_server(channel_server_path.as_deref(), resource_dir.as_deref())?;

    let logs = logs_dir().ok_or("Could not determine home directory")?;
    fs::create_dir_all(&logs).map_err(|e| format!("Could not create log dir: {}", e))?;
    let log_path = logs.join(format!(
        "session-{}.log",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%3f")
    ));
    let log_file =
        File::create(&log_path).map_err(|e| format!("Could not create log file: {}", e))?;
    let log_file_err = log_file
        .try_clone()
        .map_err(|e| format!("Could not open log file: {}", e))?;

    // NOTE: no env_clear(). The child needs USER to reach the Keychain, and
    // inheriting is how it gets there. See the module comment.
    let mut cmd = Command::new(&node);
    cmd.arg(&server)
        .current_dir(&project_dir)
        .env("AGENT_FLOW_BACKEND", "sdk")
        .env("AGENT_FLOW_CWD", &project)
        .env("AGENT_FLOW_WORKFLOW_ID", &workflow_id)
        .env("AGENT_FLOW_WORKFLOW_NAME", &workflow_name)
        // The server speaks MCP on stdout only under the channel backend; here it
        // is unused. stdin must not be a terminal, or Node may block on it.
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err));

    if let Some(m) = model.as_deref().filter(|s| !s.is_empty()) {
        cmd.env("AGENT_FLOW_MODEL", m);
    }
    if let Some(p) = permission_mode.as_deref().filter(|s| !s.is_empty()) {
        cmd.env("AGENT_FLOW_PERMISSION_MODE", p);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start the channel server with {:?}: {}", node, e))?;
    let pid = child.id();
    spawned().lock().map(|mut v| v.push(pid)).ok();

    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        if let Some(info) = find_session_for_pid(pid) {
            return Ok(info);
        }

        // A server that died on startup will never publish a session file, so
        // stop waiting the moment the process is gone and report why.
        if !crate::process::is_process_alive(pid) {
            // It is already gone; keeping it on the reap list risks signalling
            // whatever process the OS next gives this pid to.
            forget_spawned(pid);
            let tail = log_tail(&log_path, 12);
            return Err(format!(
                "The channel server exited during startup.{}",
                if tail.is_empty() {
                    format!(" See {}", log_path.display())
                } else {
                    format!("\n\n{}", tail)
                }
            ));
        }

        if Instant::now() >= deadline {
            let _ = kill_pid(pid);
            forget_spawned(pid);
            return Err(format!(
                "The channel server did not become ready within {}s. See {}",
                STARTUP_TIMEOUT.as_secs(),
                log_path.display()
            ));
        }

        std::thread::sleep(POLL_INTERVAL);
    }
}

fn kill_pid(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        unsafe {
            if libc::kill(pid as i32, libc::SIGTERM) != 0 {
                return Err(format!("Failed to signal process {}", pid));
            }
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        Err("Not supported on this platform".to_string())
    }
}

/// Stop every server this app started. Called on app exit.
///
/// Best-effort by design: a process that already exited, or that we cannot
/// signal, must not block shutdown.
pub fn reap_spawned_sessions() {
    let Ok(mut pids) = spawned().lock() else {
        return;
    };
    for pid in pids.drain(..) {
        if crate::process::is_process_alive(pid) {
            let _ = kill_pid(pid);
        }
    }
}

/// Forget a server we deliberately stopped, so exit-time reaping does not signal
/// a pid the OS may since have reused.
pub fn forget_spawned(pid: u32) {
    if let Ok(mut pids) = spawned().lock() {
        pids.retain(|p| *p != pid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn test_resolve_channel_server_prefers_an_explicit_override() {
        let dir = env::temp_dir().join("agent-flow-test-resolve-override");
        fs::create_dir_all(&dir).unwrap();
        let explicit = dir.join("index.js");
        fs::write(&explicit, "// server").unwrap();

        let found = resolve_channel_server_from(Some(explicit.to_str().unwrap()), None, None)
            .expect("should resolve");
        assert_eq!(found, explicit);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_resolve_channel_server_finds_the_bundled_resource() {
        let dir = env::temp_dir().join("agent-flow-test-resolve-resource");
        let dist = dir.join("channel-server").join("dist");
        fs::create_dir_all(&dist).unwrap();
        let index = dist.join("index.js");
        fs::write(&index, "// server").unwrap();

        let found = resolve_channel_server_from(None, Some(&dir), None).expect("should resolve");
        assert_eq!(found, index);

        fs::remove_dir_all(&dir).ok();
    }

    /// The `tauri dev` path: the binary sits under `target/<profile>/`, so the
    /// repo root — and the built server — is several ancestors up.
    #[test]
    fn test_resolve_channel_server_walks_up_to_the_repo_in_dev() {
        let root = env::temp_dir().join("agent-flow-test-resolve-dev");
        let dist = root.join("channel-server").join("dist");
        fs::create_dir_all(&dist).unwrap();
        fs::write(dist.join("index.js"), "// server").unwrap();

        let exe = root
            .join("app")
            .join("src-tauri")
            .join("target")
            .join("debug")
            .join("agent-flow");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();

        let found = resolve_channel_server_from(None, None, Some(&exe))
            .expect("should find the server by walking up from the executable");
        assert_eq!(found, dist.join("index.js"));

        fs::remove_dir_all(&root).ok();
    }

    /// A missing build is the single most likely first-run failure, so the error
    /// has to say how to fix it rather than just reporting a missing path.
    #[test]
    fn test_resolve_channel_server_error_explains_how_to_build() {
        let err = resolve_channel_server_from(Some("/nonexistent/index.js"), None, None)
            .expect_err("should not resolve");
        assert!(err.contains("npm run build"), "got: {err}");
        assert!(err.contains("/nonexistent/index.js"), "got: {err}");
    }

    /// An override that does not exist must fall through to the other
    /// strategies, not abort the search.
    #[test]
    fn test_missing_override_falls_through_to_resource_dir() {
        let dir = env::temp_dir().join("agent-flow-test-resolve-fallthrough");
        let dist = dir.join("channel-server").join("dist");
        fs::create_dir_all(&dist).unwrap();
        fs::write(dist.join("index.js"), "// server").unwrap();

        let found = resolve_channel_server_from(Some("/nope/index.js"), Some(&dir), None)
            .expect("should fall through to the resource dir");
        assert_eq!(found, dist.join("index.js"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_log_tail_returns_the_last_lines_and_skips_blanks() {
        let dir = env::temp_dir().join("agent-flow-test-log-tail");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.log");
        fs::write(&path, "one\n\ntwo\nthree\n\n").unwrap();

        assert_eq!(log_tail(&path, 2), "two\nthree");
        assert_eq!(log_tail(&path, 10), "one\ntwo\nthree");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_forget_spawned_removes_only_the_named_pid() {
        spawned().lock().unwrap().clear();
        spawned().lock().unwrap().extend([111, 222, 333]);

        forget_spawned(222);

        assert_eq!(*spawned().lock().unwrap(), vec![111, 333]);
        spawned().lock().unwrap().clear();
    }
}
