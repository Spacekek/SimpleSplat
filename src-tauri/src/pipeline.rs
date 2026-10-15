//! Input (video or photo folder) -> frames -> COLMAP -> Brush -> scene.ply, in `<name>_splat/`.
//!
//! Each stage owns one folder plus a `.<folder>.stamp` naming everything that produced it. A
//! matching stamp skips the stage; a stamp includes the previous stage's, so changing an early
//! setting re-runs everything after it.

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
/// Video candidates per frame kept: each kept frame is the sharpest of its group.
const CANDIDATES: usize = 3;
/// Seconds per unit of `train_work` on an Apple M5 (the spike's 30k run took 38 minutes).
const BRUSH_SECS_PER_WORK: f64 = 38.0 * 60.0 / 165_000.0;
const PHOTO_EXTS: [&str; 8] = ["jpg", "jpeg", "png", "heic", "heif", "webp", "tif", "tiff"];
const UNREADABLE: &str = "Couldn't read the input. Use a common video format (mp4, mov) or a folder of photos (jpg, png, heic).";

pub struct Settings {
    /// Frames taken from a video, or the most photos used from a folder.
    pub frames: u32,
    pub steps: u32,
    pub max_size: u32,
    /// Steps between exports (previews). None: a fifth of the steps.
    pub export_every: Option<u32>,
    /// None: one camera for video, one per photo otherwise.
    pub single_camera: Option<bool>,
    pub incremental_mapper: bool,
    pub keep_intermediates: bool,
}

impl Settings {
    pub fn detail(name: &str) -> Option<Self> {
        let (frames, steps) = match name {
            "low" => (100, 5_000),
            "medium" => (150, 15_000),
            "high" => (300, 30_000),
            _ => return None,
        };
        Some(Self {
            frames,
            steps,
            max_size: 1600,
            export_every: None,
            single_camera: None,
            incremental_mapper: false,
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
            photos(input, s.frames)?
        };
        let n = if video {
            s.frames as usize
        } else {
            files.len()
        };
        let out = &mut Report::new(
            emit,
            [
                n as f64 * if video { 0.025 } else { 0.15 },
                colmap_estimates(n, video, s.incremental_mapper)
                    .iter()
                    .sum(),
                BRUSH_SECS_PER_WORK * train_work(s.steps),
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
            job.frames(&files, video, s, dir, out)
        })?;

        let colmap_key = format!(
            "{frames_key} | colmap video={video} single_camera={single_camera} incremental={} align=manhattan",
            s.incremental_mapper
        );
        self.stage(
            2,
            "Finding camera positions",
            "sparse",
            &colmap_key,
            out,
            |job, dir, out| job.colmap(video, single_camera, s.incremental_mapper, dir, out),
        )?;

        let train_key = format!("{colmap_key} | steps={}", s.steps);
        self.stage(
            3,
            "Training the splat",
            "exports",
            &train_key,
            out,
            |job, dir, out| job.train(s, dir, out),
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

    /// `files` is the video, or the photos to use.
    fn frames(
        &mut self,
        files: &[PathBuf],
        video: bool,
        s: &Settings,
        dir: &Path,
        out: &mut Report<'_>,
    ) -> Result<(), String> {
        // Also to SDR BT.709, which leaves SDR as it is: phone HDR video (HLG or PQ in BT.2020)
        // otherwise comes out washed out.
        let scale = format!(
            "scale=w='min({m},iw)':h='min({m},ih)':force_original_aspect_ratio=decrease\
             :out_primaries=bt709:out_transfer=bt709:out_color_matrix=bt709",
            m = s.max_size
        );
        let unreadable = |_| UNREADABLE.to_string();
        if video {
            let input = &files[0];
            let duration = self.capture(
                self.cmd("ffprobe")
                    .args([
                        "-v",
                        "error",
                        "-show_entries",
                        "format=duration",
                        "-of",
                        "csv=p=0",
                    ])
                    .arg(input),
            )?;
            let duration: f64 = duration
                .trim()
                .parse()
                .map_err(|_| UNREADABLE.to_string())?;
            // Candidates at CANDIDATES times the frame rate (never above the source's: the fps filter
            // would repeat frames), each scored by blurdetect; the sharpest of each group is kept.
            let candidates = CANDIDATES * s.frames as usize;
            let mut ffmpeg = self.cmd("ffmpeg");
            ffmpeg
                .args(["-hide_banner", "-loglevel", "error", "-i"])
                .arg(input);
            ffmpeg
                .args([
                    "-vf",
                    &format!(
                        "fps='min(source_fps,{})',{scale},blurdetect,metadata=print:key=lavfi.blur:file='pipe\\:1'",
                        candidates as f64 / duration
                    ),
                    "-q:v",
                    "2",
                ])
                .arg(dir.join("candidate-%05d.jpg"));
            let mut blur = Vec::new();
            self.run(ffmpeg, &mut |line| {
                if let Some(value) = line.strip_prefix("lavfi.blur=") {
                    blur.push(value.trim().parse().unwrap_or(f64::MAX));
                    let done = blur.len() as f64 / candidates as f64;
                    out.progress(done, "Picking the sharpest frames");
                }
            })
            .map_err(unreadable)?;
            let candidate = |i: usize| dir.join(format!("candidate-{:05}.jpg", i + 1));
            let count = (0..).take_while(|&i| candidate(i).exists()).count();
            if blur.len() != count {
                blur = vec![0.0; count]; // no scores: evenly spaced frames
            }
            let keep = sharpest(&blur, s.frames as usize);
            let mut kept = 0;
            for i in 0..count {
                if keep.get(kept) == Some(&i) {
                    kept += 1;
                    fs::rename(candidate(i), dir.join(format!("{kept:04}.jpg")))
                } else {
                    fs::remove_file(candidate(i))
                }
                .map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
        for (i, photo) in files.iter().enumerate() {
            out.progress(
                i as f64 / files.len() as f64,
                &format!("Photo {} of {}", i + 1, files.len()),
            );
            // Tiled HEIC is stitched by an internal filter graph that can't be combined with -vf.
            let heic = photo.extension().is_some_and(|ext| {
                ext.eq_ignore_ascii_case("heic") || ext.eq_ignore_ascii_case("heif")
            });
            let decoded = dir.join("decoded.png");
            if heic {
                let mut decode = self.cmd("ffmpeg");
                decode
                    .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
                    .arg(photo)
                    .arg(&decoded);
                self.run(decode, &mut |_| {}).map_err(unreadable)?;
            }
            let mut ffmpeg = self.cmd("ffmpeg");
            ffmpeg
                .args(["-hide_banner", "-loglevel", "error", "-i"])
                .arg(if heic { &decoded } else { photo });
            ffmpeg
                .args(["-vf", &scale, "-q:v", "2"])
                .arg(dir.join(format!("{:04}.jpg", i + 1)));
            self.run(ffmpeg, &mut |_| {}).map_err(unreadable)?;
        }
        let _ = fs::remove_file(dir.join("decoded.png"));
        Ok(())
    }

    fn colmap(
        &mut self,
        video: bool,
        single_camera: bool,
        incremental: bool,
        sparse: &Path,
        out: &mut Report<'_>,
    ) -> Result<(), String> {
        let (images, database, mapped) = (
            self.project.join("images"),
            self.project.join("database.db"),
            self.project.join("mapped"),
        );
        let _ = fs::remove_file(&database);
        let _ = fs::remove_dir_all(&mapped);
        let _ = fs::remove_file(self.project.join("view.json")); // belongs to the old model
        let total = fs::read_dir(&images).map(|d| d.count()).unwrap_or(0);
        // Each step's share of the stage, by its estimated time.
        let parts = colmap_estimates(total, video, incremental);
        let share = |step: usize, done: f64| {
            (parts[..step].iter().sum::<f64>() + parts[step] * done) / parts.iter().sum::<f64>()
        };
        let mut features = self.cmd("colmap");
        features
            .args(["feature_extractor", "--database_path"])
            .arg(&database)
            .arg("--image_path")
            .arg(&images);
        features.args([
            "--ImageReader.single_camera",
            if single_camera { "1" } else { "0" },
            "--FeatureExtraction.use_gpu",
            "0",
        ]);
        self.run(features, &mut |line| {
            if let Some(done) = counter(line) {
                out.progress(share(0, done), "Finding features");
            }
        })
        .map_err(|_| "COLMAP failed while finding features.".to_string())?;

        // Video frames are in order, so neighbours suffice (13x faster in the spike); photos are not.
        let mut matcher = self.cmd("colmap");
        matcher.arg(if video {
            "sequential_matcher"
        } else {
            "exhaustive_matcher"
        });
        matcher
            .arg("--database_path")
            .arg(&database)
            .args(["--FeatureMatching.use_gpu", "0"]);
        self.run(matcher, &mut |line| {
            if let Some(done) = counter(line) {
                out.progress(share(1, done), "Matching features");
            }
        })
        .map_err(|_| "COLMAP failed while matching features.".to_string())?;

        fs::create_dir_all(&mapped).map_err(|e| e.to_string())?;
        let mut mapper = self.cmd("colmap");
        mapper
            .arg(if incremental {
                "mapper"
            } else {
                "global_mapper"
            })
            .arg("--database_path")
            .arg(&database)
            .arg("--image_path")
            .arg(&images)
            .arg("--output_path")
            .arg(&mapped);
        if !incremental {
            mapper.args([
                "--GlobalMapper.gp_use_gpu",
                "0",
                "--GlobalMapper.ba_ceres_use_gpu",
                "0",
            ]);
        }
        let lost = "Couldn't work out where the camera was. Film slower, keep more overlap between shots, and avoid plain or shiny surfaces.";
        // The mapper has no counter, so its progress is time against the estimate.
        let mapping = Instant::now();
        self.run(mapper, &mut |_| {
            let done = (mapping.elapsed().as_secs_f64() / parts[2]).min(0.95);
            out.progress(share(2, done), "Building the 3D model");
        })
        .map_err(|_| lost.to_string())?;
        if !mapped.join("0").exists() {
            return Err(lost.into());
        }

        // Upright: the viewer has no rotation control, so gravity is fixed in the data. Straight
        // lines (Manhattan world) found real vertical much better than the average camera tilt in
        // the spike (median roll 3.5 vs 7.7 degrees); the latter is the fallback for line-poor scenes.
        let model = sparse.join("0");
        fs::create_dir_all(&model).map_err(|e| e.to_string())?;
        let mut aligned = Err("COLMAP failed while straightening the scene.".to_string());
        for method in ["MANHATTAN-WORLD", "IMAGE-ORIENTATION"] {
            let mut align = self.cmd("colmap");
            align
                .args(["model_orientation_aligner", "--image_path"])
                .arg(&images)
                .arg("--input_path")
                .arg(mapped.join("0"));
            align
                .arg("--output_path")
                .arg(&model)
                .args(["--method", method]);
            if self.run(align, &mut |_| {}).is_ok() {
                aligned = Ok(());
                break;
            }
        }
        aligned?;
        // Nothing reads these again: a re-run of this stage starts over, and Brush needs only the model.
        let _ = fs::remove_dir_all(&mapped);
        let _ = fs::remove_file(&database);

        let analysis = self.capture(
            self.cmd("colmap")
                .arg("model_analyzer")
                .arg("--path")
                .arg(&model),
        )?;
        if let Some(placed) = analysis.lines().find_map(|l| {
            l.split("Registered images: ")
                .nth(1)?
                .trim()
                .parse::<usize>()
                .ok()
        }) {
            out.event(Event::Info {
                text: format!("Placed {placed} of {total} frames."),
            });
            if placed * 2 < total {
                out.event(Event::Info {
                    text: "Many frames couldn't be placed, so the result may have holes.".into(),
                });
            }
        }
        self.write_view(&model);
        Ok(())
    }

    /// Writes view.json: the first frame's camera in viewer coordinates, aimed at the scene.
    fn write_view(&mut self, model: &Path) {
        let txt = std::env::temp_dir().join(format!("simplesplat-{}-txt", std::process::id()));
        let _ = fs::create_dir_all(&txt);
        let mut convert = self.cmd("colmap");
        convert
            .args(["model_converter", "--output_type", "TXT", "--input_path"])
            .arg(model)
            .arg("--output_path")
            .arg(&txt);
        let read = |name: &str| fs::read_to_string(txt.join(name)).unwrap_or_default();
        let view = self.capture(&mut convert).ok().and_then(|_| {
            first_frame_view(
                &read("cameras.txt"),
                &read("images.txt"),
                &read("points3D.txt"),
            )
        });
        let _ = fs::remove_dir_all(&txt);
        if let Some(view) = view {
            let _ = fs::write(self.project.join("view.json"), view);
        }
    }

    fn train(&mut self, s: &Settings, exports: &Path, out: &mut Report<'_>) -> Result<(), String> {
        // Brush loads any .ply it finds in the project as starting splats; a previous result must go.
        let scene = self.project.join("scene.ply");
        let _ = fs::remove_file(&scene);
        let mut brush = self.cmd("brush-cli");
        brush.arg(&self.project).args([
            "--total-train-iters",
            &s.steps.to_string(),
            "--export-every",
            &s.export_every.unwrap_or(s.steps / 5).to_string(),
        ]);
        brush
            .arg("--export-path")
            .arg(format!("{}/", exports.display()))
            .env("RUST_LOG", "info");
        let total = s.steps;
        let mut previewed = None;
        let result = self.run(brush, &mut |line| {
            let Some(iter) = refine_iter(line) else {
                return;
            };
            // Brush logs a step with each refine (every 200 steps) and stops refining at 95%.
            let what = if iter + 200 > total / 20 * 19 {
                "Finishing…".into()
            } else {
                format!("{} of {} steps", grouped(iter), grouped(total))
            };
            out.progress(train_work(iter) / train_work(total), &what);
            // Brush writes exports without logging it; one untouched for 2 s is complete.
            if let Some(path) = newest_ply(exports, Duration::from_secs(2))
                && previewed.as_ref() != Some(&path)
            {
                previewed = Some(path.clone());
                out.event(Event::Preview { path });
            }
        });
        let stopped = self.control.stopped();
        if result.is_err() && !stopped {
            return Err(brush_hint(&self.log_tail()).into());
        }
        // Brush doesn't write exports atomically, so a stopped run keeps the last one that settled.
        let newest = (if stopped {
            previewed
        } else {
            newest_ply(exports, Duration::ZERO)
        })
        .ok_or(if stopped {
            STOPPED
        } else {
            "Training finished without writing a scene."
        })?;
        fs::rename(newest, &scene).map_err(|e| e.to_string())?;
        // The other exports were only previews.
        let _ = fs::remove_dir_all(exports);
        Ok(())
    }

    /// A bundled tool if present, otherwise the bare name for a PATH lookup.
    fn cmd(&self, name: &str) -> Command {
        let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
        let bundled = self
            .tools
            .as_ref()
            .map(|dir| dir.join(file))
            .filter(|path| path.exists());
        #[cfg_attr(not(windows), allow(unused_mut))]
        let mut cmd = Command::new(bundled.unwrap_or_else(|| name.into()));
        // On Windows each console tool started by the app would open its own console window.
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000); // CREATE_NO_WINDOW
        cmd
    }

    /// Runs a command with its stdout and stderr lines appended to log.txt and passed to `on_line`
    /// (COLMAP reports on stderr, the others on stdout).
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

    /// Runs a command and returns stdout followed by stderr (COLMAP reports on stderr).
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

/// Up to `max` photos from `folder`, evenly spread over the name order. Exhaustive matching grows
/// with the square of the count, so this bounds COLMAP's time like the frame count does for video.
fn photos(folder: &Path, max: u32) -> Result<Vec<PathBuf>, String> {
    let mut photos: Vec<PathBuf> = fs::read_dir(folder)
        .map_err(|e| format!("Can't read {}: {e}", folder.display()))?
        .filter_map(|entry| Some(entry.ok()?.path()))
        .filter(|path| {
            path.extension().is_some_and(|ext| {
                PHOTO_EXTS.contains(&ext.to_string_lossy().to_lowercase().as_str())
            })
        })
        .collect();
    photos.sort();
    if photos.is_empty() {
        return Err("No photos found in this folder (jpg, png, heic, webp, tif).".into());
    }
    let n = photos.len().min(max as usize);
    Ok((0..n)
        .map(|i| photos[i * photos.len() / n].clone())
        .collect())
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

/// Newest .ply in `dir` that has not been modified for at least `settled`.
fn newest_ply(dir: &Path, settled: Duration) -> Option<PathBuf> {
    let now = SystemTime::now();
    fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "ply"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .filter(|(modified, _)| now.duration_since(*modified).unwrap_or_default() >= settled)
        .max()
        .map(|(_, path)| path)
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

/// Index of the sharpest (least blurred) of each of `keep` equal runs of candidates, or all of
/// them when there are no more than `keep`.
fn sharpest(blur: &[f64], keep: usize) -> Vec<usize> {
    let n = blur.len();
    if n <= keep {
        return (0..n).collect();
    }
    (0..keep)
        .map(|i| {
            (i * n / keep..(i + 1) * n / keep)
                .min_by(|&a, &b| blur[a].total_cmp(&blur[b]))
                .expect("runs are never empty when n > keep")
        })
        .collect()
}

/// COLMAP's progress counters: `[i/n]`, and `[i/n, j/m]` for exhaustive matching's blocks.
fn counter(line: &str) -> Option<f64> {
    let inside = line.rsplit_once('[')?.1.split_once(']')?.0;
    let mut counts = inside.split(", ").map(|part| {
        let (i, n) = part.split_once('/')?;
        Some((i.trim().parse::<f64>().ok()?, n.trim().parse::<f64>().ok()?))
    });
    let (i, n) = counts.next()??;
    Some(match counts.next() {
        Some(Some((j, m))) => (i - 1.0 + j / m) / n,
        _ => i / n,
    })
}

/// Seconds on an Apple M5 for COLMAP's features, matching and model with `n` images, from the
/// spike (exhaustive matching grows with the square of the count).
fn colmap_estimates(n: usize, video: bool, incremental: bool) -> [f64; 3] {
    let n = n as f64;
    [
        0.1 * n,
        if video { 0.26 * n } else { 0.022 * n * n },
        if incremental { 0.6 } else { 0.15 } * n + 3.0,
    ]
}

/// Brush's training time for `steps`, in units of its first step. A step costs more as the splats
/// grow, which they do until step 15,000, where a step costs 7 times the first. This matches the
/// spike's 30k run (2.3, 7.5, 14.7, 22.6 and 38 minutes at 5k, 10k, 15k, 20k and 30k) within 7%.
fn train_work(steps: u32) -> f64 {
    let (steps, grown) = (steps as f64, (steps as f64).min(15_000.0));
    steps + 6.0 * (grown * grown / 30_000.0 + steps - grown)
}

/// 4200 as "4,200".
fn grouped(n: u32) -> String {
    let digits = n.to_string();
    let mut text = String::new();
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            text.push(',');
        }
        text.push(digit);
    }
    text
}

/// Time left in words.
pub fn about(secs: u64) -> String {
    if secs < 60 {
        "less than a minute".into()
    } else {
        format!("about {} min", (secs + 30) / 60)
    }
}

/// Brush logs `Refine iter N, X splats.` every 200 steps; its progress bar is hidden when piped.
fn refine_iter(line: &str) -> Option<u32> {
    line.split("Refine iter ")
        .nth(1)?
        .split(',')
        .next()?
        .parse()
        .ok()
}

// The no-GPU text is from a real failure (`No possible adapter available for backend`).
// ponytail: the out-of-memory strings are guessed, refine from a real one
fn brush_hint(log_tail: &str) -> &'static str {
    let tail = log_tail.to_lowercase();
    if tail.contains("out of memory") || tail.contains("outofmemory") {
        "The GPU ran out of memory. Try a lower Detail setting."
    } else if tail.contains("adapter") {
        "No supported GPU found. SimpleSplat needs Metal (macOS) or Vulkan (Linux)."
    } else {
        "Training failed."
    }
}

/// The first frame's camera as SuperSplat viewer settings JSON, aimed at the median depth of
/// the scene in front of it. The viewer flips PLY data 180 degrees around Z, so x and y negate.
fn first_frame_view(cameras: &str, images: &str, points: &str) -> Option<String> {
    let rows = |text: &str| -> Vec<Vec<String>> {
        text.lines()
            .filter(|l| !l.starts_with('#'))
            .map(|l| l.split_whitespace().map(String::from).collect())
            .collect()
    };
    let num = |s: &String| s.parse::<f64>().ok();
    let image = rows(images)
        .into_iter()
        .filter(|r| r.len() == 10)
        .min_by(|a, b| a[9].cmp(&b[9]))?;
    let [w, x, y, z, tx, ty, tz] = std::array::from_fn(|i| num(&image[i + 1]).unwrap_or(0.0));
    let r = [
        [
            1. - 2. * (y * y + z * z),
            2. * (x * y - w * z),
            2. * (x * z + w * y),
        ],
        [
            2. * (x * y + w * z),
            1. - 2. * (x * x + z * z),
            2. * (y * z - w * x),
        ],
        [
            2. * (x * z - w * y),
            2. * (y * z + w * x),
            1. - 2. * (x * x + y * y),
        ],
    ];
    let t = [tx, ty, tz];
    let center: [f64; 3] = std::array::from_fn(|c| -(0..3).map(|k| r[k][c] * t[k]).sum::<f64>());
    let forward = r[2];

    let mut depths: Vec<f64> = rows(points)
        .iter()
        .filter_map(|p| Some([num(p.get(1)?)?, num(p.get(2)?)?, num(p.get(3)?)?]))
        .map(|p| (0..3).map(|i| (p[i] - center[i]) * forward[i]).sum::<f64>())
        .filter(|d| *d > 0.)
        .collect();
    depths.sort_by(f64::total_cmp);
    let depth = *depths.get(depths.len() / 2)?;

    let camera = rows(cameras)
        .into_iter()
        .find(|c| c.first() == image.get(8))?;
    let (height, params) = (num(camera.get(3)?)?, &camera[4..]);
    let focal = if camera[1].starts_with("SIMPLE") || camera[1] == "RADIAL" {
        num(params.first()?)?
    } else {
        num(params.get(1)?)?
    };
    let fov = (2. * (height / 2. / focal).atan()).to_degrees();
    let flip = |v: [f64; 3]| format!("[{}, {}, {}]", -v[0], -v[1], v[2]);
    let target = std::array::from_fn(|i| center[i] + forward[i] * depth);
    Some(format!(
        "{{\"position\": {}, \"target\": {}, \"fov\": {fov:.1}}}\n",
        flip(center),
        flip(target)
    ))
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
    fn photos_are_sorted_and_evenly_thinned() {
        let folder =
            std::env::temp_dir().join(format!("simplesplat-photos-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        for name in ["e.jpg", "a.JPG", "c.heic", "b.png", "d.jpg", "notes.txt"] {
            fs::write(folder.join(name), "").unwrap();
        }
        let names = |max| -> Vec<String> {
            let photos = photos(&folder, max).unwrap();
            photos
                .iter()
                .map(|p| p.file_name().unwrap().to_string_lossy().into())
                .collect()
        };
        assert_eq!(names(10), ["a.JPG", "b.png", "c.heic", "d.jpg", "e.jpg"]);
        assert_eq!(names(2), ["a.JPG", "c.heic"]);
        fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn brush_output_parsing() {
        assert_eq!(
            refine_iter("[2026-10-15T07:51:15Z INFO  brush_cli] Refine iter 4201, 237593 splats."),
            Some(4201)
        );
        assert_eq!(refine_iter("Training"), None);
        assert_eq!(
            brush_hint("wgpu error: Out of memory"),
            "The GPU ran out of memory. Try a lower Detail setting."
        );
        assert_eq!(Settings::detail("high").map(|s| s.steps), Some(30_000));
    }

    #[test]
    fn progress_parsing_and_estimates() {
        assert_eq!(sharpest(&[3., 1., 2., 5., 4., 6.], 2), [1, 4]);
        assert_eq!(sharpest(&[1., 2.], 5), [0, 1]);
        let colmap = "I20261015 14:07:38.4 0x1 feature_extraction.cc:120] Processed file [3/10]";
        assert_eq!(counter(colmap), Some(0.3));
        assert_eq!(
            counter("pairing.cc:9] Processing block [2/4, 1/2]"),
            Some(0.375)
        );
        assert_eq!(
            counter("[2026-10-15T07:51:15Z INFO  brush_cli] Starting up"),
            None
        );
        assert_eq!(counter("pose_graph.cc:51] Loaded 1345 edges"), None);
        // Spike: 5k and 15k steps of a 30k run took 6% and 39% of its time.
        let part = |steps| train_work(steps) / train_work(30_000);
        assert!((part(5_000) - 0.06).abs() < 0.01, "{}", part(5_000));
        assert!((part(15_000) - 0.39).abs() < 0.03, "{}", part(15_000));
        assert_eq!(grouped(4200), "4,200");
        assert_eq!(grouped(30_000), "30,000");
        assert_eq!(grouped(1_000_000), "1,000,000");
        assert_eq!(grouped(5), "5");
    }

    #[test]
    fn time_left_scales_with_the_speed_seen() {
        let mut sent = Vec::new();
        let mut emit = |event| sent.push(event);
        let mut out = Report::new(&mut emit, [10.0, 100.0, 890.0]);
        out.start(1, "frames", true);
        out.start(2, "colmap", false);
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

    #[test]
    fn first_frame_view_looks_from_frame_one_at_the_points() {
        // Identity rotation at the origin looks down +z; points at depth 2, 4 and 6.
        let cameras = "1 SIMPLE_RADIAL 720 1280 1000 360 640 0.01\n";
        let images = "2 1 0 0 0 0 0 0 1 0002.jpg\n\n1 1 0 0 0 0 0 0 1 0001.jpg\n\n";
        let points = "1 0 0 2 0 0 0 0\n2 0 0 4 0 0 0 0\n3 0 0 6 0 0 0 0\n4 0 0 -5 0 0 0 0\n";
        let view = first_frame_view(cameras, images, points).unwrap();
        assert!(view.contains("\"target\": [-0, -0, 4]"), "{view}");
        assert!(view.contains("\"fov\": 65.2"), "{view}");
    }
}
