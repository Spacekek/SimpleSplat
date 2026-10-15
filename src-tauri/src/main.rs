// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager};

/// A bundled tool (resources/tools/bin) if present, otherwise the bare name for a PATH lookup.
fn tool(app: &AppHandle, name: &str) -> PathBuf {
    app.path()
        .resource_dir()
        .map(|dir| dir.join("tools/bin").join(name))
        .ok()
        .filter(|path| path.exists())
        .unwrap_or_else(|| name.into())
}

/// First output line of each tool, to show the bundle is complete and runnable.
#[tauri::command]
fn tool_versions(app: AppHandle) -> Vec<String> {
    [("ffmpeg", "-version"), ("colmap", "help"), ("brush-cli", "--version")]
        .into_iter()
        .map(|(name, arg)| match Command::new(tool(&app, name)).arg(arg).output() {
            Ok(out) => {
                let text = String::from_utf8_lossy(if out.stdout.is_empty() { &out.stderr } else { &out.stdout }).into_owned();
                format!("{name}: {}", text.lines().next().unwrap_or("(no output)"))
            }
            Err(err) => format!("{name}: not found ({err})"),
        })
        .collect()
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![tool_versions])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
