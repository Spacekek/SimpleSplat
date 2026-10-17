# SimpleSplat

Turn a phone video or a folder of photos into a Gaussian splat with one button. See [docs/PLAN.md](docs/PLAN.md).

## Develop

```sh
nix develop
npm install
npm run tauri dev     # first run downloads src-tauri/tools (ffmpeg + Spirula), about a minute
npm run tauri build   # installers in src-tauri/target/release/bundle
```

`npm run tools` fetches the bundled tools on their own: pinned, checksummed ffmpeg and Spirula binaries into `src-tauri/tools`. It skips the work when nothing changed.

Without Nix you need Rust, Node, Python 3 and (for release builds, which write the Rust crates' license notices) cargo-about on `PATH`, and on Linux the [Tauri system packages](https://tauri.app/start/prerequisites/). Release builds for other people's machines run that way, outside `nix develop`, because binaries built inside the Nix shell can link against `/nix/store` paths. On Windows the same commands work from a normal terminal.

CI (`.github/workflows/build.yml`) builds each pushed `v*` tag, or any branch from **Run workflow** in the Actions tab, on macOS (Apple Silicon: `.dmg`), Linux (x64: `.deb`, `.rpm`) and Windows (x64: NSIS installer), and keeps the installers as build artifacts.

To release: bump `version` in `src-tauri/Cargo.toml` (the only place it is set), then push a tag `v<version>`. CI checks that the two match, builds the installers and publishes them as a GitHub release, where the app's update notice finds them.

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

Apache-2.0. Bundled tools keep their own licenses, collected in `tools/THIRD_PARTY_LICENSES` (ffmpeg and Spirula are GPL, and run as separate programs), together with those of the Rust crates compiled into the app.
