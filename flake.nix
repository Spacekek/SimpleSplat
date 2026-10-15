{
  description = "SimpleSplat development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      forSystems = f: nixpkgs.lib.genAttrs [ "aarch64-darwin" "x86_64-linux" ] (s: f nixpkgs.legacyPackages.${s});
    in
    {
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
