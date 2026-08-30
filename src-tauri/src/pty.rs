use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

static NEXT_PTY_ID: AtomicUsize = AtomicUsize::new(1);

#[derive(Clone, Serialize, Deserialize)]
pub struct PtyOutputPayload {
    pub id: String,
    pub data: String,
}

pub struct PtySession {
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    /// Kept so the shell can be signalled and reaped. Dropping the master
    /// closes the pty and usually sends SIGHUP, but "usually" leaves a stray
    /// shell holding the user's project open, and an unreaped child is a
    /// zombie for as long as the app runs.
    pub child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

#[derive(Default)]
pub struct PtyState {
    pub sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

#[tauri::command]
pub fn spawn_pty(
    app: AppHandle,
    state: State<PtyState>,
    rows: Option<u16>,
    cols: Option<u16>,
    shell: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let rows_val = rows.unwrap_or(24);
    let cols_val = cols.unwrap_or(80);

    let pair = pty_system
        .openpty(PtySize {
            rows: rows_val,
            cols: cols_val,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY pair: {}", e))?;

    let default_shell = if cfg!(target_os = "windows") {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    };

    let shell_path = shell.unwrap_or(default_shell);
    let mut cmd = CommandBuilder::new(&shell_path);

    // Pass interactive login arguments so user shell profiles (.bashrc/.zshrc) are sourced
    if !cfg!(target_os = "windows") {
        if shell_path.ends_with("bash") || shell_path.ends_with("zsh") {
            cmd.args(["-l", "-i"]);
        } else if shell_path.ends_with("sh") {
            cmd.args(["-l"]);
        }
    }

    // 1. Inherit all environment variables from parent process
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }

    // 2. Ensure terminal capabilities
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    // 3. Augment PATH so node, npm, cargo and aura are found even when the app
    //    was launched from a desktop launcher, which inherits almost nothing.
    //
    //    Order matters and is deliberate: the inherited PATH goes FIRST. A
    //    version manager (nvm, volta, asdf, mise) puts the selected toolchain
    //    early in PATH, and prepending /usr/bin ahead of it silently runs the
    //    system node instead of the project's — the kind of bug that shows up
    //    much later as an inexplicable version mismatch. These entries are a
    //    fallback for what is missing, not an override of what is there.
    //
    //    The login shell below re-sources the user's profile and will usually
    //    rebuild PATH itself; this is what makes the environment sane for the
    //    shell's own startup, and for non-login shells on other platforms.
    let mut path_entries: Vec<String> = Vec::new();

    let current_path = std::env::var("PATH").unwrap_or_default();
    if !current_path.is_empty() {
        path_entries.push(current_path);
    }

    if let Ok(home) = std::env::var("HOME") {
        let home_path = std::path::PathBuf::from(&home);
        for rel in [".cargo/bin", ".local/bin", ".npm-global/bin", ".bun/bin", ".deno/bin"] {
            let dir = home_path.join(rel);
            if dir.exists() {
                path_entries.push(dir.to_string_lossy().to_string());
            }
        }
    }

    for sys in ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        path_entries.push(sys.to_string());
    }

    // De-duplicate, keeping the first occurrence so the ordering above holds.
    let mut seen = std::collections::HashSet::new();
    let full_path = path_entries
        .into_iter()
        .filter(|p| !p.is_empty() && seen.insert(p.clone()))
        .collect::<Vec<_>>()
        .join(":");
    cmd.env("PATH", full_path);

    // A bundled app is typically started with cwd at `/` (or the bundle root),
    // which is a useless and confusing place to drop the user. Fall back to the
    // home directory, and only to the process cwd if there is no home.
    let working_dir = cwd
        .map(std::path::PathBuf::from)
        .filter(|d| d.is_dir())
        .or_else(|| std::env::var("HOME").ok().map(std::path::PathBuf::from).filter(|d| d.is_dir()))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    cmd.cwd(working_dir);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell process ({}): {}", shell_path, e))?;

    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    let id = format!("pty-{}", NEXT_PTY_ID.fetch_add(1, Ordering::SeqCst));
    let session_id = id.clone();

    let session = PtySession {
        writer: Arc::new(Mutex::new(writer)),
        master: Arc::new(Mutex::new(pair.master)),
        child: Arc::new(Mutex::new(child)),
    };

    state.sessions.lock().insert(id.clone(), session);

    // Background thread to stream PTY stdout directly to Tauri webview events
    let app_clone = app.clone();
    let sid = session_id.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        let mut pty_reader = reader;
        loop {
            match pty_reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let _ = app_clone.emit(
                        "pty-stdout",
                        PtyOutputPayload {
                            id: sid.clone(),
                            data: data.clone(),
                        },
                    );
                    let _ = app_clone.emit(&format!("pty-stdout-{}", sid), data);
                }
                Err(_) => break,
            }
        }
        // The shell is gone; drop the session so the map does not accumulate
        // dead entries, and reap the child in the same step.
        if let Some(session) = app_clone.state::<PtyState>().sessions.lock().remove(&sid) {
            let _ = session.child.lock().wait();
        }
        let _ = app_clone.emit(&format!("pty-exit-{}", sid), ());
    });

    Ok(session_id)
}

#[tauri::command]
pub fn write_pty(state: State<PtyState>, id: String, data: String) -> Result<(), String> {
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("PTY session '{}' not found", id))?;

    let mut writer = session.writer.lock();
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to PTY: {}", e))?;
    writer
        .flush()
        .map_err(|e| format!("Failed to flush PTY: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn resize_pty(
    state: State<PtyState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("PTY session '{}' not found", id))?;

    let master = session.master.lock();
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn kill_pty(state: State<PtyState>, id: String) -> Result<(), String> {
    let session = { state.sessions.lock().remove(&id) };
    let Some(session) = session else { return Ok(()) };

    // Signal, then reap. Removing the session alone only drops the handles;
    // the shell and anything it started would keep running unattached.
    let mut child = session.child.lock();
    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}
