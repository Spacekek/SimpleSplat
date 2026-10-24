//! The Detail presets, and the settings a run uses.

use serde::{Deserialize, Serialize};

/// What a run uses: a Detail preset, with any advanced overrides. The UI shows each preset's values
/// as the defaults, so this is their one source, and sends them back with its overrides applied.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// The most images used: photos from a folder, or frames from a video.
    pub frames: u32,
    /// Frames taken per second of video, between half of `frames` and `frames`.
    pub fps: f32,
    pub steps: u32,
    pub max_size: u32,
    /// Steps between exports (previews). None: a fifth of the steps.
    pub export_every: Option<u32>,
    /// None: one camera for video, one per photo otherwise.
    pub single_camera: Option<bool>,
    /// Spirula's SfM preset (image size, features, pairs).
    pub sfm_quality: Quality,
    /// The most splats training may grow to.
    pub max_splats: u32,
    /// Spirula's floater suppression and distraction robustness.
    pub floater_suppression: Level,
    pub ignore_moving: Level,
    /// Per-frame exposure and colour correction (PPISP and a bilateral grid).
    pub exposure_correction: bool,
    pub keep_intermediates: bool,
}

/// The Detail presets, from quickest to best looking.
#[derive(Clone, Copy, clap::ValueEnum)]
pub enum Detail {
    Low,
    Medium,
    High,
}

// Quality and Level are passed on to Spirula as arguments, so only its own values get through.
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Low,
    Medium,
    High,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Off,
    Mild,
    Strong,
}

impl Quality {
    pub fn arg(self) -> &'static str {
        match self {
            Quality::Low => "low",
            Quality::Medium => "medium",
            Quality::High => "high",
        }
    }
}

impl Level {
    pub fn arg(self) -> &'static str {
        match self {
            Level::Off => "off",
            Level::Mild => "mild",
            Level::Strong => "strong",
        }
    }
}

impl Settings {
    pub fn detail(detail: Detail) -> Self {
        // A video gives `fps` frames a second, but at least half of `frames` (short clips still get
        // 100/150/300) and at most `frames` (long ones stay affordable).
        let (frames, fps, steps, sfm_quality, max_splats) = match detail {
            // Spirula adds at most about 10% splats per 100 steps until 2,500 before the end:
            // on the test video 5k steps ended at 58k splats, 10k at 670k.
            Detail::Low => (200, 2.0, 10_000, Quality::Low, 1_000_000),
            Detail::Medium => (300, 3.0, 15_000, Quality::Medium, 1_000_000),
            // Spirula's own high preset; its low one (200k) saved Low no time, 5:04 for 5:19.
            Detail::High => (600, 5.0, 30_000, Quality::High, 3_000_000),
        };
        Self {
            frames,
            fps,
            steps,
            max_size: 1600,
            export_every: None,
            single_camera: None,
            sfm_quality,
            max_splats,
            // Better on every score in the settings tests, for 8% more training time.
            floater_suppression: Level::Mild,
            ignore_moving: Level::Off,
            exposure_correction: true,
            keep_intermediates: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets() {
        assert_eq!(Settings::detail(Detail::High).steps, 30_000);
    }
}
