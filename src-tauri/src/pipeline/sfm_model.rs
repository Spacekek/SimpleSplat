//! Reading and editing the model Spirula's SfM writes: cameras.bin, images.bin and points3D.bin,
//! in the binary layout COLMAP defined.

pub(super) struct ImageRecord {
    /// Where the world-to-camera pose (qw qx qy qz tx ty tz) starts.
    pub(super) pose_at: usize,
    pub(super) camera: u32,
    pub(super) name: String,
}

pub(super) fn image_records(data: &[u8]) -> Option<Vec<ImageRecord>> {
    let mut r = Bin::new(data);
    (0..r.u64()?)
        .map(|_| {
            r.skip(4)?; // image id
            let pose_at = r.pos;
            r.skip(7 * 8)?;
            let camera = r.u32()?;
            let name = r.text()?;
            let points = r.u64()? as usize;
            r.skip(points * 24)?; // x, y, point id
            Some(ImageRecord {
                pose_at,
                camera,
                name,
            })
        })
        .collect()
}

/// points3D.bin: where each point's x y z starts.
pub(super) fn point_records(data: &[u8]) -> Option<Vec<usize>> {
    let mut r = Bin::new(data);
    (0..r.u64()?)
        .map(|_| {
            r.skip(8)?; // point id
            let xyz_at = r.pos;
            r.skip(3 * 8 + 3 + 8)?; // x y z, r g b, error
            let track = r.u64()? as usize;
            r.skip(track * 8)?;
            Some(xyz_at)
        })
        .collect()
}

/// Parameter counts of the camera models, by model id.
const PARAMS: [usize; 12] = [3, 4, 4, 5, 8, 8, 12, 5, 4, 5, 12, 16];

/// cameras.bin: camera `id`'s image height and focal length (fy).
pub(super) fn camera_record(data: &[u8], id: u32) -> Option<(f64, f64)> {
    let mut r = Bin::new(data);
    for _ in 0..r.u64()? {
        let (this, model) = (r.u32()?, r.u32()? as usize);
        r.skip(8)?; // width
        let height = r.u64()? as f64;
        let params_at = r.pos;
        r.skip(8 * PARAMS.get(model)?)?;
        if this == id {
            // Models with one focal length (SIMPLE_*, RADIAL, RADIAL_FISHEYE) list it first; the
            // others list fx, then fy.
            let fy = usize::from(![0, 2, 3, 8, 9].contains(&model));
            let [focal] = f64s(data, params_at + 8 * fy);
            return Some((height, focal));
        }
    }
    None
}

/// `N` f64s from `data`, starting at byte `at`.
pub(super) fn f64s<const N: usize>(data: &[u8], at: usize) -> [f64; N] {
    std::array::from_fn(|i| {
        f64::from_le_bytes(data[at + 8 * i..][..8].try_into().expect("8 bytes"))
    })
}

pub(super) fn put_f64s(data: &mut [u8], at: usize, values: &[f64]) {
    for (i, v) in values.iter().enumerate() {
        data[at + 8 * i..][..8].copy_from_slice(&v.to_le_bytes());
    }
}

/// Reads little-endian values from the model files.
struct Bin<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Bin<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let bytes = self.data.get(self.pos..self.pos + N)?.try_into().ok()?;
        self.pos += N;
        Some(bytes)
    }

    fn u32(&mut self) -> Option<u32> {
        self.take().map(u32::from_le_bytes)
    }

    fn u64(&mut self) -> Option<u64> {
        self.take().map(u64::from_le_bytes)
    }

    fn skip(&mut self, n: usize) -> Option<()> {
        self.data.get(self.pos..self.pos + n)?;
        self.pos += n;
        Some(())
    }

    /// A NUL-terminated string.
    fn text(&mut self) -> Option<String> {
        let len = self.data.get(self.pos..)?.iter().position(|&b| b == 0)?;
        let text = String::from_utf8_lossy(&self.data[self.pos..self.pos + len]).into_owned();
        self.pos += len + 1;
        Some(text)
    }
}
