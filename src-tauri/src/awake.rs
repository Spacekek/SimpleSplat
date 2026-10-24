//! Keeps the machine from sleeping while a splat is being made.

use std::process::Child;

/// Keeps the machine from sleeping while alive.
pub struct Awake(Option<Child>);

impl Drop for Awake {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
        #[cfg(windows)]
        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS);
        }
    }
}

#[cfg(windows)]
const ES_CONTINUOUS: u32 = 0x8000_0000;

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn SetThreadExecutionState(flags: u32) -> u32;
}

/// Held by this thread until Awake resets it.
#[cfg(windows)]
pub fn keep_awake() -> Awake {
    const ES_SYSTEM_REQUIRED: u32 = 0x1;
    unsafe {
        SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
    }
    Awake(None)
}

#[cfg(not(windows))]
pub fn keep_awake() -> Awake {
    use std::process::{Command, Stdio};
    let pid = std::process::id().to_string();
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = Command::new("caffeinate");
        c.args(["-i", "-w", &pid]);
        c
    } else {
        // Like caffeinate -w: ends with this process, even if it dies without dropping Awake.
        let mut c = Command::new("systemd-inhibit");
        c.args([
            "--what=idle:sleep",
            "--who=SimpleSplat",
            "--why=Making a splat",
            "tail",
            &format!("--pid={pid}"),
            "-f",
            "/dev/null",
        ]);
        c
    };
    Awake(cmd.stdout(Stdio::null()).stderr(Stdio::null()).spawn().ok())
}
