//! Stage 3: Spirula trains the splat. Its checkpoints are the previews; the last becomes
//! `scene.ply`.

use super::{Event, Job, Report, STOPPED, Settings, spirula_hint};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Seconds per training step on an Apple M5 (15k steps of the test video took 11 minutes).
// ponytail: linear in steps from one run; the speed seen while training corrects it
const SECS_PER_STEP: f64 = 660.0 / 15_000.0;

/// Seconds on an Apple M5 for `steps` training steps.
pub(super) fn estimate(steps: u32) -> f64 {
    SECS_PER_STEP * steps as f64
}

pub(super) fn run(
    job: &mut Job<'_>,
    s: &Settings,
    exports: &Path,
    out: &mut Report<'_>,
) -> Result<(), String> {
    let scene = job.project.join("scene.ply");
    let _ = fs::remove_file(&scene);
    let mut spirula = job.cmd("spirula");
    spirula.args(["train", "3dgs", "--data"]).arg(&job.project);
    spirula.args([
        "--data-format",
        "colmap",
        "--colmap-recon-dir",
        "sparse/0",
        "--num-iterations",
        &s.steps.to_string(),
        "--steps-per-save",
        &s.export_every.unwrap_or(s.steps / 5).to_string(),
        "--cap-max",
        &s.max_splats.to_string(),
        "--floater-suppression",
        s.floater_suppression,
        "--distraction-robustness",
        s.ignore_moving,
        // The model is upright already, and the splats must stay in its frame.
        "--orientation-method",
        "none",
        "--center-method",
        "none",
        "--scene-center",
        "none",
        // Without these it serves a web viewer and keeps running after training.
        "--disable-viewer",
        "1",
        "--keep-viewer-alive",
        "0",
        "--output-dir-name",
        "exports",
    ]);
    spirula.arg("--output-dir-prefix").arg(&job.project);
    if !s.exposure_correction {
        spirula.args(["--use-bilateral-grid", "0", "--use-ppisp", "0"]);
    }
    let total = s.steps;
    let mut previewed = None;
    let result = job.run(spirula, &mut |line| {
        if let Some(text) = memory_warning(line) {
            out.event(Event::Info { text });
        }
        let Some(done) = step(line) else {
            return;
        };
        out.progress(
            done as f64 / total as f64,
            &format!("{} of {} steps", grouped(done), grouped(total)),
        );
        // Checkpoints are written without a line of their own; one untouched for 2 s is complete.
        if let Some(path) = newest_splat(exports, Duration::from_secs(2))
            && previewed.as_ref() != Some(&path)
        {
            previewed = Some(path.clone());
            out.event(Event::Preview { path });
        }
    });
    let stopped = job.control.stopped();
    if result.is_err() && !stopped {
        return Err(spirula_hint(&job.log_tail(), "Training failed.").into());
    }
    // Only the latest checkpoint is kept, so a stopped run's preview may have made way for a
    // newer one; that one is complete, since the old one goes once it is written.
    let newest = (if stopped {
        previewed
            .filter(|p| p.exists())
            .or_else(|| newest_splat(exports, Duration::from_secs(2)))
    } else {
        newest_splat(exports, Duration::ZERO)
    })
    .ok_or(if stopped {
        STOPPED
    } else {
        "Training finished without writing a scene."
    })?;
    fs::rename(newest, &scene).map_err(|e| e.to_string())?;
    // The rest is checkpoint state and settings.
    let _ = fs::remove_dir_all(exports);
    Ok(())
}

/// Spirula prints `step   2101/6000 ( 35%)  splats ...` every 100 steps, also when piped.
fn step(line: &str) -> Option<u32> {
    line.strip_prefix("step")?
        .split('/')
        .next()?
        .trim()
        .parse()
        .ok()
}

/// Spirula's warning when its forecast of the run's peak memory nears what is free, in plain words.
fn memory_warning(line: &str) -> Option<String> {
    let rest = line.split("training may run out of GPU memory.").nth(1)?;
    let after = |key: &str| {
        let value = rest.split(key).nth(1)?.split_whitespace().next()?;
        Some(value.trim_end_matches(['%', '.']).to_string())
    };
    Some(format!(
        "Training may run out of GPU memory: Spirula expects it to need about {} GB, with {} GB free ({}% chance of running out). If it fails, lower Max Splats or Detail, or close other programs using the GPU.",
        after("Projected peak: ")?,
        after("free for training: ")?,
        after("chance of running out: ")?
    ))
}

/// Newest checkpoint splat (`<dir>/step-N.ckpt/splat.ply`) not modified for at least `settled`.
fn newest_splat(dir: &Path, settled: Duration) -> Option<PathBuf> {
    let now = SystemTime::now();
    fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "ckpt"))
        .map(|e| e.path().join("splat.ply"))
        .filter_map(|path| Some((path.metadata().ok()?.modified().ok()?, path)))
        .filter(|(modified, _)| now.duration_since(*modified).unwrap_or_default() >= settled)
        .max()
        .map(|(_, path)| path)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_lines_and_grouping() {
        // As Spirula 2026.10.16 prints it, also when piped.
        let line =
            "step   2101/6000 ( 35%)  splats 23933  [elapsed 00:00:52.534 | ETA 00:02:43.365]";
        assert_eq!(step(line), Some(2101));
        assert_eq!(step("Training complete. Steps: 300"), None);
        let warning = "Warning: training may run out of GPU memory. Projected peak: 7.4 \u{b1} 0.6 GiB   free for training: 7.2 GiB   chance of running out: 64%. Lower --cap-max, or close other programs using the GPU.";
        assert!(
            memory_warning(warning)
                .unwrap()
                .contains("about 7.4 GB, with 7.2 GB free (64% chance")
        );
        assert_eq!(memory_warning(line), None);
        assert_eq!(grouped(4200), "4,200");
        assert_eq!(grouped(30_000), "30,000");
        assert_eq!(grouped(1_000_000), "1,000,000");
        assert_eq!(grouped(5), "5");
    }
}
