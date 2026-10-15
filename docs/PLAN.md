# SimpleSplat plan

A desktop app that turns a phone video or a folder of photos into a Gaussian splat with one button, and shows it in a 3D viewer. Runs on macOS and Linux first, Windows later. Uses the GPU on any vendor (Apple, NVIDIA, AMD, Intel); no CUDA required.

## Pipeline

```
input: one video OR one photo folder (auto-detected)
  -> ffmpeg       N frames evenly spaced (video) or every photo, long side <= 1600 px, JPEG -> images/
  -> colmap       feature_extractor (single camera for video)
  -> colmap       exhaustive_matcher
  -> colmap       mapper, global (exact command confirmed in spike)   -> sparse/
  -> colmap       model_orientation_aligner (scene comes out upright)
  -> brush        train, export every 5k steps                         -> scene.ply
  -> viewer       Spark (three.js), orbit around the median splat
```

Each step is a separate process with its own progress line in the UI and its own plain-language error message. No undistortion step: Brush reads COLMAP distortion models directly (to be verified on the pinned commit).

### Project folder

Written next to the input as `<name>_splat/` (falls back to the app data folder if that location is not writable). Everything is kept, and a re-run skips steps whose output already exists, so changing Detail only re-trains.

```
<name>_splat/
  images/        normalized frames/photos
  database.db    COLMAP features and matches
  sparse/        COLMAP model
  *.ply          periodic exports and final scene
  log.txt        output of every step
```

## Decisions

### Product
- **Main screen is one button.** Drop an input, press Go.
- **Settings screen.** Simple: Detail (Low/Medium/High) and output location. Advanced, collapsed at the bottom: frame count, max image size, training steps, preview export interval, single camera, mapper (global/incremental), keep intermediates, open log folder.
- **Detail presets:** frames 100/150/300, training steps about 10k/20k/30k (tuned in the spike).
- **Live preview:** the viewer reloads each periodic export; Stop kills Brush and keeps the latest export.
- **One job at a time.** Cancel kills the current step (finished steps stay). Quitting kills running tools. The machine is kept awake during a job (`caffeinate` on macOS, `systemd-inhibit` on Linux). A system notification fires on finish or failure.
- **GPU failures** are translated, not prevented: "no supported GPU" (needs Metal or Vulkan) and "out of memory" (lower Detail). No startup check unless Brush offers a cheap one.

### Tools and where they come from
| Tool | Source | Why |
|---|---|---|
| ffmpeg | conda-forge (9.x, LGPL) | Reads iPhone tiled HEIC (needs ffmpeg 8.1+); same bundle as COLMAP |
| COLMAP | conda-forge (4.2.x, CPU build pinned with `colmap=*=cpu*`) | Current version on every OS, no compiling; conda prefers the CUDA build on NVIDIA hosts unless pinned |
| Brush | cargo build of a pinned git commit, run as a sidecar | Current code (the last release is from Sep 2025); a crash or GPU out-of-memory does not take the app down |

ffmpeg and COLMAP are installed with `micromamba` into one folder that ships as a Tauri resource. The bundle step trims headers, static libraries and docs, and collects every package's license into `THIRD_PARTY_LICENSES/`. The app looks for tools in its bundled folder first, then on `PATH`.

### App
- **Tauri** with **Vite + vanilla TypeScript** (no framework). Four views: Home, Progress, Viewer, Settings.
- **Viewer:** Spark (`@sparkjsdev/spark`) on three.js.
- **Update notice:** at startup, compare the app version with GitHub's latest release tag and show a download link if newer. No in-place updater.

### Nix
- `flake.nix` provides the development environment: Rust, cargo-tauri, Node, micromamba, and WebKitGTK and friends on Linux.
- A Nix package for NixOS: COLMAP and ffmpeg from nixpkgs (version recent enough for the global mapper), Brush built with `rustPlatform` at the same pin, wrapped so these come first on `PATH`. Note that nixpkgs `brush` is an unrelated shell.
- Release builds for macOS, `.deb` and `.rpm` do not use Nix-built binaries.

### Packaging
- **macOS (arm64):** ad-hoc signed for now. Before a public release: Developer ID, sign every bundled dylib with hardened runtime, notarize.
- **Linux (x64):** `.deb` and `.rpm` (system WebKitGTK, so WebGL uses the real drivers), plus the Nix package. Flatpak later (NVIDIA works through the matching GL extension).
- **Size budget:** about 500 MB compressed installer. If the trimmed conda bundle exceeds that, build a headless COLMAP ourselves.
- **Windows:** later. conda-forge has `win-64` builds of both tools, Brush builds with cargo, WebView2 handles WebGL.

### Quality
- Rust unit tests for pure logic: frame sampling math, error text to message mapping, step skipping.
- A tiny dataset in the repo (about 20 photos of one object, 400 px).
- CI on every push: full pipeline on Linux with Brush at about 100 steps on Mesa lavapipe (software Vulkan); on macOS, ffmpeg and COLMAP run from the moved conda bundle.
- Before each release: real phone videos on real hardware (Apple Silicon, NVIDIA Linux, AMD or Intel Linux).

### License
Public repo, Apache-2.0. Bundled tools run as separate programs: Brush (Apache-2.0), COLMAP (BSD), ffmpeg (LGPL), and COLMAP dependencies including GPL parts of SuiteSparse. Their licenses and source pointers ship in `THIRD_PARTY_LICENSES/`.

## Spike checklist (macOS, by hand)

- [ ] `micromamba create` ffmpeg + COLMAP (CPU pin), **move the folder**, and confirm both still run
- [ ] ffmpeg decodes an iPhone HEVC video and a tiled HEIC photo
- [ ] COLMAP 4.2: exact global mapper command, `model_orientation_aligner` still exists, progress lines worth parsing
- [ ] Brush at a pinned commit: training and export flags, periodic export, progress output, any cheap GPU probe, distortion model handling
- [ ] Time per Detail preset on an Apple Silicon Mac; pick the step counts
- [ ] Bundle size installed and compressed, before and after trimming

## Build order

1. Mac spike (checklist above) with a real 20 to 40 s phone video walking around one object.
2. Scaffold: `flake.nix`, Tauri vanilla-ts app, bundle script.
3. Mac app end to end: all four views, notifications, update notice.
4. CI: test dataset, unit tests, smoke runs, release builds.
5. Linux `.deb` and `.rpm`, tested on NVIDIA and on AMD or Intel.
6. Nix package for NixOS.
7. Later: notarization, Flatpak, Windows, sharpest-frame selection, multiple videos per scene.
