# SimpleSplat plan

A desktop app that turns a phone video or a folder of photos into a Gaussian splat with one button, and shows it in a 3D viewer. Runs on macOS, Linux and Windows. Uses the GPU on any vendor (Apple, NVIDIA, AMD, Intel); no CUDA required.

## Pipeline

```
input: one video OR one photo folder (auto-detected)
  -> ffmpeg       N frames (video: the sharpest of every 3 candidates by blurdetect, never above its frame rate)
                  or at most N photos evenly spread; long side <= 1600 px, SDR BT.709, upright, JPEG -> images/
                  (tiled HEIC: decode in one call, resize in a second; ffmpeg can't combine them)
  -> colmap       feature_extractor --ImageReader.single_camera 1 (video) --FeatureExtraction.use_gpu 0
  -> colmap       sequential_matcher (video) | exhaustive_matcher (photos)
  -> colmap       global_mapper                                        -> sparse/0
  -> colmap       model_orientation_aligner MANHATTAN-WORLD, falling back to IMAGE-ORIENTATION  -> up = -Y
  -> brush        train, export 5 times                                -> exports/*.ply
  -> viewer       SuperSplat viewer (PlayCanvas), upright with no extra rotation
```

Each step is a separate process with its own progress line in the UI and its own plain-language error message. No undistortion step: Brush reads COLMAP distortion models (`SIMPLE_RADIAL` here) and finds `sparse/0` in the project folder by itself.

### Project folder

Written next to the input as `<name>_splat/` (falls back to the app data folder if that location is not writable). Everything is kept. Each stage writes a hidden `.<folder>.stamp` with the settings that produced it (and the input's size and modification time), including the previous stage's stamp: a re-run skips stages whose stamp matches, and changing a setting re-runs that stage and everything after it. Changing training steps only re-trains; changing Detail also changes the frame count, so it redoes everything.

```
<name>_splat/
  scene.ply      the result
  images/        normalized frames/photos
  sparse/0/      COLMAP model, aligned upright
  exports/       Brush exports while training (the last one becomes scene.ply, the rest are deleted)
  log.txt        output of every tool
  .*.stamp       what produced each stage
```

Brush loads any `.ply` in the folder it trains on as starting splats, so training deletes the old `scene.ply` and `exports/` first. Brush also writes a `Vertical axis` comment into its PLY; it is a guess (it said +Z for a scene that is -Y up) and the SuperSplat viewer ignores it.

## Decisions

### Product
- **Main screen is one button.** Drop an input, press Go.
- **Settings screen.** Simple: Detail (Low/Medium/High) and output location. Advanced, collapsed at the bottom: frame count, max image size, training steps, preview export interval, single camera, mapper (global/incremental), keep intermediates, open log folder.
- **Detail presets:** frames 100/150/300, training steps 5k/15k/30k. On an M5 with 150 frames that is about 2.5/15/38 minutes of training plus about 1 minute of COLMAP.
- **Preview during training:** a still image, not a live viewer. An idle SuperSplat viewer keeps rendering at 60 fps and slowed training by 16% in the spike. For each export, load it, `captureFrame()`, `destroy()` the viewer and show the image (cost: a few seconds per preview). An "Explore" button opens the live viewer and says training is slower while it is open. Stop kills Brush and keeps the latest complete export.
- **Progress:** each stage shows a bar and what it is busy with; the header shows the whole job and the time left. Sources: blurdetect's per-frame lines (video), the photo count, COLMAP's `[i/n]` counters (features, matching; `[i/n, j/m]` for exhaustive blocks), time against the estimate for the mapper (it has no counter), and Brush's `Refine iter N` lines, which stop at 95% ("Finishing…"). Each stage has an estimate from the M5 timings below; Brush's assumes a step costs more as splats grow, up to 7 times the first step's cost at 15k, which matches the 30k run within 7%. The speed seen so far scales what's left. The CLI draws one line in a terminal and prints a line per tenth of a stage otherwise.
- **Sharpest frames:** video is sampled at 3 times the frame count, `blurdetect` scores every candidate, and the least blurred of each three is kept (in the test video the score ran from 4.8 to 7.7, and the extremes look like what they score).
- **One job at a time.** Cancel kills the current step (finished steps stay). Closing the window or Cmd+Q asks first, then kills running tools (the macOS menu's Quit is our own item for that; the Dock's Quit still doesn't ask). The machine is kept awake during a job (`caffeinate` on macOS, `systemd-inhibit` on Linux). A system notification fires on finish or failure when the window isn't focused (not on Stop).
- **GPU failures** are translated, not prevented (the no-GPU message is confirmed against a real failure: Brush panics with `No possible adapter available for backend`): "no supported GPU" (needs Metal or Vulkan) and "out of memory" (lower Detail). No startup check unless Brush offers a cheap one.

### Tools and where they come from
| Tool | Source | Why |
|---|---|---|
| ffmpeg | conda-forge, pinned `ffmpeg=*=lgpl*` (9.0.2) | Reads iPhone tiled HEIC (needs ffmpeg 8.1+); same bundle as COLMAP. Unpinned, the solver picks the GPL build |
| COLMAP | conda-forge, pinned `colmap=4.2.1=cpu*` | Current version on every OS, no compiling. The exact version pin is required: unpinned, the solver picked 3.11.1. The `cpu*` pin avoids the CUDA build on NVIDIA hosts. On Linux and Windows even the `cpu` builds require the CUDA build of faiss (about 670 MB with cuBLAS); COLMAP only uses faiss for image retrieval, so the bundle step swaps in the CPU build of the same faiss version. `libblas=*=*openblas` keeps MKL, which loads most of itself at runtime, out of the Windows bundle |
| Brush | cargo build of a pinned git commit, run as a sidecar | Current code (the last release is from Sep 2025); a crash or GPU out-of-memory does not take the app down |

ffmpeg and COLMAP are installed with `micromamba` into one folder that ships as a Tauri resource. The bundle step keeps only `bin/{colmap,ffmpeg,ffprobe}` and the libraries they link (found by walking `otool -L` / `ldd` / the PE import table from those three, plus export forwarders, since conda's Windows `libblas.dll` only forwards to `openblas.dll`; on Windows the DLLs sit in `bin/` beside the programs), and collects every package's license into `THIRD_PARTY_LICENSES/`. The app looks for tools in its bundled folder first, then on `PATH`.

Brush notes: needs Rust 1.95 or newer. Its export file name pads `{iter}` to the width of the total step count (`export_5000.ply` for a 5k run, `export_05000.ply` for 30k), so the app picks the newest export instead of guessing names. When piped, its progress bar is hidden; `RUST_LOG=info` gives a `Refine iter N, X splats.` line every 200 steps up to 95% of training and `Compute backend: …` at start. GPU kernel tuning is cached in `~/.cache/cubecl`, so the first run is slower.

### App
- **Tauri** with **Vite + vanilla TypeScript** (no framework, no CSS library: about 300 lines of TS and hand-written CSS are less than Tailwind or a UI kit would add). Four views: Home, Progress, Viewer, Settings.
- **Look:** GNOME / libadwaita patterns (header bars, status page, boxed-list preferences, pill and OSD buttons, Adwaita palette and fonts) on every platform. The header bars are the title bar: on macOS the window buttons float over them (`tauri.macos.conf.json`, overlay title bar); on Linux there is no system title bar (`tauri.linux.conf.json`), so each bar has GNOME's close button, drags the window and maximises on double-click, and tao resizes from the window edges.
- **Viewer:** SuperSplat viewer (`@playcanvas/supersplat-viewer`, MIT): polished orbit/fly/touch controls, `frameScene()`, WebGPU with WebGL fallback. It has no content swap, so each preview export recreates the viewer (`destroy()` then `createViewer()`). It has no model rotation either, so orientation is fixed in the data by `model_orientation_aligner` before training. It applies the usual 180° Z flip to PLY data, so aligned scenes (up = -Y) show upright. Nice touch: set the initial camera to the first frame's pose (COLMAP camera center and view direction with x and y negated), so the viewer opens on the view the user filmed first.
- **CLI:** the same binary, arguments parsed with clap. `simplesplat <video|folder> [--detail low|medium|high] [--out DIR]` runs the pipeline headless when given an input, prints one progress line per step, and exits non-zero with the same plain-language message the UI shows. No window, no second binary to package. Advanced settings become flags only when someone needs them. On Windows the release binary is a GUI program: the CLI attaches to the terminal's console, but the shell doesn't wait for it. A console-subsystem copy named `simplesplat.com` beside the `.exe` would fix that, since shells try `.com` first.
- **Update notice:** at startup, compare the app version with GitHub's latest release tag and show a download link if newer. No in-place updater. Only CI builds know their repository (`GITHUB_REPOSITORY`, compiled into the frontend), so local builds never check. A pushed `v<version>` tag publishes the installers as that release; CI fails the tag if it doesn't match `src-tauri/Cargo.toml`, the one place the version is set.

### Nix
- `flake.nix` provides the development environment: Rust (pinned explicitly at 1.95 or newer, since Brush needs it), cargo-tauri, Node, micromamba, and WebKitGTK and friends on Linux.
- **Package** (`nix build`, x86_64-linux and aarch64-darwin): COLMAP and ffmpeg from nixpkgs (COLMAP 4.1.1 there, which takes every option we pass), Brush built with `rustPlatform` at the same pin (nixpkgs `brush` is an unrelated shell, and Brush gets the Vulkan loader on its rpath; NixOS supplies the drivers), and the app with nixpkgs' `cargo-tauri.hook`. The tools' folder is compiled into the app (`SIMPLESPLAT_TOOLS_DIR`) instead of a `PATH` wrapper, which would break the macOS `.app`.
- Release builds for macOS, `.deb` and `.rpm` do not use Nix-built binaries, and run outside `nix develop` (plain rustup, Node, micromamba): anything compiled inside the shell can link against `/nix/store` paths.

### Packaging
- **macOS (arm64):** `.dmg`, ad-hoc signed for now. A symlink to the binary works (Tauri feature `process-relaunch-dangerous-allow-symlink-macos`), so a Homebrew cask can expose the CLI with `binary`. Before a public release: Developer ID, sign every bundled dylib with hardened runtime, notarize.
- **Linux (x64):** `.deb` and `.rpm` (system WebKitGTK, so WebGL uses the real drivers; no AppImage, which bundles its own), depending on the Vulkan loader for Brush, plus the Nix package. The CLI lands in `/usr/bin`. Flatpak later (NVIDIA works through the matching GL extension).
- **Size budget:** about 500 MB compressed installer. Measured on macOS: trimmed tools 305 MB (68 MB xz), Brush 102 MB stripped (39 MB xz), so about 110 MB compressed in total. No custom COLMAP build needed.
- **Windows (x64):** NSIS installer, unsigned for now (SmartScreen warns). conda-forge `win-64` builds of both tools (trimmed: 280 MB, 180 files), Brush builds with cargo, WebView2 handles WebGL. Tools run without console windows (`CREATE_NO_WINDOW`), and `SetThreadExecutionState` keeps the machine awake. The installer doesn't put the CLI on `PATH`.

### Quality
- Rust unit tests for pure logic: frame sampling math, error text to message mapping, step skipping.
- A tiny dataset in the repo (about 20 photos of one object, 400 px).
- CI on release tags and on demand (`.github/workflows/build.yml`): builds the macOS, Linux and Windows installers and runs the unit tests. Still to add: the CLI runs the full pipeline on Linux with Brush at about 100 steps on Mesa lavapipe (software Vulkan); on macOS, ffmpeg and COLMAP run from the moved conda bundle.
- Before each release: real phone videos on real hardware (Apple Silicon, NVIDIA Linux, AMD or Intel Linux).

### License
Public repo, Apache-2.0. Bundled tools run as separate programs: Brush (Apache-2.0), COLMAP (BSD), ffmpeg (LGPL v3: built `--disable-gpl --enable-version3`), and COLMAP dependencies including GPL parts of SuiteSparse and x265 (through OpenImageIO and libheif). Their licenses and source pointers ship in `THIRD_PARTY_LICENSES/` (the bundle script collects them for every conda package it ships, about 90). The Rust crates compiled into Brush and into the app are listed with their license texts by `cargo-about` (`THIRD_PARTY_LICENSES/{brush,simplesplat}/crates.txt`). `scripts/about.toml` accepts permissive licenses (and MPL-2.0) only, so crates also offered under GPL or LGPL come under their permissive option.

## Spike results (2026-10-15, Apple M5, 24 GB, macOS 26.5)

Input: 19.6 s portrait phone video (720x1280, H.264 SDR) of a potted plant on a desk. Tools from the conda bundle **after moving it** to a path with spaces, and again from the **trimmed** bundle. Brush at commit `1388f74` (2026-10-03).

- [x] Moved conda folder: ffmpeg, ffprobe and COLMAP run, and the full pipeline works. The old prefix still appears in 688 files (build metadata), with no effect.
- [x] Tiled HEIC (4032x3024, 48 tiles) decodes at full size. Resizing needs a second ffmpeg call.
- [x] EXIF-rotated JPEG and HEIC (`irot`) photos: ffmpeg 9 turns them upright (checked with test files), and the JPEGs it writes carry no orientation tag, so nothing rotates twice.
- [ ] HDR video: ffmpeg's scale filter converts frames to SDR BT.709 (`out_transfer`, `out_primaries`), which leaves SDR untouched; checked by round trips of a test pattern through HLG and PQ in BT.2020 (without it, HLG red 254,0,0 came back as 180,67,32; with it 231,5,7). A real iPhone HDR clip is still to try.
- [x] COLMAP 4.2.1 has `global_mapper` and `model_orientation_aligner`. 150/150 frames registered, 0.8 px reprojection error.
- [x] Brush: flags, periodic export, piped progress (see Brush notes), distortion models. No GPU probe flag; GPU errors would surface within seconds of starting.
- [x] Orientation: Brush's own up estimate is tilted about 18° on raw COLMAP output. After `model_orientation_aligner --method IMAGE-ORIENTATION` (instant), up is -Y, and the SuperSplat viewer, placed at frame 1's pose, matches the photo.
- [x] Bundle size: see Packaging.
- [x] Tauri copies the tools folder intact as a resource: executable bits kept, and the bundle script copies real files instead of symlinks. The release `.app` (428 MB uncompressed) finds and runs all tools with none of them on `PATH`.
- [ ] `captureFrame()` for still previews, and the viewer inside Tauri's WKWebView (the spike used headless Chrome). Check in the app step.
- [ ] Loop closure on a longer video that returns to its start (sequential matching without loop detection may drift).

| Step | Time |
|---|---|
| ffmpeg, 150 frames | 0.3 s |
| COLMAP features | 15 s |
| COLMAP matching, sequential / exhaustive | **39 s** / 497 s (same registration and error) |
| COLMAP global mapper | 7 to 10 s |
| Brush 5k / 10k / 15k / 20k / 30k steps | 2.3 / 7.5 / 14.7 / 22.6 / about 38 min (slows as splats grow to about 960k at 15k) |
| Brush with an idle SuperSplat viewer open | 16% slower (viewer renders 60 frames/s even when idle) |

## Build order

1. ~~Mac spike~~ done, see results above.
2. ~~Scaffold~~ done on macOS: `flake.nix`, Tauri vanilla-ts app, `scripts/bundle_tools.py` (Linux `ldd` path checked in Docker, Windows import-table path against a downloaded win-64 env).
3. ~~Pipeline + CLI~~ done: `src-tauri/src/pipeline.rs` driven by `simplesplat <input> [--detail] [--out]` (same binary; no arguments starts the app). On the M5, Low takes 3 minutes for the 20 s test video; a re-run skips every stage.
4. Mac app end to end: all four views on top of the same pipeline, notifications, update notice, progress with time left. Still to do: a click-through of the GUI.
5. CI: ~~release builds and unit tests on macOS, Linux and Windows, releases from tags~~; still to do: test dataset, smoke runs.
6. Linux `.deb` and `.rpm`, tested on NVIDIA and on AMD or Intel.
7. ~~Nix package~~ (`nix build`): built and run on aarch64-darwin; x86_64-linux built in Docker (tests pass, `.desktop` entry included), and its CLI ran ffmpeg and COLMAP from nixpkgs (100 of 100 frames placed); training needs a GPU the container doesn't have. (Under Docker's x86_64 emulation on a Mac the Tauri CLI wrongly rejects the build target, because a missing `rustup` looks like it ran; the test added a stand-in `rustup`. Real Linux doesn't need that.)
8. Later: notarization, Windows code signing, Flatpak, multiple videos per scene.
