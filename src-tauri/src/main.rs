// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod gpu;
mod pipeline;

use clap::Parser;
use pipeline::{Control, Detail, Event, Settings};
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
    #[arg(long, value_enum, default_value_t = Detail::Medium)]
    detail: Detail,
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

/// What the UI asks for: a Detail preset's settings with its advanced overrides applied.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    input: PathBuf,
    out_dir: Option<PathBuf>,
    #[serde(flatten)]
    settings: Settings,
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
    let s = request.settings;
    let found = state
        .gpu
        .get_or_init(|| gpu::detect(state.tools.as_deref()))
        .clone();
    Ok(Fit {
        need: gpu::gb(gpu::need(&s).mib),
        warning: found.as_ref().and_then(|g| gpu::warning(&s, g)),
        gpu: found,
    })
}

/// Each Detail preset's settings, Low to High: the defaults the UI shows.
#[tauri::command]
fn defaults() -> [Settings; 3] {
    [Detail::Low, Detail::Medium, Detail::High].map(Settings::detail)
}

/// GitHub repository ("owner/name") of a CI build, else "": only CI builds look for newer releases.
#[tauri::command]
fn repo() -> &'static str {
    option_env!("GITHUB_REPOSITORY").unwrap_or("")
}

#[tauri::command]
fn start(app: AppHandle, state: State<AppState>, request: Request) -> Result<(), String> {
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
            &request.settings,
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
    let settings = Settings::detail(args.detail);
    // In a terminal, one progress line redrawn in place; otherwise a line per tenth of a stage.
    let terminal = std::io::stdout().is_terminal();
    let mut shown = None;
    let print = &mut |event: Event| {
        if terminal {
            print!("\r{:79}\r", ""); // clear the progress line
        }
        match event {
            Event::Project { path } => println!("Project folder: {}", path.display()),
            Event::StageStart {
                stage,
                name,
                skipped,
            } => {
                let done = if skipped { ": already done" } else { "" };
                println!("[{}/{}] {name}{done}", stage + 1, pipeline::STAGES);
            }
            Event::StageDone { secs, .. } => println!("      done in {secs}s"),
            Event::Info { text } => println!("      {text}"),
            Event::Progress {
                stage,
                fraction,
                overall,
                eta,
                what,
            } => {
                let full = (fraction * 20.0).ceil() as usize; // fraction is 0 to 1
                let bar = "#".repeat(full) + &".".repeat(20 - full);
                let line = format!(
                    "      {bar} {what}  {:.0}% in all, {} left",
                    overall * 100.0,
                    pipeline::about(eta)
                );
                if terminal {
                    print!("{line}");
                    let _ = std::io::stdout().flush();
                } else {
                    let tenth = Some((stage, (fraction * 10.0) as u32));
                    if tenth != shown {
                        shown = tenth;
                        println!("{line}");
                    }
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
#[cfg(windows)]
fn attach_console() {
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn AttachConsole(process: u32) -> i32;
    }
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
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
            estimate,
            repo
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
