//! Input (video or photo folder) -> frames -> Spirula SfM -> Spirula training -> scene.ply, in
//! `<name>_splat/`.
//!
//! Each stage owns one folder plus a `.<folder>.stamp` naming everything that produced it. A
//! matching stamp skips the stage; a stamp includes the previous stage's, so changing an early
//! setting re-runs everything after it. Each stage is a module with a `run` entry point.

mod frames;
mod report;
mod sfm;
mod sfm_model;
mod tools;
mod train;

pub use report::Event;
pub use tools::{Control, tool};

use crate::settings::Settings;
use frames::Input;
use report::Report;
use std::fs::{self, File};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const STAGES: usize = 3;
pub const STOPPED: &str = "Stopped.";

/// Runs the whole pipeline and returns the path of the finished scene. Errors are plain language.
pub fn run(
    input: &Path,
    out: Option<&Path>,
    settings: &Settings,
    tools: Option<&Path>,
    control: &Control,
    emit: &mut dyn FnMut(Event),
) -> Result<PathBuf, String> {
    let input = fs::canonicalize(input).map_err(|_| format!("Can't find {}", input.display()))?;
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
    let _awake = crate::awake::keep_awake();
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
        path: &Path,
        s: &Settings,
        emit: &mut dyn FnMut(Event),
    ) -> Result<PathBuf, String> {
        let input = Input::open(self, path, s)?;
        let video = input.is_video();
        let single_camera = s.single_camera.unwrap_or(video);
        let images = input.images();
        let out = &mut Report::new(
            emit,
            [
                input.estimate(),
                sfm::estimate(images, s.sfm_quality),
                train::estimate(s.steps),
            ],
        );
        let frames_key = format!(
            "input={} {} frames={images} max_size={}",
            path.display(),
            fingerprint(input.files()),
            s.max_size
        );
        let label = if video {
            "Extracting frames"
        } else {
            "Preparing photos"
        };
        self.stage(0, label, "images", &frames_key, out, |job, dir, out| {
            frames::run(job, &input, s, dir, out)
        })?;

        let sfm_key = format!(
            "{frames_key} | spirula sfm video={video} single_camera={single_camera} quality={} up=-y",
            s.sfm_quality.arg()
        );
        self.stage(
            1,
            "Finding camera positions",
            "sparse",
            &sfm_key,
            out,
            |job, dir, out| sfm::run(job, video, single_camera, s.sfm_quality, dir, out),
        )?;

        let train_key = format!(
            "{sfm_key} | spirula train steps={} splats={} floaters={} moving={} exposure={}",
            s.steps,
            s.max_splats,
            s.floater_suppression.arg(),
            s.ignore_moving.arg(),
            s.exposure_correction
        );
        self.stage(
            2,
            "Training the splat",
            "exports",
            &train_key,
            out,
            |job, dir, out| train::run(job, s, dir, out),
        )?;

        if self.control.stopped() {
            out.event(Event::Info {
                text: "Stopped early: the result is the latest preview".into(),
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
        stage: usize,
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
        out.start(stage, name, skipped);
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
                .ok_or("No writable folder for the results")?
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

/// The plain-language error for a failed Spirula run, or `otherwise`.
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
            job.stage(0, "test", "out", key, out, |_, dir, _| {
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
    fn error_hints() {
        assert_eq!(
            spirula_hint(
                "vkAllocateMemory: VK_ERROR_OUT_OF_DEVICE_MEMORY",
                "Training failed"
            ),
            "The GPU ran out of memory. Try a lower Detail setting."
        );
        assert_eq!(spirula_hint("RESULT: FAILED", "Lost."), "Lost.");
    }
}
