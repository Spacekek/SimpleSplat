//! Input (video or photo folder) -> frames -> Spirula SfM -> Spirula training -> scene.ply, in
//! `<name>_splat/`.
//!
//! Each stage owns one folder plus a `.<folder>.stamp` naming everything that produced it. A
//! matching stamp skips the stage; a stamp includes the previous stage's, so changing an early
//! setting re-runs everything after it. Each stage is a module with a `run` entry point.

mod frames;
mod sfm;
mod train;

use serde::Serialize;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::{Duration, Instant, SystemTime};

pub const STAGES: usize = 3;
pub const STOPPED: &str = "Stopped.";

/// What a run uses: a Detail preset, with any advanced overrides. The UI shows each preset's values
/// as the defaults, so this is their one source.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Frames taken from a video, or the most photos used from a folder.
    pub frames: u32,
    pub steps: u32,
    pub max_size: u32,
    /// Steps between exports (previews). None: a fifth of the steps.
    pub export_every: Option<u32>,
    /// None: one camera for video, one per photo otherwise.
    pub single_camera: Option<bool>,
    /// Spirula's SfM preset: low, medium or high (image size, features, pairs).
    pub sfm_quality: &'static str,
    /// The most splats training may grow to.
    pub max_splats: u32,
    /// Spirula's floater suppression and distraction robustness: off, mild or strong.
    pub floater_suppression: &'static str,
    pub ignore_moving: &'static str,
    /// Per-frame exposure and colour correction (PPISP and a bilateral grid).
    pub exposure_correction: bool,
    pub keep_intermediates: bool,
}

/// The values of Settings' off/mild/strong levels.
pub const LEVELS: [&str; 3] = ["off", "mild", "strong"];

impl Settings {
    pub fn detail(name: &str) -> Option<Self> {
        let (frames, steps, sfm_quality, max_splats) = match name {
            // Spirula adds at most about 10% splats per 100 steps until 2,500 before the end:
            // on the test video 5k steps ended at 58k splats, 10k at 670k (Brush's 5k: about 240k).
            "low" => (100, 10_000, "low", 1_000_000),
            "medium" => (150, 15_000, "medium", 1_000_000),
            // Spirula's own high preset; its low one (200k) saved Low no time, 5:04 for 5:19.
            "high" => (300, 30_000, "high", 3_000_000),
            _ => return None,
        };
        Some(Self {
            frames,
            steps,
            max_size: 1600,
            export_every: None,
            single_camera: None,
            sfm_quality,
            max_splats,
            // Better on every score in the settings tests, for 8% more training time.
            floater_suppression: "mild",
            ignore_moving: "off",
            exposure_correction: true,
            keep_intermediates: true,
        })
    }
}

/// Progress reported while the pipeline runs.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    Project {
        path: PathBuf,
    },
    Stage {
        n: usize,
        name: String,
        skipped: bool,
    },
    StageDone {
        n: usize,
        secs: u64,
    },
    Info {
        text: String,
    },
    /// `fraction` of stage `n` is done and `overall` of the job; `eta` is seconds left.
    Progress {
        n: usize,
        fraction: f64,
        overall: f64,
        eta: u64,
        what: String,
    },
    Preview {
        path: PathBuf,
    },
}

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

    fn stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }
}

/// Sends events, and turns each stage's fraction done into overall progress and time left.
///
/// Each stage has an estimate in seconds from runs on an Apple M5. The speed seen so far scales what
/// is left: the running stage's own once it is 5% along, before that the finished stages' (when they
/// took long enough to tell), else the estimates stand as they are.
struct Report<'a> {
    emit: &'a mut dyn FnMut(Event),
    estimates: [f64; STAGES],
    runs: [bool; STAGES],
    stage: usize,
    started: Instant,
    finished: (f64, f64), // seconds taken and estimated by the stages run so far
    sent: Option<Instant>,
}

impl<'a> Report<'a> {
    fn new(emit: &'a mut dyn FnMut(Event), estimates: [f64; STAGES]) -> Self {
        Self {
            emit,
            estimates,
            runs: [true; STAGES],
            stage: 0,
            started: Instant::now(),
            finished: (0.0, 0.0),
            sent: None,
        }
    }

    fn event(&mut self, event: Event) {
        (self.emit)(event);
    }

    fn start(&mut self, n: usize, name: &str, skipped: bool) {
        (self.stage, self.started, self.sent) = (n - 1, Instant::now(), None);
        self.runs[n - 1] = !skipped;
        self.event(Event::Stage {
            n,
            name: name.into(),
            skipped,
        });
        if !skipped {
            self.progress(0.0, "");
        }
    }

    fn done(&mut self) {
        let secs = self.started.elapsed().as_secs_f64();
        self.finished.0 += secs;
        self.finished.1 += self.estimates[self.stage];
        self.event(Event::StageDone {
            n: self.stage + 1,
            secs: secs as u64,
        });
    }

    /// `fraction` of the running stage is done, and it is busy with `what`.
    fn progress(&mut self, fraction: f64, what: &str) {
        if self
            .sent
            .is_some_and(|t| t.elapsed() < Duration::from_millis(250))
        {
            return;
        }
        self.sent = Some(Instant::now());
        let fraction = fraction.clamp(0.0, 1.0);
        let planned = |i: usize| if self.runs[i] { self.estimates[i] } else { 0.0 };
        let total: f64 = (0..STAGES).map(planned).sum();
        let here = planned(self.stage) * fraction;
        let done = (0..self.stage).map(planned).sum::<f64>() + here;
        let speed = if here > 0.05 * planned(self.stage) {
            self.started.elapsed().as_secs_f64() / here
        } else if self.finished.1 > 30.0 {
            self.finished.0 / self.finished.1
        } else {
            1.0
        };
        let event = Event::Progress {
            n: self.stage + 1,
            fraction,
            overall: if total > 0.0 { done / total } else { 1.0 },
            eta: ((total - done) * speed).round() as u64,
            what: what.into(),
        };
        self.event(event);
    }
}

/// Runs the whole pipeline and returns the path of the finished scene. Errors are plain language.
pub fn run(
    input: &Path,
    out: Option<&Path>,
    settings: &Settings,
    tools: Option<&Path>,
    control: &Control,
    emit: &mut dyn FnMut(Event),
) -> Result<PathBuf, String> {
    let input = fs::canonicalize(input).map_err(|_| format!("Can't find {}.", input.display()))?;
    let project = project_dir(&input, out)?;
    let log_path = project.join("log.txt");
    let log = File::options()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Can't write {}: {e}", log_path.display()))?;
    let mut job = Job {
        tools: tools.map(Path::to_path_buf),
        project,
        log,
        control,
    };
    let _awake = keep_awake();
    emit(Event::Project {
        path: job.project.clone(),
    });
    if let Some(text) =
        crate::gpu::detect(tools).and_then(|gpu| crate::gpu::warning(settings, &gpu))
    {
        emit(Event::Info { text });
    }
    job.pipeline(&input, settings, emit).map_err(|e| {
        if control.stopped() {
            STOPPED.into()
        } else {
            format!("{e}\nDetails: {}", log_path.display())
        }
    })
}

struct Job<'a> {
    tools: Option<PathBuf>,
    project: PathBuf,
    log: File,
    control: &'a Control,
}

impl Job<'_> {
    fn pipeline(
        &mut self,
        input: &Path,
        s: &Settings,
        emit: &mut dyn FnMut(Event),
    ) -> Result<PathBuf, String> {
        let video = input.is_file();
        let single_camera = s.single_camera.unwrap_or(video);
        let files = if video {
            vec![input.to_path_buf()]
        } else {
            frames::photos(input, s.frames)?
        };
        let n = if video {
            s.frames as usize
        } else {
            files.len()
        };
        let out = &mut Report::new(
            emit,
            [
                frames::estimate(n, video),
                sfm::estimate(n, s.sfm_quality),
                train::estimate(s.steps),
            ],
        );
        let frames_key = format!(
            "input={} {} frames={n} max_size={}",
            input.display(),
            fingerprint(&files),
            s.max_size
        );
        let label = if video {
            "Extracting frames"
        } else {
            "Preparing photos"
        };
        self.stage(1, label, "images", &frames_key, out, |job, dir, out| {
            frames::run(job, &files, video, s, dir, out)
        })?;

        let sfm_key = format!(
            "{frames_key} | spirula sfm video={video} single_camera={single_camera} quality={} up=-y",
            s.sfm_quality
        );
        self.stage(
            2,
            "Finding camera positions",
            "sparse",
            &sfm_key,
            out,
            |job, dir, out| sfm::run(job, video, single_camera, s.sfm_quality, dir, out),
        )?;

        let train_key = format!(
            "{sfm_key} | spirula train steps={} splats={} floaters={} moving={} exposure={}",
            s.steps, s.max_splats, s.floater_suppression, s.ignore_moving, s.exposure_correction
        );
        self.stage(
            3,
            "Training the splat",
            "exports",
            &train_key,
            out,
            |job, dir, out| train::run(job, s, dir, out),
        )?;

        if self.control.stopped() {
            out.event(Event::Info {
                text: "Stopped early: the result is the latest preview.".into(),
            });
        }
        if !s.keep_intermediates {
            for dir in ["images", "sparse", "exports"] {
                let _ = fs::remove_dir_all(self.project.join(dir));
                let _ = fs::remove_file(self.project.join(format!(".{dir}.stamp")));
            }
        }
        Ok(self.project.join("scene.ply"))
    }

    fn stage(
        &mut self,
        n: usize,
        name: &str,
        dir: &str,
        key: &str,
        out: &mut Report<'_>,
        work: impl FnOnce(&mut Self, &Path, &mut Report<'_>) -> Result<(), String>,
    ) -> Result<(), String> {
        if self.control.stopped() {
            return Err(STOPPED.into());
        }
        let stamp = self.project.join(format!(".{dir}.stamp"));
        let skipped = fs::read_to_string(&stamp).is_ok_and(|s| s == key);
        out.start(n, name, skipped);
        if skipped {
            return Ok(());
        }
        let dir = self.project.join(dir);
        let _ = fs::remove_file(&stamp);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).map_err(|e| format!("Can't create {}: {e}", dir.display()))?;
        work(self, &dir, out)?;
        // A stage cut short by Stop keeps its partial result but no stamp, so it re-runs next time.
        if !self.control.stopped() {
            fs::write(&stamp, key).map_err(|e| format!("Can't write {}: {e}", stamp.display()))?;
        }
        out.done();
        Ok(())
    }

    fn cmd(&self, name: &str) -> Command {
        tool(self.tools.as_deref(), name)
    }

    /// Runs a command with its stdout and stderr lines appended to log.txt and passed to `on_line`.
    fn run(&mut self, mut cmd: Command, on_line: &mut dyn FnMut(&str)) -> Result<(), String> {
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

    /// Runs a command and returns stdout followed by stderr.
    fn capture(&mut self, cmd: &mut Command) -> Result<String, String> {
        let _ = writeln!(self.log, "\n$ {cmd:?}");
        let out = cmd
            .output()
            .map_err(|e| format!("Can't start {:?}: {e}", cmd.get_program()))?;
        let text = String::from_utf8_lossy(&out.stdout).into_owned()
            + &String::from_utf8_lossy(&out.stderr);
        let _ = self.log.write_all(text.as_bytes());
        Ok(text)
    }

    fn log_tail(&mut self) -> String {
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

/// A bundled tool if present, otherwise the bare name for a PATH lookup.
pub fn tool(tools: Option<&Path>, name: &str) -> Command {
    let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    let bundled = tools.map(|dir| dir.join(file)).filter(|path| path.exists());
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = Command::new(bundled.unwrap_or_else(|| name.into()));
    // On Windows each console tool started by the app would open its own console window.
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

fn project_dir(input: &Path, out: Option<&Path>) -> Result<PathBuf, String> {
    let name = format!(
        "{}_splat",
        input.file_stem().unwrap_or_default().to_string_lossy()
    );
    let parent = out.or(input.parent()).unwrap_or(Path::new("."));
    let preferred = parent.join(&name);
    match fs::create_dir_all(&preferred) {
        Ok(()) => Ok(preferred),
        Err(e)
            if out.is_none()
                && matches!(
                    e.kind(),
                    ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem
                ) =>
        {
            let fallback = dirs::data_dir()
                .ok_or("No writable folder for the results.")?
                .join("com.simplesplat.desktop")
                .join(&name);
            fs::create_dir_all(&fallback)
                .map_err(|e| format!("Can't create {}: {e}", fallback.display()))?;
            Ok(fallback)
        }
        Err(e) => Err(format!("Can't create {}: {e}", preferred.display())),
    }
}

/// Total size and newest modification of `files`, so a re-recorded video or a changed photo isn't
/// mistaken for the input a stage was made from.
fn fingerprint(files: &[PathBuf]) -> String {
    let (mut bytes, mut newest) = (0, 0);
    for meta in files.iter().filter_map(|f| f.metadata().ok()) {
        bytes += meta.len();
        let modified = meta
            .modified()
            .ok()
            .map(|t| t.duration_since(SystemTime::UNIX_EPOCH));
        newest = newest.max(modified.and_then(Result::ok).map_or(0, |d| d.as_secs()));
    }
    format!("bytes={bytes} modified={newest}")
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

/// Time left in words.
pub fn about(secs: u64) -> String {
    if secs < 60 {
        "less than a minute".into()
    } else {
        format!("about {} min", (secs + 30) / 60)
    }
}

/// The plain-language error for a failed Spirula run, or `otherwise`.
// ponytail: GPU failure strings are guessed (Vulkan's error names), refine from real failures
fn spirula_hint(log_tail: &str, otherwise: &'static str) -> &'static str {
    let tail = log_tail.to_lowercase();
    if tail.contains("out of memory") || tail.contains("out_of_device_memory") {
        "The GPU ran out of memory. Try a lower Detail setting."
    } else if tail.contains("incompatible_driver") || tail.contains("libvulkan") {
        "No supported GPU found. SimpleSplat needs Vulkan (Linux, Windows) or Metal (macOS)."
    } else {
        otherwise
    }
}

/// Keeps the machine from sleeping while alive.
struct Awake(Option<Child>);

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
fn keep_awake() -> Awake {
    const ES_SYSTEM_REQUIRED: u32 = 0x1;
    unsafe {
        SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
    }
    Awake(None)
}

#[cfg(not(windows))]
fn keep_awake() -> Awake {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stages_skip_on_matching_stamp_and_rerun_otherwise() {
        let project = std::env::temp_dir().join(format!("simplesplat-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&project);
        fs::create_dir_all(&project).unwrap();
        let control = Control::default();
        let mut job = Job {
            tools: None,
            project: project.clone(),
            log: File::create(project.join("log.txt")).unwrap(),
            control: &control,
        };
        let runs = std::cell::Cell::new(0);
        let work = |key: &str, job: &mut Job| {
            let mut ignore = |_: Event| {};
            let out = &mut Report::new(&mut ignore, [1.0; STAGES]);
            job.stage(1, "test", "out", key, out, |_, dir, _| {
                runs.set(runs.get() + 1);
                fs::write(dir.join(runs.get().to_string()), "").map_err(|e| e.to_string())
            })
        };
        work("a", &mut job).unwrap();
        work("a", &mut job).unwrap();
        assert_eq!(runs.get(), 1, "same key must skip");
        work("b", &mut job).unwrap();
        assert_eq!(runs.get(), 2, "changed key must re-run");
        assert!(
            !project.join("out/1").exists(),
            "re-run must start from an empty folder"
        );
        control.stop();
        assert_eq!(
            work("c", &mut job),
            Err(STOPPED.into()),
            "stopped job must not start stages"
        );
        fs::remove_dir_all(&project).unwrap();
    }

    #[test]
    fn presets_and_error_hints() {
        assert_eq!(Settings::detail("high").map(|s| s.steps), Some(30_000));
        assert_eq!(
            spirula_hint(
                "vkAllocateMemory: VK_ERROR_OUT_OF_DEVICE_MEMORY",
                "Training failed."
            ),
            "The GPU ran out of memory. Try a lower Detail setting."
        );
        assert_eq!(spirula_hint("RESULT: FAILED", "Lost."), "Lost.");
    }

    #[test]
    fn time_left_scales_with_the_speed_seen() {
        let mut sent = Vec::new();
        let mut emit = |event| sent.push(event);
        let mut out = Report::new(&mut emit, [10.0, 100.0, 890.0]);
        out.start(1, "frames", true);
        out.start(2, "sfm", false);
        out.started -= Duration::from_secs(20); // twice as slow as estimated
        out.sent = None;
        out.progress(0.1, "");
        let Some(Event::Progress { overall, eta, .. }) = sent.last() else {
            panic!("no progress sent");
        };
        // Skipped frames count for nothing: 10 of 990 estimated seconds done, 980 left at half speed.
        assert!((overall - 10.0 / 990.0).abs() < 1e-9);
        assert_eq!(*eta, 1960);
    }
}
