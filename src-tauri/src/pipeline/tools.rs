//! Running ffmpeg and Spirula: from the bundle or PATH, logged to log.txt, and stoppable from
//! another thread.

use super::{Job, STOPPED};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::Duration;

/// Stops a running pipeline from another thread.
#[derive(Default)]
pub struct Control {
    stopped: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl Control {
    /// Kills the running tool. During training the latest preview becomes the result.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.kill();
        }
    }

    pub(super) fn stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }
}

/// A bundled tool if present, otherwise the bare name for a PATH lookup.
pub fn tool(tools: Option<&Path>, name: &str) -> Command {
    let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    let bundled = tools.map(|dir| dir.join(file)).filter(|path| path.exists());
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = Command::new(bundled.unwrap_or_else(|| name.into()));
    // On Windows each console tool started by the app would open its own console window.
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, CREATE_NO_WINDOW);
    cmd
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

impl Job<'_> {
    pub(super) fn cmd(&self, name: &str) -> Command {
        tool(self.tools.as_deref(), name)
    }

    /// Runs a tool with its stdout and stderr lines appended to log.txt and passed to `on_line`.
    pub(super) fn run_tool(
        &mut self,
        mut cmd: Command,
        on_line: &mut dyn FnMut(&str),
    ) -> Result<(), String> {
        if self.control.stopped() {
            return Err(STOPPED.into());
        }
        let _ = writeln!(self.log, "\n$ {cmd:?}");
        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Can't start {:?}: {e}", cmd.get_program()))?;
        let (sender, lines) = mpsc::channel();
        forward_lines(child.stdout.take().expect("piped"), sender.clone());
        forward_lines(child.stderr.take().expect("piped"), sender);
        *self.control.child.lock().unwrap() = Some(child);
        // A stop that came before the child was registered had nothing to kill.
        if self.control.stopped() {
            self.control.stop();
        }
        for line in lines {
            let _ = writeln!(self.log, "{line}");
            on_line(&line);
        }
        // Poll instead of wait() so Control::stop never blocks on this lock.
        let status = loop {
            let polled = self
                .control
                .child
                .lock()
                .unwrap()
                .as_mut()
                .expect("registered above")
                .try_wait();
            if let Some(status) = polled.map_err(|e| e.to_string())? {
                break status;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        *self.control.child.lock().unwrap() = None;
        if status.success() {
            Ok(())
        } else {
            Err(format!("{:?} exited with {status}", cmd.get_program()))
        }
    }

    /// Runs a tool and returns its stdout followed by its stderr.
    pub(super) fn tool_output(&mut self, cmd: &mut Command) -> Result<String, String> {
        let _ = writeln!(self.log, "\n$ {cmd:?}");
        let out = cmd
            .output()
            .map_err(|e| format!("Can't start {:?}: {e}", cmd.get_program()))?;
        let text = String::from_utf8_lossy(&out.stdout).into_owned()
            + &String::from_utf8_lossy(&out.stderr);
        let _ = self.log.write_all(text.as_bytes());
        Ok(text)
    }

    pub(super) fn log_tail(&mut self) -> String {
        let mut tail = Vec::new();
        if let Ok(mut f) = File::open(self.project.join("log.txt")) {
            let len = f.metadata().map(|m| m.len()).unwrap_or(0);
            let _ = f.seek(SeekFrom::Start(len.saturating_sub(8192)));
            let _ = f.read_to_end(&mut tail);
        }
        // The cut can land inside a multi-byte character.
        String::from_utf8_lossy(&tail).into_owned()
    }
}

/// Sends `stream`'s lines to `sender` from a thread of their own. Invalid UTF-8 doesn't end the
/// reading, which would leave the tool blocked on a full pipe.
fn forward_lines(stream: impl Read + Send + 'static, sender: mpsc::Sender<String>) {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).split(b'\n').map_while(Result::ok) {
            let line = String::from_utf8_lossy(&line);
            let _ = sender.send(line.trim_end_matches('\r').to_string());
        }
    });
}
