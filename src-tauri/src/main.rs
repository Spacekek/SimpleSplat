// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod awake;
mod cli;
mod gpu;
mod pipeline;
mod settings;

use pipeline::{Control, Event};
use serde::Deserialize;
use settings::{Detail, Settings};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;

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
        return cli::run(args, tools);
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
