// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pipeline;

use std::path::PathBuf;
use std::process::{Command, ExitCode};

const USAGE: &str =
    "usage: simplesplat <video | photo folder> [--detail low|medium|high] [--out DIR]";

/// Bundled tools folder (resources/tools/bin), or None to use PATH.
struct Tools(Option<PathBuf>);

/// First output line of each tool, to show the bundle is complete and runnable.
#[tauri::command]
fn tool_versions(tools: tauri::State<Tools>) -> Vec<String> {
    [
        ("ffmpeg", "-version"),
        ("colmap", "help"),
        ("brush-cli", "--version"),
    ]
    .into_iter()
    .map(|(name, arg)| {
        match Command::new(pipeline::tool(tools.0.as_deref(), name))
            .arg(arg)
            .output()
        {
            Ok(out) => {
                let text = String::from_utf8_lossy(if out.stdout.is_empty() {
                    &out.stderr
                } else {
                    &out.stdout
                })
                .into_owned();
                format!("{name}: {}", text.lines().next().unwrap_or("(no output)"))
            }
            Err(err) => format!("{name}: not found ({err})"),
        }
    })
    .collect()
}

/// Headless run: `simplesplat <input> [--detail ...] [--out ...]`.
fn cli(args: Vec<String>, tools: Option<PathBuf>) -> ExitCode {
    let (mut input, mut detail, mut out) = (None, "medium".to_string(), None);
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--detail" => detail = args.next().unwrap_or_default(),
            "--out" => out = args.next().map(PathBuf::from),
            "-h" | "--help" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            _ if input.is_none() && !arg.starts_with('-') => input = Some(PathBuf::from(arg)),
            _ => input = None,
        }
    }
    let (Some(input), Some(settings)) = (input, pipeline::Settings::detail(&detail)) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    match pipeline::run(
        &input,
        out.as_deref(),
        &settings,
        tools.as_deref(),
        &mut |line| println!("{line}"),
    ) {
        Ok(scene) => {
            println!("Scene: {}", scene.display());
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("{err}");
            ExitCode::FAILURE
        }
    }
}

fn main() -> ExitCode {
    let context = tauri::generate_context!();
    let tools =
        tauri::utils::platform::resource_dir(context.package_info(), &tauri::Env::default())
            .ok()
            .map(|dir| dir.join("tools/bin"));

    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() {
        return cli(args, tools);
    }
    tauri::Builder::default()
        .manage(Tools(tools))
        .invoke_handler(tauri::generate_handler![tool_versions])
        .run(context)
        .expect("error while running tauri application");
    ExitCode::SUCCESS
}
