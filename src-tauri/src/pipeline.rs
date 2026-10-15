//! Input (video or photo folder) -> frames -> COLMAP -> Brush -> scene.ply, in `<name>_splat/`.
//!
//! Each stage owns one folder plus a `.<folder>.stamp` naming everything that produced it. A
//! matching stamp skips the stage; a stamp includes the previous stage's, so changing an early
//! setting re-runs everything after it.

use std::fs::{self, File};
use std::io::{BufRead, BufReader, ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Instant;

const STEPS: usize = 3;
const EXPORT_EVERY: u32 = 5_000;
const PHOTO_EXTS: [&str; 8] = ["jpg", "jpeg", "png", "heic", "heif", "webp", "tif", "tiff"];
const UNREADABLE: &str = "Couldn't read the input. Use a common video format (mp4, mov) or a folder of photos (jpg, png, heic).";

pub struct Settings {
    pub frames: u32,
    pub steps: u32,
    pub max_size: u32,
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
        })
    }
}

/// A bundled tool if present, otherwise the bare name for a PATH lookup.
pub fn tool(tools: Option<&Path>, name: &str) -> PathBuf {
    tools
        .map(|dir| dir.join(name))
        .filter(|path| path.exists())
        .unwrap_or_else(|| name.into())
}

/// Runs the whole pipeline and returns the path of the finished scene. Errors are plain language.
pub fn run(
    input: &Path,
    out: Option<&Path>,
    settings: &Settings,
    tools: Option<&Path>,
    progress: &mut dyn FnMut(&str),
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
    };
    let _awake = keep_awake();
    progress(&format!("Project folder: {}", job.project.display()));
    job.pipeline(&input, settings, progress)
        .map_err(|e| format!("{e}\nDetails: {}", log_path.display()))
}

struct Job {
    tools: Option<PathBuf>,
    project: PathBuf,
    log: File,
}

impl Job {
    fn pipeline(
        &mut self,
        input: &Path,
        s: &Settings,
        progress: &mut dyn FnMut(&str),
    ) -> Result<PathBuf, String> {
        let video = input.is_file();
        let frames_key = format!(
            "input={} frames={} max_size={}",
            input.display(),
            s.frames,
            s.max_size
        );
        let label = if video {
            "Extracting frames"
        } else {
            "Preparing photos"
        };
        self.stage(1, label, "images", &frames_key, progress, |job, dir, _| {
            job.frames(input, video, s, dir)
        })?;

        let colmap_key = format!("{frames_key} | colmap video={video}");
        self.stage(
            2,
            "Finding camera positions (COLMAP)",
            "sparse",
            &colmap_key,
            progress,
            |job, dir, progress| job.colmap(video, dir, progress),
        )?;

        let train_key = format!("{colmap_key} | steps={}", s.steps);
        self.stage(
            3,
            "Training the splat (Brush)",
            "exports",
            &train_key,
            progress,
            |job, dir, progress| job.train(s.steps, dir, progress),
        )?;

        progress("Done");
        Ok(self.project.join("scene.ply"))
    }

    fn stage(
        &mut self,
        n: usize,
        name: &str,
        dir: &str,
        key: &str,
        progress: &mut dyn FnMut(&str),
        work: impl FnOnce(&mut Self, &Path, &mut dyn FnMut(&str)) -> Result<(), String>,
    ) -> Result<(), String> {
        let stamp = self.project.join(format!(".{dir}.stamp"));
        if fs::read_to_string(&stamp).is_ok_and(|s| s == key) {
            progress(&format!("[{n}/{STEPS}] {name}: already done"));
            return Ok(());
        }
        progress(&format!("[{n}/{STEPS}] {name}"));
        let dir = self.project.join(dir);
        let _ = fs::remove_file(&stamp);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).map_err(|e| format!("Can't create {}: {e}", dir.display()))?;
        let start = Instant::now();
        work(self, &dir, progress)?;
        fs::write(&stamp, key).map_err(|e| format!("Can't write {}: {e}", stamp.display()))?;
        progress(&format!("      done in {}s", start.elapsed().as_secs()));
        Ok(())
    }

    fn frames(
        &mut self,
        input: &Path,
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
            ffmpeg
                .args([
                    "-vf",
                    &format!("fps={},{scale}", s.frames as f64 / duration),
                    "-q:v",
                    "2",
                ])
                .arg(dir.join("%04d.jpg"));
            return self.run(ffmpeg, &mut |_| {}).map_err(unreadable);
        }
        let mut photos: Vec<PathBuf> = fs::read_dir(input)
            .map_err(|e| format!("Can't read {}: {e}", input.display()))?
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
        for (i, photo) in photos.iter().enumerate() {
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
        sparse: &Path,
        progress: &mut dyn FnMut(&str),
    ) -> Result<(), String> {
        let (images, database, mapped) = (
            self.project.join("images"),
            self.project.join("database.db"),
            self.project.join("mapped"),
        );
        let _ = fs::remove_file(&database);
        let _ = fs::remove_dir_all(&mapped);
        let mut features = self.cmd("colmap");
        features
            .args(["feature_extractor", "--database_path"])
            .arg(&database)
            .arg("--image_path")
            .arg(&images);
        features.args([
            "--ImageReader.single_camera",
            if video { "1" } else { "0" },
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
            .args(["global_mapper", "--database_path"])
            .arg(&database)
            .arg("--image_path")
            .arg(&images)
            .arg("--output_path")
            .arg(&mapped);
        mapper.args([
            "--GlobalMapper.gp_use_gpu",
            "0",
            "--GlobalMapper.ba_ceres_use_gpu",
            "0",
        ]);
        let lost = "Couldn't work out where the camera was. Film slower, keep more overlap between shots, and avoid plain or shiny surfaces.";
        self.run(mapper, &mut |_| {})
            .map_err(|_| lost.to_string())?;
        if !mapped.join("0").exists() {
            return Err(lost.into());
        }

        // Upright: the viewer has no rotation control, so gravity is fixed in the data.
        fs::create_dir_all(sparse.join("0")).map_err(|e| e.to_string())?;
        let mut align = self.cmd("colmap");
        align
            .args(["model_orientation_aligner", "--image_path"])
            .arg(&images)
            .arg("--input_path")
            .arg(mapped.join("0"));
        align
            .arg("--output_path")
            .arg(sparse.join("0"))
            .args(["--method", "IMAGE-ORIENTATION"]);
        self.run(align, &mut |_| {})
            .map_err(|_| "COLMAP failed while straightening the scene.".to_string())?;
        let _ = fs::remove_dir_all(&mapped);

        let total = fs::read_dir(&images).map(|d| d.count()).unwrap_or(0);
        let analysis = self.capture(
            self.cmd("colmap")
                .arg("model_analyzer")
                .arg("--path")
                .arg(sparse.join("0")),
        )?;
        if let Some(placed) = analysis.lines().find_map(|l| {
            l.split("Registered images: ")
                .nth(1)?
                .trim()
                .parse::<usize>()
                .ok()
        }) {
            progress(&format!("      placed {placed} of {total} frames"));
            if placed * 2 < total {
                progress(
                    "      warning: many frames couldn't be placed, so the result may have holes",
                );
            }
        }
        Ok(())
    }

    fn train(
        &mut self,
        steps: u32,
        exports: &Path,
        progress: &mut dyn FnMut(&str),
    ) -> Result<(), String> {
        // Brush loads any .ply it finds in the project as starting splats; a previous result must go.
        let scene = self.project.join("scene.ply");
        let _ = fs::remove_file(&scene);
        let mut brush = self.cmd("brush-cli");
        brush.arg(&self.project).args([
            "--total-train-iters",
            &steps.to_string(),
            "--export-every",
            &EXPORT_EVERY.to_string(),
        ]);
        brush
            .arg("--export-path")
            .arg(format!("{}/", exports.display()))
            .env("RUST_LOG", "info");
        let mut shown = 0;
        let result = self.run(brush, &mut |line| {
            if let Some(iter) = refine_iter(line).filter(|i| i / 1000 > shown / 1000) {
                progress(&format!("      {iter}/{steps} steps"));
                shown = iter;
            }
        });
        if result.is_err() {
            return Err(brush_hint(&self.log_tail()).into());
        }
        // Export names pad {iter} to the width of the total, so pick the newest file instead of guessing.
        let newest = fs::read_dir(exports)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|x| x == "ply"))
            .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok())
            .ok_or("Training finished without writing a scene.")?;
        fs::rename(newest.path(), &scene).map_err(|e| e.to_string())
    }

    fn cmd(&self, name: &str) -> Command {
        Command::new(tool(self.tools.as_deref(), name))
    }

    /// Runs a command with stdout and stderr appended to log.txt; stdout lines also go to `on_line`.
    fn run(&mut self, mut cmd: Command, on_line: &mut dyn FnMut(&str)) -> Result<(), String> {
        let _ = writeln!(self.log, "\n$ {cmd:?}");
        let stderr = self.log.try_clone().map_err(|e| e.to_string())?;
        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(stderr)
            .spawn()
            .map_err(|e| format!("Can't start {:?}: {e}", cmd.get_program()))?;
        for line in BufReader::new(child.stdout.take().expect("piped stdout"))
            .lines()
            .map_while(Result::ok)
        {
            let _ = writeln!(self.log, "{line}");
            on_line(&line);
        }
        let status = child.wait().map_err(|e| e.to_string())?;
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
        let mut tail = String::new();
        if let Ok(mut f) = File::open(self.project.join("log.txt")) {
            let len = f.metadata().map(|m| m.len()).unwrap_or(0);
            let _ = f.seek(SeekFrom::Start(len.saturating_sub(8192)));
            let _ = f.read_to_string(&mut tail);
        }
        tail
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
        Err(e) if out.is_none() && e.kind() == ErrorKind::PermissionDenied => {
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
        let mut c = Command::new("systemd-inhibit");
        c.args([
            "--what=idle:sleep",
            "--who=SimpleSplat",
            "--why=Making a splat",
            "sleep",
            "infinity",
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
        let log = File::create(project.join("log.txt")).unwrap();
        let mut job = Job {
            tools: None,
            project: project.clone(),
            log,
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
        fs::remove_dir_all(&project).unwrap();
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
}
