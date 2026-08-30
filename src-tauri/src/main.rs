// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pty;

use pty::{kill_pty, resize_pty, spawn_pty, write_pty, PtyState};

#[tauri::command]
fn get_auth_token() -> Result<String, String> {
    // 1. Check environment variables
    if let Ok(tok) = std::env::var("AURA_SERVER_TOKEN") {
        let t = tok.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }
    if let Ok(tok) = std::env::var("AURA_TOKEN") {
        let t = tok.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }

    // 2. Check ~/.aura/active_token or $AURA_HOME/active_token
    let home = if let Ok(custom_home) = std::env::var("AURA_HOME") {
        std::path::PathBuf::from(custom_home)
    } else if let Ok(home_dir) = std::env::var("HOME") {
        std::path::PathBuf::from(home_dir).join(".aura")
    } else {
        std::path::PathBuf::from(".aura")
    };

    let token_file = home.join("active_token");
    if token_file.exists() {
        if let Ok(contents) = std::fs::read_to_string(&token_file) {
            let tok = contents.trim().to_string();
            if !tok.is_empty() {
                return Ok(tok);
            }
        }
    }

    // 3. Check relative .aura/active_token
    let rel_token = std::path::PathBuf::from(".aura").join("active_token");
    if rel_token.exists() {
        if let Ok(contents) = std::fs::read_to_string(&rel_token) {
            let tok = contents.trim().to_string();
            if !tok.is_empty() {
                return Ok(tok);
            }
        }
    }

    Ok("".to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            write_pty,
            resize_pty,
            kill_pty,
            get_auth_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Aura Code Tauri desktop application");
}
