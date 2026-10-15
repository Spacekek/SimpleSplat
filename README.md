# SimpleSplat

Turn a phone video or a folder of photos into a Gaussian splat with one button. See [docs/PLAN.md](docs/PLAN.md).

## Develop

```sh
nix develop
npm install
npm run tauri dev     # first run builds src-tauri/tools (conda + Brush), about 10 minutes
npm run tauri build   # installers in src-tauri/target/release/bundle
```

`npm run tools` builds the bundled tools on their own (ffmpeg, COLMAP, Brush into `src-tauri/tools`). It skips the work when nothing changed.

Without Nix you need Rust 1.95 or newer, Node, Python 3 and micromamba on `PATH`, and on Linux the [Tauri system packages](https://tauri.app/start/prerequisites/). Release builds for other people's machines run that way, outside `nix develop`, because binaries built inside the Nix shell can link against `/nix/store` paths. On Windows the same commands work from a normal terminal.

CI (`.github/workflows/build.yml`) builds every push on macOS (Apple Silicon: `.dmg`), Linux (x64: `.deb`, `.rpm`) and Windows (x64: NSIS installer), and keeps the installers as build artifacts.

## Command line

The app binary doubles as a CLI: given an input it runs headless, without a window.

```sh
simplesplat <video | photo folder> [--detail low|medium|high] [--out DIR]
```

Results go to `<name>_splat/` next to the input (or inside `--out DIR`), with `scene.ply` as the result. Running it again skips finished stages. `simplesplat --help` lists the options.

Where the binary is:

- **Linux** (`.deb`, `.rpm`): `/usr/bin/simplesplat`, already on `PATH`.
- **macOS**: `SimpleSplat.app/Contents/MacOS/simplesplat`. A symlink on your `PATH` works: `ln -s /Applications/SimpleSplat.app/Contents/MacOS/simplesplat /usr/local/bin/`.
- **Windows**: `simplesplat.exe` in the install folder. It is a GUI program, so the terminal doesn't wait for it: the prompt comes back at once and the output follows.

## License

Apache-2.0. Bundled tools keep their own licenses, collected in `tools/THIRD_PARTY_LICENSES`.
