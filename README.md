# SimpleSplat

Turn a phone video or a folder of photos into a Gaussian splat with one button. See [docs/PLAN.md](docs/PLAN.md).

## Develop

```sh
nix develop
npm install
cargo tauri dev     # first run builds src-tauri/tools (conda + Brush), about 10 minutes
cargo tauri build   # release bundle; see the note below
```

`npm run tools` builds the bundled tools on its own (ffmpeg, COLMAP, Brush into `src-tauri/tools`). It skips the work when nothing changed.

Release builds for other people's machines run outside `nix develop` (plain rustup, Node, micromamba), because binaries built inside the Nix shell can link against `/nix/store` paths.

## Command line

The app binary doubles as a CLI: given an input it runs headless, without a window.

```sh
simplesplat <video | photo folder> [--detail low|medium|high] [--out DIR]
```

Results go to `<name>_splat/` next to the input (or inside `--out DIR`), with `scene.ply` as the result. Running it again skips finished stages. On macOS the binary is `SimpleSplat.app/Contents/MacOS/simplesplat`.

## License

Apache-2.0. Bundled tools keep their own licenses, collected in `tools/THIRD_PARTY_LICENSES`.
