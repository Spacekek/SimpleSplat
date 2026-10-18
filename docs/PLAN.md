# SimpleSplat plan

A desktop app that turns a phone video or a folder of photos into a Gaussian splat with one button, and shows it in a 3D viewer. Runs on macOS, Linux and Windows. Uses the GPU on any vendor (Apple, NVIDIA, AMD, Intel); no CUDA required.

## Pipeline

```
input: one video OR one photo folder (auto-detected)
  -> ffmpeg       N frames (video: the sharpest of every 3 candidates by blurdetect, never above its frame rate)
                  or at most N photos evenly spread; long side <= 1600 px, SDR BT.709, upright, JPEG -> images/
                  (tiled HEIC: decode in one call, resize in a second; ffmpeg can't combine them)
  -> spirula sfm  auto --data-type video|individual --quality low|medium|high (by Detail)
                  --camera-mode single (video) | image (photos)                     -> sparse/0
  -> (app)        turn the model from Spirula's z-up to up = -Y, write view.json
  -> spirula      train 3dgs, a checkpoint every fifth of the steps                 -> exports/step-N.ckpt/splat.ply
  -> viewer       SuperSplat viewer (PlayCanvas), upright with no extra rotation
```

Each step is a separate process with its own progress line in the UI and its own plain-language error message. Each stage is a module in `src-tauri/src/pipeline/` (`frames.rs`, `sfm.rs`, `train.rs`) with a `run` entry point; `pipeline.rs` runs them in order and owns stamps, progress, time left and Stop. No undistortion step: Spirula's SfM fits an OpenCV lens model and its trainer reads it.

### Project folder

Written next to the input as `<name>_splat/` (falls back to the app data folder if that location is not writable). Everything is kept. Each stage writes a hidden `.<folder>.stamp` with the settings that produced it (and the input's size and modification time), including the previous stage's stamp: a re-run skips stages whose stamp matches, and changing a setting re-runs that stage and everything after it. Changing training steps only re-trains; changing Detail also changes the frame count, so it redoes everything.

```
<name>_splat/
  scene.ply      the result
  images/        normalized frames/photos
  sparse/0/      Spirula's model, turned upright (COLMAP binary format)
  exports/       Spirula's checkpoints while training (the last splat becomes scene.ply, the rest is deleted)
  view.json      the viewer's first camera: frame 1's pose, aimed at the scene
  log.txt        output of every tool
  .*.stamp       what produced each stage
```

Spirula's SfM works in a temporary `sfm/` (features and matches), deleted once `sparse/0` is in place.

## Decisions

### Product
- **Main screen is one choice and one button.** Detail (Low/Medium/High) sits right on it, then Choose Video / Choose Photo Folder, or drop an input. Everything else shows only when it needs attention: the GPU memory warning when a run may not fit, and, when something differs from the defaults, a link to Settings saying so ("2 custom settings · saved in Exports"). Settings is otherwise behind the gear. A line describing the chosen level, and a grey summary line that didn't read as clickable, were tried and dropped as clutter.
- **Settings screen.** Results (output location), then Images, Training and Files groups, all visible: frame count, max image size, single camera, camera position quality (SfM); training steps, max splats, floater suppression, ignore moving things, exposure correction, preview interval; keep intermediates. Where a default differs between Detail levels, a line lists it per level with the current one in bold ("Default: Low 100 · Medium 150 · **High 300**"); elsewhere the control shows it (an empty field's greyed value, "Auto (Mild)"), and the switches say "Default: On". The top line names the current Detail and the GPU memory estimate. The values come from `Settings::detail` through the `defaults` command, so the screen can't drift from what runs. Reset to Defaults clears every override. A choice without a default that always wins becomes a setting, technical or not; its Auto follows the app's default, so a better default reaches everyone who never changed it.
- **Detail presets:** frames 100/150/300, training steps 10k/15k/30k, SfM quality low/medium/high, splat cap 1M/1M/3M (Spirula's own `--quality` presets differ only in that cap: 200k/1M/3M/10M; its 200k saved Low no time, 5:04 against 5:19). On an M5 with the 20 s test video: Low about 6 minutes in all (SfM 47 s, training 5.3 min, 670k splats), Medium 16 (SfM 3.7 min, training 12 min), High 69 (SfM 13.5 min for 300 frames, training 55.5 min, 3M splats, a 693 MB `scene.ply`). Low has 10k steps rather than 5k because Spirula adds at most about 10% splats per 100 steps, and stops 2,500 steps before the end: 5k steps ended at 58k splats.
- **Preview during training:** a still image, not a live viewer. An idle SuperSplat viewer keeps rendering at 60 fps and slowed training by 16% in the spike. For each checkpoint, load it, `captureFrame()`, `destroy()` the viewer and show the image (cost: a few seconds per preview). The preview fills the window; an "Explore" button at its bottom centre opens the live viewer and says training is slower while it is open. Stop kills Spirula and keeps the latest complete checkpoint.
- **Progress:** the stages run side by side along the bottom of the window, by name only (the log names the tools), each with its bar (so the bars line up as one) and what it is busy with below; the header shows the time left. Messages that come before the first stage (the GPU memory check) show above the steps. Sources: blurdetect's per-frame lines (video), the photo count, Spirula SfM's `[extract] i/n`, `[match] i/n pairs matched` and `[map] ... images in the model: k` lines, and Spirula's `step i/n` line every 100 steps. Each stage has an estimate from M5 timings: SfM per image at each quality (matching is nearly all of it), training linear in steps (15k took 11 min). The speed seen so far scales what's left. The CLI draws one line in a terminal and prints a line per tenth of a stage otherwise.
- **Sharpest frames:** video is sampled at 3 times the frame count, `blurdetect` scores every candidate, and the least blurred of each three is kept (in the test video the score ran from 4.8 to 7.7, and the extremes look like what they score).
- **One job at a time.** Cancel kills the current step (finished steps stay). Closing the window or Cmd+Q asks first, then kills running tools (the macOS menu's Quit is our own item for that; the Dock's Quit still doesn't ask). The machine is kept awake during a job (`caffeinate` on macOS, `systemd-inhibit` on Linux). A system notification fires on finish or failure when the window isn't focused (not on Stop).
- **GPU failures** are translated, not prevented: "no supported GPU" (needs Vulkan, or Metal on macOS) and "out of memory" (lower Detail). The strings matched in Spirula's log are Vulkan's error names, guessed until seen in real failures.
- **GPU memory** is checked before a run and watched during it (`src-tauri/src/gpu.rs`). `spirula sam devices` names the GPU Spirula will use (a discrete one first) and its memory; on macOS MoltenVK also reports Metal's working-set limit, which is what counts (18.2 of 24 GB on the M5). The estimate is the larger of SfM's and training's, and the warning names that step and the settings that lower it. Training: a fixed 300 MiB plus 450 bytes per splat of Max Splats plus 100 per pixel of the largest image; Spirula reserves the splat buffers for the whole cap up front (343 bytes each, measured at 1M, 3M and 10M), an image costs 61 bytes per pixel, and the rest covers the scratch that grows with the live splats (about 65 MiB per million), the high-water mark and the context. SfM: 460 MiB plus 570 bytes per feature, with every image filled to the preset's feature limit (2048, 4096 or 8192), from the peak footprint of `spirula sfm auto` on 1600 px frames (0.81 GiB for 150 frames at medium, 1.02 for 150 at high, 1.60 for 300 at high; on a Mac the footprint includes GPU memory, and training's footprint ran 0.3 to 1.2 GiB above Spirula's own count). SfM / training: Low 0.6 / 0.9 GB, Medium 0.8 / 0.9 GB, High 1.8 / 1.7 GB; 10M splats train in about 4.7 GB, and the measured training peak at 1M was 0.47 GB. Above 90% of the GPU's memory, Settings shows the estimate in red with what to lower, the home summary adds "may not fit in GPU memory", and the run starts with the same warning. During training, Spirula's own forecast warning (projected peak, memory free, chance of running out) comes through in plain words. Its forecast can't replace the estimate: at step 1,000 it projected 1.6 GiB for the 1M run that peaked at 0.47, and 72 GiB for 20 photos.

### Tools and where they come from
| Tool | Source | Why |
|---|---|---|
| ffmpeg 9.0.2 | Static builds, pinned by sha256: macOS arm64 from [martin-riedl.de](https://ffmpeg.martin-riedl.de/), Linux and Windows x64 from [BtbN's FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (LGPL) | One self-contained binary, no libraries to collect. Reads iPhone tiled HEIC (needs 8.1+); blurdetect and the HDR to SDR conversion give the same output as the conda build used before. Spirula needs it too: Apple GPUs have no Vulkan video decoding |
| Spirula Studio 2026.10.16 | Its release binary per platform, pinned by sha256 | SfM and training in one program, no compiling. Replaced COLMAP and Brush on 2026-10-17 (see Trainer comparison): about equal on clean video, much better with exposure drift, training 27% faster |

`scripts/bundle_tools.py` downloads both into `src-tauri/tools/bin`, which ships as a Tauri resource, checks their hashes, and collects their license texts and source pointers into `THIRD_PARTY_LICENSES/`. The app looks for tools in its bundled folder first, then on `PATH`.

Spirula notes:
- Runs headless only with `--disable-viewer 1 --keep-viewer-alive 0`; otherwise it serves a web viewer and keeps running after training.
- Prints `step i/n ( p%)  splats k ...` every 100 steps, also when piped. Writes `step-N.ckpt/splat.ply` (the standard 3DGS PLY layout) every `--steps-per-save` steps and at the end, keeping only the latest, without logging it; the app takes one untouched for 2 s as complete. SIGTERM leaves the last checkpoint.
- Its SfM writes the model levelled on the ground plane but z-up (ground at z = 0). The SfM stage turns cameras and points a quarter turn about x to up = -Y, and training gets `--orientation-method none --center-method none --scene-center none` so the splats stay in that frame.
- On macOS it runs on Metal through MoltenVK, linked into the binary. Matching is slow there: 150 frames took 3.6 min at medium and 6.5 at high, where COLMAP took 39 s; training more than makes up for it.
- The Linux binary needs glibc 2.38, libgomp and libOpenGL.

### App
- **Tauri** with **Vite + vanilla TypeScript** (no framework, no CSS library: about 300 lines of TS and hand-written CSS are less than Tailwind or a UI kit would add). Four views: Home, Progress, Viewer, Settings.
- **Look:** GNOME / libadwaita patterns (header bars, status page, boxed-list preferences, pill and OSD buttons, Adwaita palette and fonts) on every platform. The header bars are the title bar: on macOS the window buttons float over them (`tauri.macos.conf.json`, overlay title bar); on Linux there is no system title bar (`tauri.linux.conf.json`), so each bar has GNOME's close button, drags the window and maximises on double-click, and tao resizes from the window edges.
- **Viewer:** SuperSplat viewer (`@playcanvas/supersplat-viewer`, MIT): polished orbit/fly/touch controls, `frameScene()`, WebGPU with WebGL fallback. It has no content swap, so each preview recreates the viewer (`destroy()` then `createViewer()`). It has no model rotation either, so orientation is fixed in the data by the SfM stage before training. It applies the usual 180° Z flip to PLY data, so scenes with up = -Y show upright. Nice touch: set the initial camera to the first frame's pose (camera center and view direction from the model, with x and y negated), so the viewer opens on the view the user filmed first.
- **CLI:** the same binary, arguments parsed with clap. `simplesplat <video|folder> [--detail low|medium|high] [--out DIR]` runs the pipeline headless when given an input, prints one progress line per step, and exits non-zero with the same plain-language message the UI shows. No window, no second binary to package. Advanced settings become flags only when someone needs them. On Windows the release binary is a GUI program: the CLI attaches to the terminal's console, but the shell doesn't wait for it. A console-subsystem copy named `simplesplat.com` beside the `.exe` would fix that, since shells try `.com` first.
- **Update notice:** at startup, compare the app version with GitHub's latest release tag and show a download link if newer. No in-place updater. Only CI builds know their repository (`GITHUB_REPOSITORY`, compiled into the frontend), so local builds never check. A pushed `v<version>` tag publishes the installers as that release; CI fails the tag if it doesn't match `src-tauri/Cargo.toml`, the one place the version is set.

### Nix
- `flake.nix` provides the development environment: Rust, Node (the Tauri CLI comes from npm), Python, cargo-about, and WebKitGTK and friends on Linux.
- **Package** (`nix build`, x86_64-linux): ffmpeg from nixpkgs (9.0.1), Spirula's release binary patched with `autoPatchelfHook` (libstdc++ and libgomp, libglvnd, the Vulkan loader; NixOS supplies the drivers), and the app with nixpkgs' `cargo-tauri.hook`. The tools' folder is compiled into the app (`SIMPLESPLAT_TOOLS_DIR`). No macOS package: Spirula's macOS binary only comes in a `.dmg`, and Mac users have the app's own `.dmg`.
- Release builds for macOS, `.deb` and `.rpm` do not use Nix-built binaries, and run outside `nix develop` (plain rustup, Node, Python): anything compiled inside the shell can link against `/nix/store` paths.

### Packaging
- **macOS (arm64):** `.dmg`, ad-hoc signed for now. A symlink to the binary works (Tauri feature `process-relaunch-dangerous-allow-symlink-macos`), so a Homebrew cask can expose the CLI with `binary`. Before a public release: Developer ID, sign both bundled binaries with hardened runtime, notarize.
- **Linux (x64):** `.deb` and `.rpm` (system WebKitGTK, so WebGL uses the real drivers; no AppImage, which bundles its own), plus the Nix package. They depend on glibc 2.38 or newer (Spirula), the Vulkan loader, libgomp and libOpenGL, so they install on Ubuntu 24.04, Debian 13, Fedora 39 and newer; CI builds them on Ubuntu 24.04. The CLI lands in `/usr/bin`. Flatpak later (NVIDIA works through the matching GL extension).
- **Size budget:** about 500 MB compressed installer. Measured on macOS: tools 214 MB (45 MB xz), of which Spirula is 150 MB and ffmpeg 63 MB. With COLMAP, conda and Brush they were 407 MB (107 MB xz).
- **Windows (x64):** NSIS installer, unsigned for now (SmartScreen warns). The tools are two static `.exe` files; WebView2 handles WebGL. Tools run without console windows (`CREATE_NO_WINDOW`), and `SetThreadExecutionState` keeps the machine awake. The installer doesn't put the CLI on `PATH`.

### Quality
- Rust unit tests for pure logic: frame sampling math, the tools' progress lines, the upright rotation and `view.json`, the GPU listing and memory estimate, error text to message mapping, step skipping. `cargo test -- --ignored` also asks the bundled Spirula for this machine's GPU.
- A tiny dataset in the repo (about 20 photos of one object, 400 px).
- CI on release tags and on demand (`.github/workflows/build.yml`): builds the macOS, Linux and Windows installers and runs the unit tests. Still to add: the CLI runs the full pipeline on Linux at about 100 steps on Mesa lavapipe (software Vulkan).
- Before each release: real phone videos on real hardware (Apple Silicon, NVIDIA Linux, AMD or Intel Linux).

### License
Public repo, Apache-2.0. Bundled tools run as separate programs: Spirula (GPL-3.0) and ffmpeg (GPL on macOS, where the build includes x264 and x265; LGPL on Linux and Windows). Their license texts and source pointers ship in `THIRD_PARTY_LICENSES/`. The Rust crates compiled into the app are listed with their license texts by `cargo-about` (`THIRD_PARTY_LICENSES/simplesplat/crates.txt`). `scripts/about.toml` accepts permissive licenses (and MPL-2.0) only, so crates also offered under GPL or LGPL come under their permissive option.

## Trainer comparison (2026-10-17, Apple M5)

Why COLMAP + Brush gave way to Spirula. Both trainers got the same 150 undistorted frames of the test video and 15k steps, scored on the same 19 held-out frames:

| | PSNR | LPIPS | Time |
|---|---|---|---|
| Brush, test video | 23.60 | 0.276 | 15:04 |
| Spirula, test video | 22.18 | 0.297 | 11:00 |
| Brush, with simulated auto-exposure (±1 stop, white balance drift) | 20.77 | 0.301 | 15:05 |
| Spirula, same | 22.34 | 0.288 | 10:59 |

- Brush scores higher on clean video, but the two look alike; in the app the Spirula pipeline looked on par.
- With exposure drift Brush gets colour blotches and Spirula is barely affected (its per-photo exposure and colour correction, PPISP and a bilateral grid). Brush has this only in an unreviewed pull request (#483).
- SfM on the original frames: COLMAP 55 s, Spirula 6:44 at high, 3:49 at medium, 1:37 at low; all placed 150 of 150 frames at 0.7 to 0.9 px.
- Costs of the switch: Linux needs glibc 2.38, SfM is slower on Macs, Low needs 10k steps, and Spirula is maintained by one person (GPL-3.0, pinned, a separate program that can be swapped back).

### Settings tests (Medium, 150 frames, 19 held out)

| Variant | PSNR | Colour-corrected PSNR | LPIPS | Training |
|---|---|---|---|---|
| Defaults (exposure correction on, floater suppression off, SfM medium) | 22.63 | 23.99 | 0.270 | 12:08 |
| Exposure correction off | 24.11 | 24.30 | 0.259 | 9:49 |
| Floater suppression mild | 23.06 | 24.20 | 0.262 | 13:05 |
| SfM at low | 22.56 | 23.83 | 0.288 | 11:24 (SfM 1:37 instead of 3:44) |

- Exposure correction has no winner: off is better on this clean video, mostly by a global colour shift (0.3 dB colour-corrected), and on simulated exposure drift on was worth about 1.5 dB and removed colour blotches. It stays on, as a setting.
- Floater suppression mild is better on every score for 8% more time, and is the default.
- SfM at low saves 2 minutes but loses clearly (LPIPS), so Medium keeps medium; Camera Position Quality lets people choose.

## Spike results (2026-10-15, Apple M5, 24 GB, macOS 26.5)

With COLMAP and Brush, before the switch to Spirula; the ffmpeg, HEIC, HDR and viewer findings still hold. Input: 19.6 s portrait phone video (720x1280, H.264 SDR) of a potted plant on a desk. Tools from the conda bundle **after moving it** to a path with spaces, and again from the **trimmed** bundle. Brush at commit `1388f74` (2026-10-03).

- [x] Moved conda folder: ffmpeg, ffprobe and COLMAP run, and the full pipeline works. The old prefix still appears in 688 files (build metadata), with no effect.
- [x] Tiled HEIC (4032x3024, 48 tiles) decodes at full size. Resizing needs a second ffmpeg call.
- [x] EXIF-rotated JPEG and HEIC (`irot`) photos: ffmpeg 9 turns them upright (checked with test files), and the JPEGs it writes carry no orientation tag, so nothing rotates twice.
- [ ] HDR video: ffmpeg's scale filter converts frames to SDR BT.709 (`out_transfer`, `out_primaries`), which leaves SDR untouched; checked by round trips of a test pattern through HLG and PQ in BT.2020 (without it, HLG red 254,0,0 came back as 180,67,32; with it 231,5,7). A real iPhone HDR clip is still to try.
- [x] COLMAP 4.2.1 has `global_mapper` and `model_orientation_aligner`. 150/150 frames registered, 0.8 px reprojection error.
- [x] Brush: flags, periodic export, piped progress, distortion models. No GPU probe flag; GPU errors would surface within seconds of starting.
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
3. ~~Pipeline + CLI~~ done: `src-tauri/src/pipeline.rs` (stages in `pipeline/`) driven by `simplesplat <input> [--detail] [--out]` (same binary; no arguments starts the app). On the M5, Low takes about 6 minutes for the 20 s test video (3 with COLMAP and Brush); a re-run skips every stage.
4. Mac app end to end: all four views on top of the same pipeline, notifications, update notice, progress with time left. Still to do: a click-through of the GUI.
5. CI: ~~release builds and unit tests on macOS, Linux and Windows, releases from tags~~; still to do: test dataset, smoke runs.
6. Linux `.deb` and `.rpm`, tested on NVIDIA and on AMD or Intel.
7. Nix package (`nix build`): since the switch to Spirula x86_64-linux only, and it evaluates but is not built yet (needs Linux, or Docker as below). With COLMAP and Brush it was built and run on aarch64-darwin; x86_64-linux built in Docker (tests pass, `.desktop` entry included), and its CLI ran ffmpeg and COLMAP from nixpkgs (100 of 100 frames placed); training needs a GPU the container doesn't have. (Under Docker's x86_64 emulation on a Mac the Tauri CLI wrongly rejects the build target, because a missing `rustup` looks like it ran; the test added a stand-in `rustup`. Real Linux doesn't need that.)
8. ~~Switch to Spirula~~ (2026-10-17): see Trainer comparison. Still to do: a run on Linux and on Windows.
9. Later: notarization, Windows code signing, Flatpak, multiple videos per scene.
