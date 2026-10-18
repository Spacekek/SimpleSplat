// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod gpu;
mod pipeline;

use clap::Parser;
use pipeline::{Control, Event, LEVELS, Settings};
use serde::Deserialize;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex, OnceLock};
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
    /// Found on first use: asking Spirula takes a moment.
    gpu: OnceLock<Option<gpu::Gpu>>,
}

/// What the UI asks for: a Detail preset plus optional advanced overrides.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    input: PathBuf,
    detail: String,
    out_dir: Option<PathBuf>,
    frames: Option<u32>,
    fps: Option<f32>,
    steps: Option<u32>,
    max_size: Option<u32>,
    export_every: Option<u32>,
    single_camera: Option<bool>,
    sfm_quality: Option<String>,
    max_splats: Option<u32>,
    floater_suppression: Option<String>,
    ignore_moving: Option<String>,
    exposure_correction: Option<bool>,
    keep_intermediates: Option<bool>,
}

/// The settings a request asks for.
fn settings(request: &Request) -> Result<Settings, String> {
    let mut s = Settings::detail(&request.detail).ok_or("Unknown Detail setting")?;
    s.frames = request.frames.unwrap_or(s.frames);
    s.fps = request.fps.unwrap_or(s.fps);
    s.steps = request.steps.unwrap_or(s.steps);
    s.max_size = request.max_size.unwrap_or(s.max_size);
    s.export_every = request.export_every;
    s.single_camera = request.single_camera;
    s.max_splats = request.max_splats.unwrap_or(s.max_splats);
    // Passed on to Spirula as arguments, so only its own values get through.
    let level = |value: Option<&str>, default| match value {
        None => Ok(default),
        Some(v) => LEVELS
            .into_iter()
            .find(|l| *l == v)
            .ok_or(format!("Unknown setting: {v}")),
    };
    s.floater_suppression = level(
        request.floater_suppression.as_deref(),
        s.floater_suppression,
    )?;
    s.sfm_quality = match request.sfm_quality.as_deref() {
        None => s.sfm_quality,
        Some(q) => ["low", "medium", "high"]
            .into_iter()
            .find(|l| *l == q)
            .ok_or(format!("Unknown setting: {q}"))?,
    };
    s.ignore_moving = level(request.ignore_moving.as_deref(), s.ignore_moving)?;
    s.exposure_correction = request.exposure_correction.unwrap_or(s.exposure_correction);
    s.keep_intermediates = request.keep_intermediates.unwrap_or(s.keep_intermediates);
    Ok(s)
}

/// The GPU, and the memory a run with `request` would need on it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Fit {
    gpu: Option<gpu::Gpu>,
    need: String,
    warning: Option<String>,
}

#[tauri::command]
async fn estimate(state: State<'_, AppState>, request: Request) -> Result<Fit, String> {
    let s = settings(&request)?;
    let found = state
        .gpu
        .get_or_init(|| gpu::detect(state.tools.as_deref()))
        .clone();
    Ok(Fit {
        need: gpu::gb(gpu::need(&s).0),
        warning: found.as_ref().and_then(|g| gpu::warning(&s, g)),
        gpu: found,
    })
}

/// Each Detail preset's settings, Low to High: the defaults the UI shows.
#[tauri::command]
fn defaults() -> [Settings; 3] {
    ["low", "medium", "high"].map(|d| Settings::detail(d).expect("a preset"))
}

#[tauri::command]
fn start(app: AppHandle, state: State<AppState>, request: Request) -> Result<(), String> {
    let s = settings(&request)?;

    let mut job = state.job.lock().unwrap();
    if job.is_some() {
        return Err("A splat is already being made".into());
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
                Ok(_) => ("Your splat is ready", "Open SimpleSplat to look around"),
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
    // In a terminal, one progress line redrawn in place; otherwise a line per tenth of a stage.
    let terminal = std::io::stdout().is_terminal();
    let mut shown = (0, 0);
    let print = &mut |event: Event| {
        if terminal {
            print!("\r{:79}\r", ""); // clear the progress line
        }
        match event {
            Event::Project { path } => println!("Project folder: {}", path.display()),
            Event::Stage { n, name, skipped } => {
                let done = if skipped { ": already done" } else { "" };
                println!("[{n}/{}] {name}{done}", pipeline::STAGES);
            }
            Event::StageDone { secs, .. } => println!("      done in {secs}s"),
            Event::Info { text } => println!("      {text}"),
            Event::Progress {
                n,
                fraction,
                overall,
                eta,
                what,
            } => {
                let bar: String = (0..20)
                    .map(|i| {
                        if (i as f64) < fraction * 20.0 {
                            '#'
                        } else {
                            '.'
                        }
                    })
                    .collect();
                let line = format!(
                    "      {bar} {what}  {:.0}% in all, {} left",
                    overall * 100.0,
                    pipeline::about(eta)
                );
                if terminal {
                    print!("{line}");
                    let _ = std::io::stdout().flush();
                } else if (n, (fraction * 10.0) as u32) != shown {
                    shown = (n, (fraction * 10.0) as u32);
                    println!("{line}");
                }
            }
            Event::Preview { path } => println!("      preview: {}", path.display()),
        }
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

/// The Windows release build is a GUI program, so the CLI borrows the terminal's console to print.
// ponytail: the shell doesn't wait for a GUI program (the prompt returns, the exit code is lost);
// ship a console-subsystem copy as simplesplat.com beside the .exe if Windows CLI use grows
#[cfg(windows)]
fn attach_console() {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn AttachConsole(process: u32) -> i32;
    }
    unsafe {
        AttachConsole(u32::MAX); // ATTACH_PARENT_PROCESS
    }
}

fn main() -> ExitCode {
    let context = tauri::generate_context!();
    // Packages built against system tools (the Nix flake) name their folder at build time;
    // the installers carry theirs as a resource.
    let tools = option_env!("SIMPLESPLAT_TOOLS_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            tauri::utils::platform::resource_dir(context.package_info(), &tauri::Env::default())
                .ok()
                .map(|dir| dir.join("tools/bin"))
        });

    // macOS can pass -psn_0_… to the first launch of a downloaded app; it isn't a CLI argument.
    let args: Vec<String> = std::env::args()
        .filter(|arg| !arg.starts_with("-psn_"))
        .collect();
    if args.len() > 1 {
        #[cfg(windows)]
        attach_console();
        return cli(Cli::parse_from(args), tools);
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            tools,
            job: Mutex::new(None),
            gpu: OnceLock::new(),
        })
        .invoke_handler(tauri::generate_handler![
            start,
            stop,
            allow_folder,
            defaults,
            estimate
        ]);
    // macOS's own Quit (Cmd+Q) ends the app at once; this one asks first while a job runs.
    #[cfg(target_os = "macos")]
    let app = app.menu(quit_that_asks).on_menu_event(|app, event| {
        if event.id() == "quit" && !ask_to_quit(app, "main") {
            app.exit(0);
        }
    });
    app.build(context)
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                if ask_to_quit(app, &label) {
                    api.prevent_close();
                }
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

/// While a job runs, asks whether to quit and quits on yes; false when there is nothing to ask.
fn ask_to_quit(app: &AppHandle, window: &str) -> bool {
    if app.state::<AppState>().job.lock().unwrap().is_none() {
        return false;
    }
    let handle = app.clone();
    let mut ask = app
        .dialog()
        .message("Finished steps are kept and skipped next time, but training starts over")
        .title("Quit While Making a Splat?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit".into(),
            "Keep Going".into(),
        ));
    if let Some(window) = app.get_webview_window(window) {
        ask = ask.parent(&window);
    }
    ask.show(move |quit| {
        if quit {
            handle.exit(0);
        }
    });
    true
}

/// The default macOS menu, with its Quit (the app menu's last item) swapped for one of ours.
#[cfg(target_os = "macos")]
fn quit_that_asks(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first()
        && let Some(quit) = app_menu.items()?.last()
    {
        app_menu.remove(quit)?;
        let name = &app.package_info().name;
        app_menu.append(&MenuItem::with_id(
            app,
            "quit",
            format!("Quit {name}"),
            true,
            Some("CmdOrCtrl+Q"),
        )?)?;
    }
    Ok(menu)
}
