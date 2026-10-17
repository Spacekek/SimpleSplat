{
  description = "SimpleSplat: turn a video or a folder of photos into a Gaussian splat";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs, ... }:
    let
      forSystems = f: nixpkgs.lib.genAttrs [ "aarch64-darwin" "x86_64-linux" ] (s: f nixpkgs.legacyPackages.${s});
    in
    {
      # Linux only: Spirula's macOS binary comes in a .dmg, and Mac users have the app's own .dmg.
      packages.x86_64-linux =
        let
          pkgs = nixpkgs.legacyPackages.x86_64-linux;
          inherit (pkgs) lib stdenv;

          # Spirula's release binary, patched to find its libraries on NixOS. Same version as in
          # scripts/bundle_tools.py.
          spirula = stdenv.mkDerivation {
            pname = "spirula";
            version = "2026.10.16";
            src = pkgs.fetchzip {
              url = "https://github.com/harry7557558/spirula-studio/releases/download/v2026.10.16/spirula-2026.10.16-ubuntu-vulkan-x86_64.zip";
              stripRoot = false;
              hash = "sha256-QerKk7p1TPJd8w/V0OBeeoQma8vq9KhDuWYxBwoSw5M=";
            };
            nativeBuildInputs = [ pkgs.autoPatchelfHook ];
            # libstdc++, libgcc_s and libgomp; libOpenGL; libvulkan, which it also opens at runtime.
            # NixOS provides the GPU drivers the Vulkan loader finds.
            buildInputs = [
              stdenv.cc.cc.lib
              pkgs.libglvnd
              pkgs.vulkan-loader
            ];
            runtimeDependencies = [ pkgs.vulkan-loader ];
            installPhase = "install -Dm755 spirula $out/bin/spirula";
          };

          tools = pkgs.symlinkJoin {
            name = "simplesplat-tools";
            paths = [
              (lib.getBin pkgs.ffmpeg)
              spirula
            ];
          };
        in
        {
          inherit spirula;
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
              pkgs.pkg-config
              pkgs.wrapGAppsHook3
            ];
            buildInputs = [
              pkgs.webkitgtk_4_1
              pkgs.glib-networking
              pkgs.openssl
            ];

            # ffmpeg from nixpkgs and Spirula above, instead of the downloaded bundle.
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

            meta = {
              description = "Turn a video or a folder of photos into a Gaussian splat";
              license = lib.licenses.asl20;
              mainProgram = "simplesplat";
              platforms = [ "x86_64-linux" ];
            };
          });
        };

      devShells = forSystems (pkgs: {
        default = pkgs.mkShell {
          packages =
            with pkgs;
            [
              rustc
              cargo
              rustfmt
              clippy
              nodejs # the Tauri CLI comes from npm (@tauri-apps/cli)
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

          # GTK needs its schemas for file dialogs; Spirula loads libvulkan at runtime.
          shellHook = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
            export XDG_DATA_DIRS=${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:$XDG_DATA_DIRS
            export LD_LIBRARY_PATH=${pkgs.vulkan-loader}/lib:$LD_LIBRARY_PATH
          '';
        };
      });
    };
}
