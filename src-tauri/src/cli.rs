//! The headless run, when SimpleSplat starts with arguments:
//! `simplesplat <input> [--detail ...] [--out ...]`.

use crate::pipeline::{self, Control, Event};
use crate::settings::{Detail, Settings};
use clap::Parser;
use std::io::{IsTerminal, Write};
use std::path::PathBuf;
use std::process::ExitCode;

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

pub fn run(args: Vec<String>, tools: Option<PathBuf>) -> ExitCode {
    #[cfg(windows)]
    attach_console();
    let args = Cli::parse_from(args);
    let mut printer = Printer {
        terminal: std::io::stdout().is_terminal(),
        shown: None,
    };
    match pipeline::run(
        &args.input,
        args.out.as_deref(),
        &Settings::detail(args.detail),
        tools.as_deref(),
        &Control::default(),
        &mut |event| printer.print(event),
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

/// Prints a run's events. In a terminal the progress line is redrawn in place; otherwise it is
/// printed once per tenth of a stage.
struct Printer {
    terminal: bool,
    /// The stage and the tenth of it last printed, when not in a terminal.
    shown: Option<(usize, u32)>,
}

impl Printer {
    fn print(&mut self, event: Event) {
        if self.terminal {
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
                let line = format!(
                    "      {} {what}  {:.0}% in all, {} left",
                    bar(fraction),
                    overall * 100.0,
                    time_left(eta)
                );
                let tenth = Some((stage, (fraction * 10.0) as u32));
                if self.terminal {
                    print!("{line}");
                    let _ = std::io::stdout().flush();
                } else if tenth != self.shown {
                    self.shown = tenth;
                    println!("{line}");
                }
            }
            Event::Preview { path } => println!("      preview: {}", path.display()),
        }
    }
}

/// `fraction` (0 to 1) as a bar of 20 characters.
fn bar(fraction: f64) -> String {
    let full = (fraction * 20.0).ceil() as usize;
    "#".repeat(full) + &".".repeat(20 - full)
}

fn time_left(secs: u64) -> String {
    if secs < 60 {
        "less than a minute".into()
    } else {
        let minutes = (secs + 30) / 60;
        format!(
            "about {minutes} minute{}",
            if minutes == 1 { "" } else { "s" }
        )
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
