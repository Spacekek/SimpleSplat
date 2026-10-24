//! The GPU Spirula trains on, and whether a run's memory fits on it.

use crate::pipeline::tool;
use crate::settings::{Quality, Settings};
use serde::Serialize;
use std::path::Path;

/// Peak memory of a training run: a fixed part, the splat buffers (sized for Max Splats up front),
/// and the per-pixel buffers of the image a step trains on. Measured on the M5 with Spirula
/// 2026.10.16 at step 1,000: 343 bytes per splat of the cap (1M, 3M and 10M agree) and 61 per pixel
/// (20 photos at full and half size); the splat x image scratch then grows by about 65 MiB per
/// million live splats (408 to 470 MiB over a 1M run). Rounded up for the high-water mark, which
/// sits above the steady pool, and the GPU context. Spirula's own forecast is no help before a run:
/// at step 1,000 it projected 1.6 GiB for that 1M run and 72 GiB for the 20 photos.
const FIXED_MIB: f64 = 300.0;
const BYTES_PER_SPLAT: f64 = 450.0;
const BYTES_PER_PIXEL: f64 = 100.0;

/// Peak memory of SfM: a fixed part and the features. Measured as the peak footprint of `spirula
/// sfm auto` on 1600 px frames (on a Mac that includes its GPU memory; elsewhere it is an upper
/// bound): 0.81 GiB for 150 at medium (614k features), 1.02 for 150 at high (1.09M) and 1.60 for
/// 300 at high (2.17M). The presets fill nearly every image to their feature limit.
const SFM_FIXED_MIB: f64 = 460.0;
const BYTES_PER_FEATURE: f64 = 570.0;

#[derive(Clone, Serialize)]
pub struct Gpu {
    pub name: String,
    /// Memory a run may use: the device's, or on macOS what Metal allows (less than the RAM).
    pub mib: u64,
}

/// The device Spirula picks (a discrete GPU before an integrated one), or None if it finds none.
pub fn detect(tools: Option<&Path>) -> Option<Gpu> {
    let out = tool(tools, "spirula")
        .args(["sam", "devices"])
        .output()
        .ok()?;
    parse(&(String::from_utf8_lossy(&out.stdout) + String::from_utf8_lossy(&out.stderr)))
}

/// `spirula sam devices` prints a table (`idx name type vram uuid status`); on macOS, MoltenVK
/// also logs `GPU memory available: 18186 MB`, Metal's working-set limit.
fn parse(text: &str) -> Option<Gpu> {
    let devices: Vec<(bool, Gpu)> = text.lines().filter_map(device).collect();
    let (_, gpu) = devices
        .iter()
        .find(|(discrete, _)| *discrete)
        .or(devices.first())?;
    let metal: Option<u64> = text
        .split("GPU memory available: ")
        .nth(1)
        .and_then(|rest| rest.split_whitespace().next()?.parse().ok());
    Some(Gpu {
        name: gpu.name.clone(),
        mib: metal.map_or(gpu.mib, |m| m.min(gpu.mib)),
    })
}

/// A usable device from a row of the `spirula sam devices` table, and whether it is discrete.
fn device(row: &str) -> Option<(bool, Gpu)> {
    let words: Vec<&str> = row.split_whitespace().collect();
    let indexed = words.first()?.parse::<u32>().is_ok();
    let ok = words.last() == Some(&"ok");
    let kind = words
        .iter()
        .position(|w| ["discrete", "integrated", "virtual", "cpu", "other"].contains(w))?;
    let size: f64 = words.get(kind + 1)?.parse().ok()?;
    let unit = if *words.get(kind + 2)? == "G" {
        1024.0
    } else {
        1.0
    };
    (indexed && ok).then(|| {
        let gpu = Gpu {
            name: words[1..kind].join(" "),
            mib: (size * unit) as u64,
        };
        (words[kind] == "discrete", gpu)
    })
}

/// The stage of a run that needs the most GPU memory.
pub struct Need {
    /// Its estimated peak.
    pub mib: u64,
    pub stage: &'static str,
    /// The settings that lower it.
    pub lower: &'static str,
}

pub fn need(s: &Settings) -> Need {
    let features = match s.sfm_quality {
        Quality::Low => 2048.0,
        Quality::Medium => 4096.0,
        Quality::High => 8192.0,
    } * s.frames as f64;
    let sfm = SFM_FIXED_MIB + features * BYTES_PER_FEATURE / 1048576.0;
    let pixels = (s.max_size as f64).powi(2) * 0.75; // a 4:3 image, the larger of the usual shapes
    let train =
        FIXED_MIB + (s.max_splats as f64 * BYTES_PER_SPLAT + pixels * BYTES_PER_PIXEL) / 1048576.0;
    if sfm > train {
        Need {
            mib: sfm as u64,
            stage: "Finding camera positions",
            lower: "Images to Use or Camera Position Quality",
        }
    } else {
        Need {
            mib: train as u64,
            stage: "Training",
            lower: "Max Splats, Max Image Size or Detail",
        }
    }
}

/// A warning when a run with `s` may not fit on `gpu`. The last tenth is kept free for the display
/// and other programs.
pub fn warning(s: &Settings, gpu: &Gpu) -> Option<String> {
    let need = need(s);
    (need.mib as f64 > 0.9 * gpu.mib as f64).then(|| {
        format!(
            "{} may need about {} of GPU memory, and {} has {}. If it fails, lower {}.",
            need.stage,
            gb(need.mib),
            gpu.name,
            gb(gpu.mib),
            need.lower
        )
    })
}

pub fn gb(mib: u64) -> String {
    format!("{:.1} GB", mib as f64 / 1024.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Detail;

    #[test]
    fn devices_and_estimates() {
        let mac = "[mvk-info] GPU device:\n\tmodel: Apple M5\n\tGPU memory available: 18186 MB\n\
            idx name                type        vram     uuid                         status\n\
            0   Apple M5            integrated    24.0 G uuid:0000106b1a05020a0000  ok\n";
        let gpu = parse(mac).unwrap();
        assert_eq!((gpu.name.as_str(), gpu.mib), ("Apple M5", 18186));
        let pc = "0   Intel(R) UHD Graphics 770   integrated    16.0 G uuid:aa  ok\n\
            1   NVIDIA GeForce RTX 3060   discrete    12.0 G uuid:bb  ok\n\
            2   llvmpipe   cpu    4.0 G uuid:cc  unsupported\n";
        let gpu = parse(pc).unwrap();
        assert_eq!(
            (gpu.name.as_str(), gpu.mib),
            ("NVIDIA GeForce RTX 3060", 12288)
        );
        assert!(parse("No Vulkan devices found.").is_none());

        // High: SfM about 1.8 GB (measured 1.6), training 1.7 GB.
        let mut s = Settings::detail(Detail::High);
        assert_eq!(need(&s).stage, "Finding camera positions");
        assert!(warning(&s, &gpu).is_none(), "{}", need(&s).mib);
        s.max_splats = 100_000_000;
        let text = warning(&s, &gpu).unwrap();
        assert!(text.starts_with("Training may need") && text.contains("RTX 3060 has 12.0 GB"));
        s.max_splats = 1_000_000;
        s.frames = 5000;
        assert!(warning(&s, &gpu).unwrap().contains("lower Images to Use"));
    }

    #[test]
    #[ignore = "needs src-tauri/tools (python3 scripts/bundle_tools.py) and a GPU: cargo test -- --ignored"]
    fn detects_the_gpu_with_the_bundled_spirula() {
        let tools = Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/bin");
        let gpu = detect(Some(&tools)).expect("Spirula found no GPU");
        println!("{} with {} MiB", gpu.name, gpu.mib);
        assert!(gpu.mib > 0);
    }
}
