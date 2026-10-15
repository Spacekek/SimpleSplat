// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pipeline;

use clap::Parser;
use pipeline::{Control, Event, Settings};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;

/// Turn a video or a folder of photos into a Gaussian splat, without opening a window.
/// Run with no arguments to open the app instead.
#[derive(Parser)]
#[command(version)]
struct Cli {
    /// A video, or a folder of photos.
    input: PathBuf,
    /// More detail looks better and takes longer.
    #[arg(long, default_value = "medium", value_parser = ["low", "medium", "high"])]
    detail: String,
    /// Folder for the results [default: next to the input].
    #[arg(long, value_name = "DIR")]
    out: Option<PathBuf>,
}

struct AppState {
    /// Bundled tools folder (resources/tools/bin), or None to use PATH.
    tools: Option<PathBuf>,
    /// The running job; one at a time.
    job: Mutex<Option<Arc<Control>>>,
}

/// What the UI asks for: a Detail preset plus optional advanced overrides.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    input: PathBuf,
    detail: String,
    out_dir: Option<PathBuf>,
    frames: Option<u32>,
    steps: Option<u32>,
    max_size: Option<u32>,
    export_every: Option<u32>,
    single_camera: Option<bool>,
    incremental_mapper: Option<bool>,
    keep_intermediates: Option<bool>,
}

#[tauri::command]
fn start(app: AppHandle, state: State<AppState>, request: Request) -> Result<(), String> {
    let mut s = Settings::detail(&request.detail).ok_or("Unknown Detail setting.")?;
    s.frames = request.frames.unwrap_or(s.frames);
    s.steps = request.steps.unwrap_or(s.steps);
    s.max_size = request.max_size.unwrap_or(s.max_size);
    s.export_every = request.export_every;
    s.single_camera = request.single_camera;
    s.incremental_mapper = request.incremental_mapper.unwrap_or(s.incremental_mapper);
    s.keep_intermediates = request.keep_intermediates.unwrap_or(s.keep_intermediates);

    let mut job = state.job.lock().unwrap();
    if job.is_some() {
        return Err("A splat is already being made.".into());
    }
    let control = Arc::new(Control::default());
    *job = Some(control.clone());
    let tools = state.tools.clone();
    std::thread::spawn(move || {
        let result = pipeline::run(
            &request.input,
            request.out_dir.as_deref(),
            &s,
            tools.as_deref(),
            &control,
            &mut |event| {
                if let Event::Project { path } = &event {
                    let _ = app.asset_protocol_scope().allow_directory(path, true);
                }
                let _ = app.emit("job", &event);
            },
        );
        app.state::<AppState>().job.lock().unwrap().take();
        // Only news for someone who isn't looking, and a Stop is never news.
        let stopped = result.as_ref().is_err_and(|err| err == pipeline::STOPPED);
        let focused = app
            .get_webview_window("main")
            .is_some_and(|w| w.is_focused().unwrap_or(false));
        if !stopped && !focused {
            let (title, body) = match &result {
                Ok(_) => ("Your splat is ready", "Open SimpleSplat to look around."),
                Err(err) => ("Making the splat failed", err.lines().next().unwrap_or("")),
            };
            let _ = app.notification().builder().title(title).body(body).show();
        }
        let _ = app.emit("job-end", &result);
    });
    Ok(())
}

#[tauri::command]
fn stop(state: State<AppState>) {
    if let Some(control) = &*state.job.lock().unwrap() {
        control.stop();
    }
}

/// Lets the webview load a .ply (and the view.json beside it) that was dropped onto the window.
#[tauri::command]
fn allow_folder(app: AppHandle, path: PathBuf) -> Result<(), String> {
    let folder = path.parent().unwrap_or(Path::new("/"));
    app.asset_protocol_scope()
        .allow_directory(folder, false)
        .map_err(|e| e.to_string())
}

/// Headless run: `simplesplat <input> [--detail ...] [--out ...]`.
fn cli(args: Cli, tools: Option<PathBuf>) -> ExitCode {
    let settings = Settings::detail(&args.detail).expect("clap checks the value");
    let mut shown = 0;
    let print = &mut |event: Event| match event {
        Event::Project { path } => println!("Project folder: {}", path.display()),
        Event::Stage { n, name, skipped } => {
            let done = if skipped { ": already done" } else { "" };
            println!("[{n}/{}] {name}{done}", pipeline::STAGES);
        }
        Event::StageDone { secs, .. } => println!("      done in {secs}s"),
        Event::Info { text } => println!("      {text}"),
        Event::Steps { iter, total } if iter / 1000 > shown / 1000 => {
            println!("      {iter}/{total} steps");
            shown = iter;
        }
        Event::Steps { .. } => {}
        Event::Preview { path } => println!("      preview: {}", path.display()),
    };
    let control = Control::default();
    match pipeline::run(
        &args.input,
        args.out.as_deref(),
        &settings,
        tools.as_deref(),
        &control,
        print,
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

    // macOS can pass -psn_0_… to the first launch of a downloaded app; it isn't a CLI argument.
    let args: Vec<String> = std::env::args()
        .filter(|arg| !arg.starts_with("-psn_"))
        .collect();
    if args.len() > 1 {
        return cli(Cli::parse_from(args), tools);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            tools,
            job: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![start, stop, allow_folder])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Closing the window mid-job asks first. (Cmd+Q on macOS goes straight to Exit; catching
            // it would take a custom app menu.)
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } if app.state::<AppState>().job.lock().unwrap().is_some() => {
                api.prevent_close();
                let handle = app.clone();
                let mut ask = app
                    .dialog()
                    .message(
                        "Finished steps are kept and skipped next time, but training starts over.",
                    )
                    .title("Quit While Making a Splat?")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Quit".into(),
                        "Keep Going".into(),
                    ));
                if let Some(window) = app.get_webview_window(&label) {
                    ask = ask.parent(&window);
                }
                ask.show(move |quit| {
                    if quit {
                        handle.exit(0);
                    }
                });
            }
            // Tools are separate processes and would outlive the app.
            RunEvent::Exit => {
                if let Some(control) = &*app.state::<AppState>().job.lock().unwrap() {
                    control.stop();
                }
            }
            _ => {}
        });
    ExitCode::SUCCESS
}
