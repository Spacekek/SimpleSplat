#!/usr/bin/env python3
"""Build src-tauri/tools: ffmpeg and Spirula, pinned self-contained binaries for this platform.

Does nothing when src-tauri/tools/.stamp matches the pins below. `--app-notices` needs cargo-about
on PATH (`nix develop` provides it).
"""

import hashlib
import io
import json
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

SPIRULA = "https://github.com/harry7557558/spirula-studio/releases/download/v2026.10.16/spirula-2026.10.16"
BTBN = "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-16-13-04/ffmpeg-n9.0.2-28-g669f5ab083"
RIEDL = "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2"
FFMPEG_GIT = "https://raw.githubusercontent.com/FFmpeg/FFmpeg/n9.0.2"
# Per platform, each tool: (download, its sha256, the program inside it). Both run as separate
# programs. Spirula's macOS binary sits in a .app in a .dmg. macOS's static ffmpeg is GPL (it has
# x264 and x265 in it), like Spirula; Linux's and Windows' are LGPL.
TOOLS = {
    ("darwin", "arm64"): {
        "spirula": (f"{SPIRULA}-macos-vulkan-arm64.dmg", "08b332e833ecafcc636e1be6b38dd0a732c6202a0fcf41d2c84209be5fdd6f03", "Spirula Studio.app/Contents/MacOS/spirula"),
        "ffmpeg": (f"{RIEDL}/ffmpeg.zip", "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924", "ffmpeg"),
    },
    ("linux", "x86_64"): {
        "spirula": (f"{SPIRULA}-ubuntu-vulkan-x86_64.zip", "df5bb7acbfea63c16497c229b70c7a05ed13c22807554dee83cd6415aa411bf3", "spirula"),
        "ffmpeg": (f"{BTBN}-linux64-lgpl-9.0.tar.xz", "5e90ecce92a64495345f7d92c3238ca579483e54c20671c0a9e1eac6096a6882", "ffmpeg-n9.0.2-28-g669f5ab083-linux64-lgpl-9.0/bin/ffmpeg"),
    },
    ("win32", "AMD64"): {
        "spirula": (f"{SPIRULA}-windows-vulkan-x86_64.zip", "9b83ba6d78a4ace562d2ad2f964d2e3eb15aaa7a78918eab54e44d8a98a649d0", "spirula.exe"),
        "ffmpeg": (f"{BTBN}-win64-lgpl-9.0.zip", "fe7aab7fb1e83b4be657ae46d949a01812cabc60d35766d51fad8dcf97c69319", "ffmpeg-n9.0.2-28-g669f5ab083-win64-lgpl-9.0/bin/ffmpeg.exe"),
    },
}
# What goes into THIRD_PARTY_LICENSES/<tool>: license texts to download, and where the source is.
GPL_FFMPEG = sys.platform == "darwin"
NOTICES = {
    "spirula": (
        ["https://raw.githubusercontent.com/harry7557558/spirula-studio/v2026.10.16/LICENSE"],
        "Spirula Studio 2026.10.16, GPL-3.0: https://github.com/harry7557558/spirula-studio/tree/v2026.10.16",
    ),
    "ffmpeg": (
        [f"{FFMPEG_GIT}/LICENSE.md", f"{FFMPEG_GIT}/COPYING.GPLv2" if GPL_FFMPEG else f"{FFMPEG_GIT}/COPYING.LGPLv2.1"]
        + ([f"{RIEDL}/versions.txt"] if GPL_FFMPEG else []),
        "FFmpeg 9.0.2: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz, built by "
        + ("https://git.martin-riedl.de/ffmpeg/build-script (GPL: with x264, x265; versions.txt lists each library)"
           if GPL_FFMPEG else "https://github.com/BtbN/FFmpeg-Builds (LGPL)"),
    ),
}

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src-tauri" / "tools"
CACHE = ROOT / ".cache"
# Any change to this script (pins included) rebuilds the bundle; downloads stay cached in .cache.
STAMP = json.dumps([hashlib.sha1(Path(__file__).read_bytes()).hexdigest(), sys.platform, platform.machine()])


def run(*cmd):
    print("+", *cmd, flush=True)
    subprocess.run([str(c) for c in cmd], check=True)


def download(url: str) -> bytes:
    print("+ download", url, flush=True)
    # martin-riedl.de refuses Python's default user agent.
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "simplesplat-tools"})) as r:
        return r.read()


def fetch(name: str, url: str, sha256: str, member: str) -> Path:
    """The program `member` from the pinned download at `url`, cached by its hash."""
    exe = CACHE / f"{name}-{sha256[:12]}" / Path(member).name
    if exe.exists():
        return exe
    data = download(url)
    if hashlib.sha256(data).hexdigest() != sha256:
        sys.exit(f"{url} doesn't match its pinned sha256")
    exe.parent.mkdir(parents=True, exist_ok=True)
    if url.endswith(".dmg"):
        with tempfile.TemporaryDirectory() as tmp:
            dmg, mount = Path(tmp) / "download.dmg", Path(tmp) / "mount"
            dmg.write_bytes(data)
            run("hdiutil", "attach", "-quiet", "-nobrowse", "-readonly", "-mountpoint", mount, dmg)
            try:
                shutil.copy2(mount / member, exe)
            finally:
                run("hdiutil", "detach", "-quiet", mount)
    elif url.endswith(".zip"):
        exe.write_bytes(zipfile.ZipFile(io.BytesIO(data)).read(member))
    else:
        exe.write_bytes(tarfile.open(fileobj=io.BytesIO(data)).extractfile(member).read())
    exe.chmod(0o755)
    return exe


def main() -> None:
    if sys.argv[1:] == ["--app-notices"]:  # run by every release build, since the app's crates change
        out = OUT / "THIRD_PARTY_LICENSES" / "simplesplat"
        out.mkdir(parents=True, exist_ok=True)
        # Licenses of the Rust crates compiled into the app, by cargo-about.
        about = ROOT / "scripts"
        run("cargo", "about", "generate", "-c", about / "about.toml", "--manifest-path", ROOT / "src-tauri" / "Cargo.toml", about / "about.hbs", "-o", out / "crates.txt")
        # The 3D viewer's JavaScript, which ships inside the app.
        for license in (ROOT / "src" / "vendor").glob("*/LICENSE"):
            shutil.copy2(license, out / f"{license.parent.name}-LICENSE.txt")
        return
    stamp = OUT / ".stamp"
    if stamp.exists() and stamp.read_text() == STAMP:
        print("tools up to date")
        return
    tools = TOOLS.get((sys.platform, platform.machine())) or sys.exit(
        f"No tools for {sys.platform} {platform.machine()}: Spirula ships for macOS arm64, Linux x86_64 and Windows x64"
    )
    shutil.rmtree(OUT, ignore_errors=True)
    (OUT / "bin").mkdir(parents=True)
    for name, pin in tools.items():
        exe = fetch(name, *pin)
        shutil.copy2(exe, OUT / "bin" / exe.name)
        texts, source = NOTICES[name]
        dest = OUT / "THIRD_PARTY_LICENSES" / name
        dest.mkdir(parents=True)
        for url in texts:
            (dest / url.rsplit("/", 1)[1]).write_bytes(download(url))
        (dest / "SOURCE.txt").write_text(source + "\n")
    for name, arg in [("ffmpeg", "-version"), ("spirula", "--help")]:
        out = subprocess.run([OUT / "bin" / f"{name}{'.exe' if sys.platform == 'win32' else ''}", arg], capture_output=True, text=True)
        first = (out.stdout or out.stderr).splitlines()[:1]
        print(f"{name}: exit {out.returncode}: {first[0] if first else '(no output)'}")
        if out.returncode != 0:
            sys.exit(f"{name} does not run from the bundle")
    stamp.write_text(STAMP)
    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"tools ready: {size / 2**20:.0f} MB in {OUT}")


if __name__ == "__main__":
    main()
