#!/usr/bin/env python3
"""Build src-tauri/tools: trimmed ffmpeg + COLMAP from conda-forge, plus Brush from a pinned commit.

Needs micromamba and cargo (Rust >= 1.95) on PATH; `nix develop` provides both.
Does nothing when src-tauri/tools/.stamp matches the pins below.
"""

import hashlib
import json
import os
import platform
import shutil
import struct
import subprocess
import sys
import urllib.request
from pathlib import Path

# ponytail: top-level pins only; export an explicit lockfile (micromamba env export --explicit) if builds drift
# OpenBLAS everywhere: on Windows the solver picks MKL, which loads most of itself at runtime, out of
# sight of the import walk below (macOS and Linux already get OpenBLAS).
CONDA_SPECS = ["colmap=4.2.1=cpu*", "ffmpeg=*=lgpl*", "libblas=*=*openblas"]
# conda-forge's CPU COLMAP builds for Linux and Windows still depend on the CUDA build of faiss, which
# brings about 670 MB of cuBLAS. COLMAP uses faiss only for image retrieval, which this pipeline
# doesn't do, so the CPU build of the same version replaces it; the smoke test checks colmap loads.
# ponytail: drop once colmap-feedstock's cpu builds depend on libfaiss *_cpu
FAISS_CPU = "libfaiss=*=*cpu*"
CONDA_BINS = ["colmap", "ffmpeg", "ffprobe"]
BRUSH_REPO = "https://github.com/ArthurBrussee/brush"
BRUSH_REV = "1388f74c6fe0236f68ee4915564bf00e9d2e3747"

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src-tauri" / "tools"
CACHE = ROOT / ".cache"
# Any change to this script (pins included) rebuilds the bundle; the slow parts stay cached in .cache.
STAMP = json.dumps([hashlib.sha1(Path(__file__).read_bytes()).hexdigest(), sys.platform, platform.machine()])
WINDOWS = sys.platform == "win32"
EXE = ".exe" if WINDOWS else ""


def run(*cmd, env=None):
    print("+", *cmd, flush=True)
    subprocess.run([str(c) for c in cmd], check=True, env=env)


def pe_imports(path: Path) -> set[str]:
    """DLL names a Windows executable or DLL imports, delay-loaded ones included."""
    data = path.read_bytes()
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    sections, optional_size = struct.unpack_from("<2xH12xH", data, pe + 4)
    optional = pe + 24
    directories = optional + (112 if struct.unpack_from("<H", data, optional)[0] == 0x20B else 96)
    table = [struct.unpack_from("<8xIIII", data, optional + optional_size + 40 * i) for i in range(sections)]

    def offset(rva: int) -> int:
        return next(raw + rva - va for size, va, raw_size, raw in table if va <= rva < va + max(size, raw_size))

    names = set()
    # (data directory, descriptor size, offset of the DLL name in it): imports, delay-load imports
    for directory, size, name_at in [(1, 20, 12), (13, 32, 4)]:
        rva = struct.unpack_from("<I", data, directories + 8 * directory)[0]
        while rva and (name := struct.unpack_from("<I", data, offset(rva) + name_at)[0]):
            start = offset(name)
            names.add(data[start : data.index(b"\0", start)].decode())
            rva += size
    return names


def linked_libs(binary: Path, prefix: Path) -> dict[str, Path]:
    """Libraries `binary` loads from the conda prefix, as {name it is loaded by: real file}."""
    if WINDOWS:
        dlls = {dll.name.lower(): dll for folder in (prefix / "Library" / "bin", prefix) for dll in folder.glob("*.dll")}
        return {dlls[n].name: dlls[n] for n in map(str.lower, pe_imports(binary)) if n in dlls}
    if sys.platform == "darwin":
        out = subprocess.run(["otool", "-L", binary], capture_output=True, text=True, check=True).stdout
        names = [line.strip().split(" (")[0] for line in out.splitlines()[1:]]
        return {n.removeprefix("@rpath/"): (prefix / "lib" / n.removeprefix("@rpath/")).resolve() for n in names if n.startswith("@rpath/")}
    out = subprocess.run(["ldd", binary], capture_output=True, text=True, check=True).stdout
    libs = {}
    for line in out.splitlines():
        name, _, rest = line.strip().partition(" => ")
        path = Path(rest.split(" (")[0]).resolve() if rest.startswith("/") else None
        if path and path.is_relative_to(prefix):
            libs[name] = path
    return libs


def conda_tools() -> None:
    mamba = shutil.which("micromamba") or sys.exit("micromamba not found on PATH (`nix develop` provides it)")
    work = CACHE / ("conda-" + hashlib.sha1(json.dumps([CONDA_SPECS, FAISS_CPU]).encode()).hexdigest()[:8])
    prefix = work / "env"
    if not (prefix / "conda-meta").exists():
        env = dict(os.environ, MAMBA_ROOT_PREFIX=str(work / "root"))
        run(mamba, "create", "-y", "-p", prefix, "-c", "conda-forge", *CONDA_SPECS, env=env)
        run(mamba, "install", "-y", "-p", prefix, "-c", "conda-forge", "--no-deps", FAISS_CPU, env=env)
    prefix = prefix.resolve()

    # Copy the binaries and every library they load, following symlinks so the bundle has none.
    # Windows has no rpath and finds DLLs beside the program, so its libraries go into bin/.
    libs = OUT / ("bin" if WINDOWS else "lib")
    (OUT / "bin").mkdir(parents=True)
    libs.mkdir(exist_ok=True)
    todo = [prefix / ("Library/bin" if WINDOWS else "bin") / f"{b}{EXE}" for b in CONDA_BINS]
    shipped = set()  # copied files as paths in the prefix, to find the packages that own them
    for path in todo:
        shutil.copy2(path, OUT / "bin" / path.name)
        shipped.add(path.relative_to(prefix).as_posix())
    while todo:
        for name, real in linked_libs(todo.pop(), prefix).items():
            if not (libs / name).exists():
                shipped.add(real.relative_to(prefix).as_posix())
                shutil.copy2(real, libs / name)
                todo.append(real)

    # Licenses of every package that owns a shipped file.
    index = []
    for meta in sorted((prefix / "conda-meta").glob("*.json")):
        pkg = json.loads(meta.read_text())
        if shipped.isdisjoint(pkg.get("files", [])):
            continue
        index.append(f"{pkg['name']} {pkg['version']}: {pkg.get('license', 'unknown')}")
        licenses = Path(pkg["extracted_package_dir"]) / "info" / "licenses"
        if licenses.is_dir():
            shutil.copytree(licenses, OUT / "THIRD_PARTY_LICENSES" / pkg["name"])
    index.append("Sources: https://conda-forge.org (feedstocks at https://github.com/conda-forge/<name>-feedstock)")
    (OUT / "THIRD_PARTY_LICENSES").mkdir(exist_ok=True)
    (OUT / "THIRD_PARTY_LICENSES" / "INDEX.txt").write_text("\n".join(index) + "\n")


def brush() -> None:
    root = CACHE / f"brush-{BRUSH_REV[:12]}"
    exe = root / "bin" / f"brush-cli{EXE}"
    if not exe.exists():
        env = dict(os.environ, CARGO_PROFILE_RELEASE_STRIP="true")
        run("cargo", "install", "--locked", "--git", BRUSH_REPO, "--rev", BRUSH_REV, "--root", root, "brush-cli", env=env)
    shutil.copy2(exe, OUT / "bin" / exe.name)
    # ponytail: Brush's own license only; its crate dependencies' notices need cargo-about before a public release
    dest = OUT / "THIRD_PARTY_LICENSES" / "brush"
    dest.mkdir(parents=True)
    with urllib.request.urlopen(f"{BRUSH_REPO}/raw/{BRUSH_REV}/LICENSE") as r:
        (dest / "LICENSE").write_bytes(r.read())


def smoke_test() -> None:
    for name, arg in [("ffmpeg", "-version"), ("ffprobe", "-version"), ("colmap", "help"), ("brush-cli", "--version")]:
        out = subprocess.run([OUT / "bin" / f"{name}{EXE}", arg], capture_output=True, text=True)
        first = (out.stdout or out.stderr).splitlines()[:1]
        print(f"{name}: exit {out.returncode}: {first[0] if first else '(no output)'}")
        if out.returncode != 0:
            sys.exit(f"{name} does not run from the bundle")


def main() -> None:
    stamp = OUT / ".stamp"
    if stamp.exists() and stamp.read_text() == STAMP:
        print("tools up to date")
        return
    shutil.rmtree(OUT, ignore_errors=True)
    conda_tools()
    brush()
    smoke_test()
    stamp.write_text(STAMP)
    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"tools ready: {size / 2**20:.0f} MB in {OUT}")


if __name__ == "__main__":
    main()
