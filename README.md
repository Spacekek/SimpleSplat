# SimpleSplat

Turn a phone video or a folder of photos into a Gaussian splat with one button. See [docs/PLAN.md](docs/PLAN.md).

## Develop

```sh
nix develop
npm install         # the window's packages: Svelte, Vite and the 3D viewer
cargo tauri dev     # first run downloads src-tauri/tools (ffmpeg + Spirula), about a minute
cargo tauri build   # installers in src-tauri/target/release/bundle
```

Plain `cargo build` and `cargo test` compile the window in from `dist/`, so run `npm run build` (or `cargo tauri build`) once before them.

Where things are:

- `index.html` and `src/`: the window, in Svelte, built by Vite into `dist/`. `src/App.svelte` holds the views and dialogs from `src/lib/`, whose `.svelte.js` modules keep the settings, the running job and the release check. `src/adwaita.css` is the GNOME look; each screen's layout is in its component.
- `src-tauri/`: the Rust program. `src/main.rs` has the window's commands, `src/cli.rs` the CLI, `src/settings.rs` the Detail presets, `src/pipeline.rs` runs the three stages in `src/pipeline/` (frames, camera positions, training), `src/gpu.rs` the GPU memory check. `tauri.conf.json` (plus one file per platform) configures the app and its installers.
- `scripts/bundle_tools.py`: downloads ffmpeg and Spirula into `src-tauri/tools`.
- `docs/PLAN.md`: how the app works and why, and what is left to do.

`python3 scripts/bundle_tools.py` fetches the bundled tools on their own: pinned, checksummed ffmpeg and Spirula binaries into `src-tauri/tools`. It skips the work when nothing changed.

Without Nix you need Node.js 22, Rust, the Tauri CLI (`cargo install tauri-cli --version "^2" --locked`), Python 3 and (for release builds, which write the Rust crates' license notices) cargo-about on `PATH`, and on Linux the [Tauri system packages](https://tauri.app/start/prerequisites/). Release builds for other people's machines run that way, outside `nix develop`, because binaries built inside the Nix shell can link against `/nix/store` paths. On Windows the same commands work from a normal terminal.

CI (`.github/workflows/build.yml`) builds each pushed `v*` tag, or any branch from **Run workflow** in the Actions tab, on macOS (Apple Silicon: `.dmg`), Linux (x64: `.deb`, `.rpm`) and Windows (x64: NSIS installer), and keeps the installers as build artifacts.

To release: bump `version` in `src-tauri/Cargo.toml` (the only place it is set), then push a tag `v<version>`. CI checks that the two match, builds the installers and publishes them as a GitHub release, where the app's update notice finds them.

## Updating the 3D viewer

The viewer is two npm packages, both MIT and pinned in `package.json`: `playcanvas` and `@playcanvas/supersplat-viewer`. They update together: the viewer names the PlayCanvas versions it works with (`peerDependencies` on its [npm page](https://www.npmjs.com/package/@playcanvas/supersplat-viewer?activeTab=code)). Install the new pair, try the app (open a `.ply`), and give the Nix package the new dependency hash (see `npmDeps` in `flake.nix`):

```sh
npm install --save-exact playcanvas@<version> @playcanvas/supersplat-viewer@<version>
```

## Nix

```sh
nix build            # the app, with ffmpeg from nixpkgs and Spirula's release binary (x86_64-linux)
nix run . -- --help  # the CLI
```

The package doesn't use the downloaded bundle: the app is built with the folder of those tools (`SIMPLESPLAT_TOOLS_DIR`) compiled in. There is no macOS package; Mac users have the `.dmg`.

## Command line

The app binary doubles as a CLI: given an input it runs headless, without a window.

```sh
simplesplat <video | photo folder> [--detail low|medium|high] [--out DIR]
```

Results go to `<name>_splat/` next to the input (or inside `--out DIR`), with `scene.ply` as the result. Running it again skips finished stages. `simplesplat --help` lists the options.

Where the binary is:

- **Linux** (`.deb`, `.rpm`): `/usr/bin/simplesplat`, already on `PATH`.
- **macOS**: `SimpleSplat.app/Contents/MacOS/simplesplat`. A symlink on your `PATH` works: `ln -s /Applications/SimpleSplat.app/Contents/MacOS/simplesplat /usr/local/bin/`.
- **Nix**: `bin/simplesplat` of the package.
- **Windows**: `simplesplat.exe` in the install folder. It is a GUI program, so the terminal doesn't wait for it: the prompt comes back at once and the output follows.

## License

Apache-2.0. Bundled tools keep their own licenses, collected in `tools/THIRD_PARTY_LICENSES` (ffmpeg and Spirula are GPL, and run as separate programs), together with those of the Rust crates and npm packages that are part of the app.
