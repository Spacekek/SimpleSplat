{
  description = "SimpleSplat: turn a video or a folder of photos into a Gaussian splat";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs, ... }:
    let
      forSystems = f: nixpkgs.lib.genAttrs [ "aarch64-darwin" "x86_64-linux" ] (s: f nixpkgs.legacyPackages.${s});
    in
    {
      packages = forSystems (
        pkgs:
        let
          inherit (pkgs) lib stdenv;

          # nixpkgs' `brush` is an unrelated shell. Same commit as BRUSH_REV in scripts/bundle_tools.py.
          brush = pkgs.rustPlatform.buildRustPackage {
            pname = "brush-cli";
            version = "0-unstable-2026-10-03";
            src = pkgs.fetchFromGitHub {
              owner = "ArthurBrussee";
              repo = "brush";
              rev = "1388f74c6fe0236f68ee4915564bf00e9d2e3747";
              hash = "sha256-yzfzAfNHu3UvIW4WuAJVA1JF94MD3BOx19cXHdTW2qg=";
            };
            cargoHash = "sha256-AMZF+wxgUclhmmldWC9WbAXrUae5z5AlNNJ1+C9Wj54=";
            cargoBuildFlags = [ "--package" "brush-cli" ];
            doCheck = false;
            # wgpu opens the Vulkan loader at runtime; NixOS provides the GPU drivers it finds.
            postFixup = lib.optionalString stdenv.hostPlatform.isLinux ''
              patchelf --add-rpath ${pkgs.vulkan-loader}/lib $out/bin/brush-cli
            '';
          };

          tools = pkgs.symlinkJoin {
            name = "simplesplat-tools";
            paths = [ pkgs.colmap (lib.getBin pkgs.ffmpeg) brush ];
          };
        in
        {
          inherit brush;
          default = pkgs.rustPlatform.buildRustPackage (finalAttrs: {
            pname = "simplesplat";
            version = (lib.importTOML ./src-tauri/Cargo.toml).package.version;
            src = self;
            cargoRoot = "src-tauri";
            buildAndTestSubdir = "src-tauri";
            cargoLock.lockFile = ./src-tauri/Cargo.lock;
            npmDeps = pkgs.fetchNpmDeps {
              inherit (finalAttrs) src;
              hash = "sha256-5sLKAn0q13eEra12H1+JFyiwi28nuqKTTdA3H/P7rpk=";
            };

            nativeBuildInputs = [
              pkgs.cargo-tauri.hook
              pkgs.nodejs
              pkgs.npmHooks.npmConfigHook
            ] ++ lib.optionals stdenv.hostPlatform.isLinux [ pkgs.pkg-config pkgs.wrapGAppsHook3 ];
            buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
              pkgs.webkitgtk_4_1
              pkgs.glib-networking
              pkgs.openssl
            ];

            # COLMAP, ffmpeg and Brush come from nixpkgs instead of the conda bundle.
            env.SIMPLESPLAT_TOOLS_DIR = "${tools}/bin";
            # A file: the hook splits flags on spaces.
            tauriBuildFlags = [
              "--config"
              (builtins.toFile "tauri.nix.json" (
                builtins.toJSON {
                  build.beforeBuildCommand = "npm run build";
                  bundle.resources = [ ];
                }
              ))
            ];

            # `cargo test` builds without the config above, so the resource folder must exist.
            preCheck = "mkdir -p src-tauri/tools";

            # The CLI; on macOS the hook only installs the .app.
            postInstall = lib.optionalString stdenv.hostPlatform.isDarwin ''
              mkdir -p $out/bin
              ln -s $out/Applications/SimpleSplat.app/Contents/MacOS/simplesplat $out/bin/simplesplat
            '';

            meta = {
              description = "Turn a video or a folder of photos into a Gaussian splat";
              license = lib.licenses.asl20;
              mainProgram = "simplesplat";
              platforms = [ "aarch64-darwin" "x86_64-linux" ];
            };
          });
        }
      );

      devShells = forSystems (pkgs: {
        default = pkgs.mkShell {
          # Rust >= 1.95 is required by Brush; nixos-unstable ships newer.
          packages =
            with pkgs;
            [
              rustc
              cargo
              rustfmt
              clippy
              nodejs # the Tauri CLI comes from npm (@tauri-apps/cli)
              micromamba
              python3
              cargo-about # license notices for release builds
              pkg-config
            ]
            ++ lib.optionals stdenv.hostPlatform.isLinux [
              webkitgtk_4_1
              gtk3
              libsoup_3
              openssl
              librsvg
            ];

          # GTK needs its schemas for file dialogs; Brush loads libvulkan at runtime.
          shellHook = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
            export XDG_DATA_DIRS=${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:$XDG_DATA_DIRS
            export LD_LIBRARY_PATH=${pkgs.vulkan-loader}/lib:$LD_LIBRARY_PATH
          '';
        };
      });
    };
}
