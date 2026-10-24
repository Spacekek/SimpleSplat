//! Stage 2: camera positions from Spirula's SfM in `sparse/0`, turned upright (up = -Y), and
//! `view.json`, the viewer's first camera.

use super::{Event, Job, Quality, Report, spirula_hint};
use std::fs;
use std::path::Path;

pub(super) fn run(
    job: &mut Job<'_>,
    video: bool,
    single_camera: bool,
    quality: Quality,
    sparse: &Path,
    out: &mut Report<'_>,
) -> Result<(), String> {
    let (images, work) = (job.project.join("images"), job.project.join("sfm"));
    let _ = fs::remove_dir_all(&work);
    let _ = fs::remove_file(job.project.join("view.json")); // belongs to the old model
    let total = fs::read_dir(&images).map(|d| d.count()).unwrap_or(0);
    // Each step's share of the stage, by its estimated time.
    let parts = estimates(total, quality);
    let share = |step: usize, done: f64| {
        (parts[..step].iter().sum::<f64>() + parts[step] * done) / parts.iter().sum::<f64>()
    };
    let mut sfm = job.cmd("spirula");
    sfm.args(["sfm", "auto"]).arg(&images).arg("-o").arg(&work);
    sfm.args([
        "--data-type",
        if video { "video" } else { "individual" },
        "--quality",
        quality.arg(),
        "--camera-mode",
        if single_camera { "single" } else { "image" },
    ]);
    let mut placed = None;
    let result = job.run(sfm, &mut |line| {
        if let Some((step, done, what)) = progress(line, total) {
            out.progress(share(step, done), what);
        }
        if let Some(n) = line.split("Registered: ").nth(1) {
            placed = n.split('/').next().and_then(|n| n.parse::<usize>().ok());
        }
    });
    let model = sparse.join("0");
    if result.is_err() || fs::rename(work.join("sparse").join("0"), &model).is_err() {
        return Err(spirula_hint(
            &job.log_tail(),
            "Couldn't work out where the camera was. Film slower, keep more overlap between shots, and avoid plain or shiny surfaces.",
        )
        .into());
    }
    // Nothing reads the features and matches again: a re-run of this stage starts over.
    let _ = fs::remove_dir_all(&work);
    upright(&model)?;
    if let Some(placed) = placed {
        out.event(Event::Info {
            text: format!("Placed {placed} of {total} frames"),
        });
        if placed * 2 < total {
            out.event(Event::Info {
                text: "Many frames couldn't be placed, so the result may have holes".into(),
            });
        }
    }
    if let Some(view) = first_frame_view(&model) {
        let _ = fs::write(job.project.join("view.json"), view);
    }
    Ok(())
}

/// Step (0 features, 1 matching, 2 model), its fraction done and what it is busy with, from Spirula
/// SfM's `[extract] i/n name`, `[match] i/n pairs matched` and `[map] ... images in the model: k`.
fn progress(line: &str, total: usize) -> Option<(usize, f64, &'static str)> {
    let fraction = |text: &str| {
        let (i, n) = text.split_whitespace().next()?.split_once('/')?;
        Some(i.parse::<f64>().ok()? / n.parse::<f64>().ok()?)
    };
    if let Some(rest) = line.strip_prefix("[extract]") {
        Some((0, fraction(rest)?, "Finding features"))
    } else if let Some(rest) = line.strip_prefix("[match]") {
        Some((1, fraction(rest)?, "Matching features"))
    } else {
        let placed: f64 = line
            .split("images in the model: ")
            .nth(1)?
            .trim()
            .parse()
            .ok()?;
        Some((2, placed / total.max(1) as f64, "Building the 3D model"))
    }
}

/// Seconds on an Apple M5 for SfM with `n` images at `quality`.
pub(super) fn estimate(n: usize, quality: Quality) -> f64 {
    estimates(n, quality).iter().sum()
}

/// Seconds on an Apple M5 for Spirula SfM's features, matching and model with `n` images, from
/// the 150-frame test video at each preset (matching is almost all of it).
// ponytail: photos assumed to cost what video frames do; measure a photo set
fn estimates(n: usize, quality: Quality) -> [f64; 3] {
    let per_image = match quality {
        Quality::Low => [0.02, 0.6, 0.025],
        Quality::Medium => [0.035, 1.43, 0.06],
        Quality::High => [0.045, 2.6, 0.05],
    };
    per_image.map(|secs| secs * n as f64)
}

/// Reads little-endian values from COLMAP's binary model files.
struct Bin<'a>(&'a [u8], usize);

impl Bin<'_> {
    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let bytes = self.0.get(self.1..self.1 + N)?.try_into().ok()?;
        self.1 += N;
        Some(bytes)
    }

    fn u32(&mut self) -> Option<u32> {
        self.take().map(u32::from_le_bytes)
    }

    fn u64(&mut self) -> Option<u64> {
        self.take().map(u64::from_le_bytes)
    }

    fn skip(&mut self, n: usize) -> Option<()> {
        self.0.get(self.1..self.1 + n)?;
        self.1 += n;
        Some(())
    }
}

fn f64_at(data: &[u8], at: usize) -> f64 {
    f64::from_le_bytes(data[at..at + 8].try_into().expect("8 bytes"))
}

fn put_f64s(data: &mut [u8], at: usize, values: &[f64]) {
    for (i, v) in values.iter().enumerate() {
        data[at + 8 * i..at + 8 * i + 8].copy_from_slice(&v.to_le_bytes());
    }
}

/// images.bin: where each image's pose (qw qx qy qz tx ty tz) starts, its camera and its name.
fn image_records(data: &[u8]) -> Option<Vec<(usize, u32, String)>> {
    let mut r = Bin(data, 0);
    (0..r.u64()?)
        .map(|_| {
            r.skip(4)?; // image id
            let pose = r.1;
            r.skip(7 * 8)?;
            let camera = r.u32()?;
            let end = r.1 + data.get(r.1..)?.iter().position(|&b| b == 0)?;
            let name = String::from_utf8_lossy(&data[r.1..end]).into_owned();
            r.1 = end + 1;
            let points = r.u64()? as usize;
            r.skip(points * 24)?; // x, y, point id
            Some((pose, camera, name))
        })
        .collect()
}

/// points3D.bin: where each point's x y z starts.
fn point_records(data: &[u8]) -> Option<Vec<usize>> {
    let mut r = Bin(data, 0);
    (0..r.u64()?)
        .map(|_| {
            r.skip(8)?; // point id
            let xyz = r.1;
            r.skip(3 * 8 + 3 + 8)?; // x y z, r g b, error
            let track = r.u64()? as usize;
            r.skip(track * 8)?;
            Some(xyz)
        })
        .collect()
}

/// Turns Spirula's z-up model (ground at z = 0) to up = -Y, which the viewer and the planner
/// expect: a quarter turn about x, (x, y, z) -> (x, -z, y).
fn upright(model: &Path) -> Result<(), String> {
    let broken = || "The camera positions came out unreadable".to_string();
    let edit = |name: &str, change: &dyn Fn(&mut [u8]) -> Option<()>| {
        let path = model.join(name);
        let mut data = fs::read(&path).map_err(|e| e.to_string())?;
        change(&mut data).ok_or_else(broken)?;
        fs::write(&path, data).map_err(|e| e.to_string())
    };
    let s = std::f64::consts::FRAC_1_SQRT_2;
    edit("images.bin", &|data| {
        // A world-to-camera rotation q becomes q * conj(turn); the translation stays.
        for (at, _, _) in image_records(data)? {
            let [w, x, y, z] = std::array::from_fn(|i| f64_at(data, at + 8 * i));
            put_f64s(
                data,
                at,
                &[s * (w + x), s * (x - w), s * (y - z), s * (y + z)],
            );
        }
        Some(())
    })?;
    edit("points3D.bin", &|data| {
        for at in point_records(data)? {
            let [x, y, z] = std::array::from_fn(|i| f64_at(data, at + 8 * i));
            put_f64s(data, at, &[x, -z, y]);
        }
        Some(())
    })?;
    // It describes the z-up frame, which is gone.
    let _ = fs::remove_file(model.join("gauge.txt"));
    Ok(())
}

/// Parameter counts of COLMAP's camera models, by model id.
const PARAMS: [usize; 12] = [3, 4, 4, 5, 8, 8, 12, 5, 4, 5, 12, 16];

/// cameras.bin: camera `id`'s image height and focal length (fy).
fn camera_record(data: &[u8], id: u32) -> Option<(f64, f64)> {
    let mut r = Bin(data, 0);
    for _ in 0..r.u64()? {
        let (this, model) = (r.u32()?, r.u32()? as usize);
        r.skip(8)?; // width
        let height = r.u64()? as f64;
        let params = r.1;
        r.skip(8 * PARAMS.get(model)?)?;
        if this == id {
            // Models with one focal length (SIMPLE_*, RADIAL, RADIAL_FISHEYE) list it first; the
            // others list fx, then fy.
            let fy = usize::from(![0, 2, 3, 8, 9].contains(&model));
            return Some((height, f64_at(data, params + 8 * fy)));
        }
    }
    None
}

/// The first frame's camera as SuperSplat viewer settings JSON (view.json), aimed at the median
/// depth of the scene in front of it. The viewer flips PLY data 180 degrees around Z, so x and y
/// negate.
fn first_frame_view(model: &Path) -> Option<String> {
    let read = |name: &str| fs::read(model.join(name)).ok();
    let (cameras, images, points) = (
        read("cameras.bin")?,
        read("images.bin")?,
        read("points3D.bin")?,
    );
    let (at, camera, _) = image_records(&images)?
        .into_iter()
        .min_by(|a, b| a.2.cmp(&b.2))?;
    let [w, x, y, z, tx, ty, tz] = std::array::from_fn(|i| f64_at(&images, at + 8 * i));
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

    let mut depths: Vec<f64> = point_records(&points)?
        .iter()
        .map(|&at| {
            (0..3)
                .map(|i| (f64_at(&points, at + 8 * i) - center[i]) * forward[i])
                .sum::<f64>()
        })
        .filter(|d| *d > 0.)
        .collect();
    depths.sort_by(f64::total_cmp);
    let depth = *depths.get(depths.len() / 2)?;

    let (height, focal) = camera_record(&cameras, camera)?;
    let fov = (2. * (height / 2. / focal).atan()).to_degrees();
    let flip = |v: [f64; 3]| format!("[{}, {}, {}]", -v[0], -v[1], v[2]);
    let target = std::array::from_fn(|i| center[i] + forward[i] * depth);
    Some(format!(
        "{{\"position\": {}, \"target\": {}, \"fov\": {fov:.1}}}\n",
        flip(center),
        flip(target)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_parsing() {
        // Lines as Spirula 2026.10.16 prints them.
        assert_eq!(
            progress("[extract] 3/150   0003.jpg   Features: 5785", 150),
            Some((0, 0.02, "Finding features"))
        );
        assert_eq!(progress("[extract] Features: 5785", 150), None);
        assert_eq!(
            progress("[match]   2310/2520 pairs matched", 150).map(|p| p.0),
            Some(1)
        );
        assert_eq!(
            progress(
                "[map]     Registered image 12 (PnP inliers 300/400); images in the model: 75",
                150
            ),
            Some((2, 0.5, "Building the 3D model"))
        );
        assert_eq!(progress("[match]   Verifying on 9 thread(s)", 150), None);
    }

    #[test]
    fn upright_turns_z_up_into_y_down() {
        let model = std::env::temp_dir().join(format!("simplesplat-model-{}", std::process::id()));
        let _ = fs::remove_dir_all(&model);
        fs::create_dir_all(&model).unwrap();
        let f64s = |values: &[f64]| {
            values
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<u8>>()
        };
        // One pinhole camera; image 1 at the origin looking down +z (identity), with one 2D point.
        let mut cameras = 1u64.to_le_bytes().to_vec();
        cameras.extend([1u32.to_le_bytes(), 0u32.to_le_bytes()].concat()); // id 1, SIMPLE_PINHOLE
        cameras.extend([720u64.to_le_bytes(), 1280u64.to_le_bytes()].concat());
        cameras.extend(f64s(&[1000., 360., 640.]));
        let mut images = 1u64.to_le_bytes().to_vec();
        images.extend(1u32.to_le_bytes());
        images.extend(f64s(&[1., 0., 0., 0., 0., 0., 0.]));
        images.extend(1u32.to_le_bytes());
        images.extend(b"0001.jpg\0");
        images.extend(1u64.to_le_bytes());
        images.extend(f64s(&[1., 2.]));
        images.extend((-1i64).to_le_bytes());
        // Points 2, 4 and 6 in front of it, one with a track of one observation.
        let mut points = 3u64.to_le_bytes().to_vec();
        for (id, z) in [(1u64, 2.), (2, 4.), (3, 6.)] {
            points.extend(id.to_le_bytes());
            points.extend(f64s(&[0., 0., z]));
            points.extend([0u8, 0, 0]);
            points.extend(f64s(&[0.5]));
            points.extend(1u64.to_le_bytes());
            points.extend([1i32.to_le_bytes(), 0i32.to_le_bytes()].concat());
        }
        fs::write(model.join("cameras.bin"), cameras).unwrap();
        fs::write(model.join("images.bin"), images).unwrap();
        fs::write(model.join("points3D.bin"), points).unwrap();

        upright(&model).unwrap();
        let points = fs::read(model.join("points3D.bin")).unwrap();
        let xyz: Vec<[f64; 3]> = point_records(&points)
            .unwrap()
            .iter()
            .map(|&at| std::array::from_fn(|i| f64_at(&points, at + 8 * i)))
            .collect();
        assert_eq!(
            xyz,
            [[0., -2., 0.], [0., -4., 0.], [0., -6., 0.]],
            "up (+z) becomes -y"
        );
        // The camera still looks at the points: its view direction turned with them.
        let view = first_frame_view(&model).unwrap();
        let target: Vec<f64> = view
            .split("\"target\": [")
            .nth(1)
            .unwrap()
            .split(']')
            .next()
            .unwrap()
            .split(", ")
            .map(|v| v.parse().unwrap())
            .collect();
        // The viewer flips x and y, so (0, -4, 0) reads as (0, 4, 0).
        assert!(
            target
                .iter()
                .zip([0., 4., 0.])
                .all(|(a, b)| (a - b).abs() < 1e-9),
            "{view}"
        );
        assert!(view.contains("\"fov\": 65.2"), "{view}");
        fs::remove_dir_all(&model).unwrap();
    }
}
