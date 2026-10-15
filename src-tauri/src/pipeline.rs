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
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

pub const STAGES: usize = 3;
pub const STOPPED: &str = "Stopped.";
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
    Steps {
        iter: u32,
        total: u32,
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
        let frames_key = format!(
            "input={} {} frames={} max_size={}",
            input.display(),
            fingerprint(&files),
            if video {
                s.frames as usize
            } else {
                files.len()
            },
            s.max_size
        );
        let label = if video {
            "Extracting frames"
        } else {
            "Preparing photos"
        };
        self.stage(1, label, "images", &frames_key, emit, |job, dir, _| {
            job.frames(&files, video, s, dir)
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
            emit,
            |job, dir, emit| job.colmap(video, single_camera, s.incremental_mapper, dir, emit),
        )?;

        let train_key = format!("{colmap_key} | steps={}", s.steps);
        self.stage(
            3,
            "Training the splat",
            "exports",
            &train_key,
            emit,
            |job, dir, emit| job.train(s, dir, emit),
        )?;

        if self.control.stopped() {
            emit(Event::Info {
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
        emit: &mut dyn FnMut(Event),
        work: impl FnOnce(&mut Self, &Path, &mut dyn FnMut(Event)) -> Result<(), String>,
    ) -> Result<(), String> {
        if self.control.stopped() {
            return Err(STOPPED.into());
        }
        let stamp = self.project.join(format!(".{dir}.stamp"));
        let skipped = fs::read_to_string(&stamp).is_ok_and(|s| s == key);
        emit(Event::Stage {
            n,
            name: name.into(),
            skipped,
        });
        if skipped {
            return Ok(());
        }
        let dir = self.project.join(dir);
        let _ = fs::remove_file(&stamp);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).map_err(|e| format!("Can't create {}: {e}", dir.display()))?;
        let start = Instant::now();
        work(self, &dir, emit)?;
        // A stage cut short by Stop keeps its partial result but no stamp, so it re-runs next time.
        if !self.control.stopped() {
            fs::write(&stamp, key).map_err(|e| format!("Can't write {}: {e}", stamp.display()))?;
        }
        emit(Event::StageDone {
            n,
            secs: start.elapsed().as_secs(),
        });
        Ok(())
    }

    /// `files` is the video, or the photos to use.
    fn frames(
        &mut self,
        files: &[PathBuf],
        video: bool,
        s: &Settings,
        dir: &Path,
    ) -> Result<(), String> {
        let scale = format!(
            "scale=w='min({m},iw)':h='min({m},ih)':force_original_aspect_ratio=decrease",
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
            let mut ffmpeg = self.cmd("ffmpeg");
            ffmpeg
                .args(["-hide_banner", "-loglevel", "error", "-i"])
                .arg(input);
            // Never above the source rate: the fps filter would repeat frames to get there.
            ffmpeg
                .args([
                    "-vf",
                    &format!(
                        "fps='min(source_fps,{})',{scale}",
                        s.frames as f64 / duration
                    ),
                    "-q:v",
                    "2",
                ])
                .arg(dir.join("%04d.jpg"));
            return self.run(ffmpeg, &mut |_| {}).map_err(unreadable);
        }
        for (i, photo) in files.iter().enumerate() {
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
        emit: &mut dyn FnMut(Event),
    ) -> Result<(), String> {
        let (images, database, mapped) = (
            self.project.join("images"),
            self.project.join("database.db"),
            self.project.join("mapped"),
        );
        let _ = fs::remove_file(&database);
        let _ = fs::remove_dir_all(&mapped);
        let _ = fs::remove_file(self.project.join("view.json")); // belongs to the old model
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
        self.run(features, &mut |_| {})
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
        self.run(matcher, &mut |_| {})
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
        self.run(mapper, &mut |_| {})
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

        let total = fs::read_dir(&images).map(|d| d.count()).unwrap_or(0);
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
            emit(Event::Info {
                text: format!("Placed {placed} of {total} frames."),
            });
            if placed * 2 < total {
                emit(Event::Info {
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

    fn train(
        &mut self,
        s: &Settings,
        exports: &Path,
        emit: &mut dyn FnMut(Event),
    ) -> Result<(), String> {
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
            emit(Event::Steps { iter, total });
            // Brush writes exports without logging it; one untouched for 2 s is complete.
            if let Some(path) = newest_ply(exports, Duration::from_secs(2))
                && previewed.as_ref() != Some(&path)
            {
                previewed = Some(path.clone());
                emit(Event::Preview { path });
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
        let bundled = self
            .tools
            .as_ref()
            .map(|dir| dir.join(name))
            .filter(|path| path.exists());
        Command::new(bundled.unwrap_or_else(|| name.into()))
    }

    /// Runs a command with stdout and stderr appended to log.txt; stdout lines also go to `on_line`.
    fn run(&mut self, mut cmd: Command, on_line: &mut dyn FnMut(&str)) -> Result<(), String> {
        if self.control.stopped() {
            return Err(STOPPED.into());
        }
        let _ = writeln!(self.log, "\n$ {cmd:?}");
        let stderr = self.log.try_clone().map_err(|e| e.to_string())?;
        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(stderr)
            .spawn()
            .map_err(|e| format!("Can't start {:?}: {e}", cmd.get_program()))?;
        let stdout = child.stdout.take().expect("piped stdout");
        *self.control.child.lock().unwrap() = Some(child);
        // A stop that came before the child was registered had nothing to kill.
        if self.control.stopped() {
            self.control.stop();
        }
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
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

/// Brush logs `Refine iter N, X splats.` every 200 steps; its progress bar is hidden when piped.
fn refine_iter(line: &str) -> Option<u32> {
    line.split("Refine iter ")
        .nth(1)?
        .split(',')
        .next()?
        .parse()
        .ok()
}

// ponytail: guessed error strings, refine from real GPU failures
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
    }
}

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
            job.stage(1, "test", "out", key, &mut |_| {}, |_, dir, _| {
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
