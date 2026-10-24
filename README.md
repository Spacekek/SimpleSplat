# SimpleSplat

Turn a phone video or a folder of photos into a Gaussian splat with one button. See [docs/PLAN.md](docs/PLAN.md).

## Develop

```sh
nix develop
cargo tauri dev     # first run downloads src-tauri/tools (ffmpeg + Spirula), about a minute
cargo tauri build   # installers in src-tauri/target/release/bundle
```

Where things are:

- `src/`: the window. `index.html`, `main.js` and `styles.css` are used as they are, with no build step. `vendor/` holds the 3D viewer.
- `src-tauri/`: the Rust program. `src/main.rs` has the window's commands and the CLI, `src/pipeline/` the three stages (frames, camera positions, training), `src/gpu.rs` the GPU memory check. `tauri.conf.json` (plus one file per platform) configures the app and its installers.
- `scripts/bundle_tools.py`: downloads ffmpeg and Spirula into `src-tauri/tools`.
- `docs/PLAN.md`: what was decided and why.

`python3 scripts/bundle_tools.py` fetches the bundled tools on their own: pinned, checksummed ffmpeg and Spirula binaries into `src-tauri/tools`. It skips the work when nothing changed.

Without Nix you need Rust, the Tauri CLI (`cargo install tauri-cli --version "^2" --locked`), Python 3 and (for release builds, which write the Rust crates' license notices) cargo-about on `PATH`, and on Linux the [Tauri system packages](https://tauri.app/start/prerequisites/). Release builds for other people's machines run that way, outside `nix develop`, because binaries built inside the Nix shell can link against `/nix/store` paths. On Windows the same commands work from a normal terminal.

CI (`.github/workflows/build.yml`) builds each pushed `v*` tag, or any branch from **Run workflow** in the Actions tab, on macOS (Apple Silicon: `.dmg`), Linux (x64: `.deb`, `.rpm`) and Windows (x64: NSIS installer), and keeps the installers as build artifacts.

To release: bump `version` in `src-tauri/Cargo.toml` (the only place it is set), then push a tag `v<version>`. CI checks that the two match, builds the installers and publishes them as a GitHub release, where the app's update notice finds them.

## Updating the 3D viewer

`src/vendor` holds unmodified files from two npm packages, both MIT: PlayCanvas 2.23.2 and its SuperSplat viewer 1.37.0. They update together: the viewer names the PlayCanvas versions it works with (`peerDependencies` on its [npm page](https://www.npmjs.com/package/@playcanvas/supersplat-viewer?activeTab=code)). Put the new versions in these two commands, run them, try the app (open a `.ply`), and update the versions above:

```sh
curl -sfL https://registry.npmjs.org/playcanvas/-/playcanvas-2.23.2.tgz | tar -xzf - -C src/vendor/playcanvas --strip-components 1 package/LICENSE package/build/playcanvas.min.mjs package/scripts/esm/xr
curl -sfL https://registry.npmjs.org/@playcanvas/supersplat-viewer/-/supersplat-viewer-1.37.0.tgz | tar -xzf - -C src/vendor/supersplat-viewer --strip-components 1 package/LICENSE package/dist/viewer.js package/dist/settings.js package/dist/viewer.css
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

Apache-2.0. Bundled tools keep their own licenses, collected in `tools/THIRD_PARTY_LICENSES` (ffmpeg and Spirula are GPL, and run as separate programs), together with those of the Rust crates and the 3D viewer that are part of the app.
