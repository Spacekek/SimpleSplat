//! Stage 1: the video's sharpest frames, or the photos, as upright SDR JPEGs of at most
//! `max_size` pixels in `images/`.

use super::{Event, Job, Report, Settings};
use std::fs;
use std::path::{Path, PathBuf};

/// Video candidates per frame kept: each kept frame is the sharpest of its group.
const CANDIDATES: usize = 3;

const PHOTO_EXTS: [&str; 8] = ["jpg", "jpeg", "png", "heic", "heif", "webp", "tif", "tiff"];

const UNREADABLE: &str = "Couldn't read the input. Use a common video format (mp4, mov) or a folder of photos (jpg, png, heic).";

/// What the images are made from.
pub(super) enum Input {
    /// `frames` frames taken from a video of `secs` seconds.
    Video {
        path: PathBuf,
        secs: f64,
        frames: usize,
    },
    /// The photos used from a folder.
    Photos(Vec<PathBuf>),
}

impl Input {
    /// A video file, or the photos in a folder: as many images as `s` allows.
    pub(super) fn open(job: &mut Job<'_>, path: &Path, s: &Settings) -> Result<Self, String> {
        if path.is_file() {
            let secs = video_length(job, path)?;
            Ok(Self::Video {
                path: path.to_path_buf(),
                secs,
                frames: video_frames(secs, s.fps, s.frames),
            })
        } else {
            pick_photos(path, s.frames).map(Self::Photos)
        }
    }

    pub(super) fn is_video(&self) -> bool {
        matches!(self, Self::Video { .. })
    }

    /// How many images the stage makes.
    pub(super) fn images(&self) -> usize {
        match self {
            Self::Video { frames, .. } => *frames,
            Self::Photos(photos) => photos.len(),
        }
    }

    pub(super) fn files(&self) -> &[PathBuf] {
        match self {
            Self::Video { path, .. } => std::slice::from_ref(path),
            Self::Photos(photos) => photos,
        }
    }

    /// Seconds on an Apple M5 to make the images.
    pub(super) fn estimate(&self) -> f64 {
        let per_image = if self.is_video() { 0.025 } else { 0.15 };
        self.images() as f64 * per_image
    }
}

pub(super) fn run(
    job: &mut Job<'_>,
    input: &Input,
    s: &Settings,
    dir: &Path,
    out: &mut Report<'_>,
) -> Result<(), String> {
    match input {
        Input::Video { path, secs, frames } => {
            extract_frames(job, path, *secs, *frames, s.max_size, dir, out)
        }
        Input::Photos(photos) => convert_photos(job, photos, s.max_size, dir, out),
    }
}

fn extract_frames(
    job: &mut Job<'_>,
    video: &Path,
    secs: f64,
    frames: usize,
    max_size: u32,
    dir: &Path,
    out: &mut Report<'_>,
) -> Result<(), String> {
    if (frames as f64) < secs {
        out.event(Event::Info {
            text: format!(
                "A long video: about one frame every {:.0} seconds. If the result has holes, raise Max Images.",
                secs / frames as f64
            ),
        });
    }
    // Candidates at CANDIDATES times the frame rate (never above the source's: the fps filter
    // would repeat frames), each scored by blurdetect; the sharpest of each group is kept.
    let candidates = CANDIDATES * frames;
    let mut ffmpeg = job.cmd("ffmpeg");
    ffmpeg
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(video);
    ffmpeg
        .args([
            "-vf",
            &format!(
                "fps='min(source_fps,{})',{},blurdetect,metadata=print:key=lavfi.blur:file='pipe\\:1'",
                candidates as f64 / secs,
                scale_filter(max_size)
            ),
            "-q:v",
            "2",
        ])
        .arg(dir.join("candidate-%05d.jpg"));
    let mut blur = Vec::new();
    job.run_tool(ffmpeg, &mut |line| {
        if let Some(value) = line.strip_prefix("lavfi.blur=") {
            blur.push(value.trim().parse().unwrap_or(f64::MAX));
            let done = blur.len() as f64 / candidates as f64;
            out.progress(done, "Picking the sharpest frames");
        }
    })
    .map_err(|_| UNREADABLE.to_string())?;

    let candidate = |i: usize| dir.join(format!("candidate-{:05}.jpg", i + 1));
    let count = (0..).take_while(|&i| candidate(i).exists()).count();
    if blur.len() != count {
        blur = vec![0.0; count]; // no scores: evenly spaced frames
    }
    let keep = sharpest(&blur, frames);
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
    Ok(())
}

fn convert_photos(
    job: &mut Job<'_>,
    photos: &[PathBuf],
    max_size: u32,
    dir: &Path,
    out: &mut Report<'_>,
) -> Result<(), String> {
    let decoded = dir.join("decoded.png");
    for (i, photo) in photos.iter().enumerate() {
        out.progress(
            i as f64 / photos.len() as f64,
            &format!("Photo {} of {}", i + 1, photos.len()),
        );
        // Tiled HEIC is stitched by an internal filter graph that can't be combined with -vf.
        let heic = photo.extension().is_some_and(|ext| {
            ext.eq_ignore_ascii_case("heic") || ext.eq_ignore_ascii_case("heif")
        });
        if heic {
            let mut decode = job.cmd("ffmpeg");
            decode
                .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
                .arg(photo)
                .arg(&decoded);
            job.run_tool(decode, &mut |_| {})
                .map_err(|_| UNREADABLE.to_string())?;
        }
        let mut ffmpeg = job.cmd("ffmpeg");
        ffmpeg
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(if heic { &decoded } else { photo });
        ffmpeg
            .args(["-vf", &scale_filter(max_size), "-q:v", "2"])
            .arg(dir.join(format!("{:04}.jpg", i + 1)));
        job.run_tool(ffmpeg, &mut |_| {})
            .map_err(|_| UNREADABLE.to_string())?;
    }
    let _ = fs::remove_file(decoded);
    Ok(())
}

/// ffmpeg's filter that fits an image within `max_size` pixels and turns it into SDR BT.709. That
/// leaves SDR as it is; phone HDR video (HLG or PQ in BT.2020) would otherwise come out washed out.
fn scale_filter(max_size: u32) -> String {
    format!(
        "scale=w='min({max_size},iw)':h='min({max_size},ih)':force_original_aspect_ratio=decrease\
         :out_primaries=bt709:out_transfer=bt709:out_color_matrix=bt709"
    )
}

/// How many frames a video of `secs` gives: `fps` a second, but at least half of `max` (short
/// videos stay dense) and at most `max` (long ones stay affordable).
fn video_frames(secs: f64, fps: f32, max: u32) -> usize {
    ((secs * fps as f64).round() as usize).clamp(max as usize / 2, max as usize)
}

/// A video's length in seconds.
fn video_length(job: &mut Job<'_>, video: &Path) -> Result<f64, String> {
    // Without an output, ffmpeg describes the input (its duration included) and fails.
    let probe = job.tool_output(job.cmd("ffmpeg").arg("-hide_banner").arg("-i").arg(video))?;
    duration(&probe).ok_or_else(|| UNREADABLE.to_string())
}

/// Up to `max` photos from `folder`, evenly spread over the name order. Matching photos grows
/// faster than their count, so this bounds SfM's time like the frame count does for video.
fn pick_photos(folder: &Path, max: u32) -> Result<Vec<PathBuf>, String> {
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
        return Err("No photos found in this folder (jpg, png, heic, webp, tif)".into());
    }
    let n = photos.len().min(max as usize);
    Ok((0..n)
        .map(|i| photos[i * photos.len() / n].clone())
        .collect())
}

/// Seconds in ffmpeg's `Duration: 00:01:19.65,` line; None for `Duration: N/A`.
fn duration(probe: &str) -> Option<f64> {
    let hms = probe.split("Duration: ").nth(1)?.split(',').next()?;
    hms.split(':').try_fold(0.0, |secs, part| {
        Some(secs * 60.0 + part.parse::<f64>().ok()?)
    })
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

#[cfg(test)]
mod tests {
    use super::*;

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
            let photos = pick_photos(&folder, max).unwrap();
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
    fn frames_per_second_with_a_floor_and_a_cap() {
        // Medium: 3 a second, at least 150, at most 300.
        assert_eq!(
            video_frames(20.0, 3.0, 300),
            150,
            "a short clip keeps the floor"
        );
        assert_eq!(video_frames(70.0, 3.0, 300), 210);
        assert_eq!(
            video_frames(600.0, 3.0, 300),
            300,
            "a long video stops at the cap"
        );
    }

    #[test]
    fn sharpest_frames_and_duration() {
        assert_eq!(sharpest(&[3., 1., 2., 5., 4., 6.], 2), [1, 4]);
        assert_eq!(sharpest(&[1., 2.], 5), [0, 1]);
        let probe =
            "Input #0, mov,mp4\n  Duration: 00:01:19.65, start: 0.000000, bitrate: 4221 kb/s";
        assert!((duration(probe).unwrap() - 79.65).abs() < 1e-9);
        assert_eq!(duration("  Duration: N/A, bitrate: N/A"), None);
    }
}
