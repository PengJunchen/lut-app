#!/usr/bin/env python3
"""Build release bundles from verified local runtimes and LUT assets."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "packaging" / "runtime-lock.json").read_text(encoding="utf-8"))
TARGETS = {
    "darwin-arm64": "Mac-AppleSilicon",
    "darwin-amd64": "Mac-Intel",
    "windows-amd64": "Windows-x64",
}


def run(args: list[str], **kwargs: object) -> None:
    subprocess.run(args, check=True, cwd=ROOT, **kwargs)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def runtime_metadata(target: str) -> tuple[dict, Path]:
    spec = LOCK["targets"][target]
    cache = ROOT / "packaging" / "cache" / target
    extension = ".exe" if target.startswith("windows-") else ""
    clean_tools = {}
    for name, record in spec["tools"].items():
        binary = cache / "bin" / (name + extension)
        if not binary.is_file():
            raise SystemExit(f"Missing runtime; run python3 packaging/prepare_runtime.py {target}")
        actual = digest(binary.read_bytes())
        if actual != record["binary_sha256"]:
            raise SystemExit(f"Runtime checksum differs from packaging/runtime-lock.json: {binary}")
        clean_tools[name] = {
            "version": record["version"],
            "url": record["url"],
            "archive": record["archive"],
            "archive_sha256": record["archive_sha256"],
            "binary_sha256": record["binary_sha256"],
        }
    metadata = {
        "schema_version": 1,
        "target": target,
        "platform": spec["platform"],
        "min_os": spec["min_os"],
        "tools": clean_tools,
    }
    metadata_path = cache / "metadata-tools.json"
    metadata_path.write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return spec, cache


def allowed_license(path: Path) -> bool:
    name = path.name.lower()
    return path.is_file() and "license-output" not in name and ("license" in name or "copying" in name)


def archive_runtime(target: str) -> Path:
    spec, cache = runtime_metadata(target)
    extension = ".exe" if target.startswith("windows-") else ""
    files = [cache / "bin" / (name + extension) for name in ("ffmpeg", "ffprobe")]
    files.append(cache / "metadata-tools.json")
    licenses = cache / "licenses"
    if licenses.is_dir():
        files.extend(sorted(path for path in licenses.rglob("*") if allowed_license(path)))

    destination = ROOT / "internal" / "bundle" / "runtimes" / f"{target}.tgz"
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as raw, gzip.GzipFile(
        filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=6
    ) as compressed, tarfile.open(fileobj=compressed, mode="w|") as archive:
        for source in sorted(files, key=lambda item: item.relative_to(cache).as_posix()):
            if not source.is_file():
                continue
            info = archive.gettarinfo(str(source), arcname=source.relative_to(cache).as_posix())
            info.mtime = 0
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            info.mode = 0o755 if source.parent.name == "bin" and not extension else 0o644
            with source.open("rb") as data:
                archive.addfile(info, data)
    return destination


def zip_release(folder: Path) -> Path:
    destination = folder.with_suffix(".zip")
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for source in sorted(folder.rglob("*")):
            if source.is_file():
                archive.write(source, source.relative_to(folder.parent))
    return destination


def copy_licenses(target: str, destination: Path) -> None:
    source_dir = ROOT / "packaging" / "cache" / target / "licenses"
    if not source_dir.is_dir():
        return
    for source in sorted(source_dir.rglob("*")):
        if allowed_license(source):
            relative = source.relative_to(source_dir)
            target_path = destination / relative
            target_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target_path)


def verify_luts() -> None:
    catalog = json.loads((ROOT / "assets" / "catalog.json").read_text(encoding="utf-8"))
    for entry in catalog["entries"]:
        path = ROOT / "assets" / Path(entry["file"])
        if not path.is_file():
            raise SystemExit(f"Missing LUT; run python3 packaging/prepare_luts.py: {path.name}")
        if digest(path.read_bytes()) != entry["sha256"]:
            raise SystemExit(f"LUT checksum differs from catalog: {path.name}")


def build(target: str) -> dict:
    archive_runtime(target)
    verify_luts()
    goos, goarch = target.split("-")
    folder = ROOT / "dist" / TARGETS[target]
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir(parents=True, exist_ok=True)
    if goos == "darwin":
        bundle = folder / "DJI LUT.app"
        executable = bundle / "Contents" / "MacOS" / "DJILUTApp"
        executable.parent.mkdir(parents=True, exist_ok=True)
        minimum = LOCK["targets"][target]["min_os"].removeprefix("macOS ")
        info = {
            "CFBundleExecutable": "DJILUTApp",
            "CFBundleIdentifier": "local.dji-lut.restore",
            "CFBundleName": "DJI LUT",
            "CFBundleDisplayName": "DJI LUT",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "2.1.0",
            "CFBundleVersion": "3",
            "LSMinimumSystemVersion": minimum,
            "NSHighResolutionCapable": True,
            "LSUIElement": True,
        }
        (bundle / "Contents" / "Info.plist").write_bytes(plistlib.dumps(info))
    else:
        bundle = folder
        executable = folder / "DJI-LUT.exe"

    environment = os.environ.copy()
    environment.update({"CGO_ENABLED": "0", "GOOS": goos, "GOARCH": goarch})
    flags = "-s -w" + (" -H=windowsgui" if goos == "windows" else "")
    run(
        ["go", "build", "-tags", "bundled", "-trimpath", "-ldflags", flags, "-o", str(executable), "./cmd/lutapp"],
        env=environment,
    )
    if goos == "darwin" and shutil.which("codesign"):
        run(["codesign", "--force", "--sign", "-", str(bundle)])

    usage = (ROOT / "docs" / "USAGE.zh-CN.md").read_text(encoding="utf-8")
    (folder / "使用说明.md").write_text(usage, encoding="utf-8")
    for name in ("LICENSE", "THIRD_PARTY.md"):
        shutil.copy2(ROOT / name, folder / name)
    third_party = folder / "THIRD_PARTY.md"
    third_party.write_text(
        third_party.read_text(encoding="utf-8")
        .replace("(packaging/runtime-lock.json)", "(RUNTIME-LOCK.json)")
        .replace("[`assets/SOURCES.md`](assets/SOURCES.md)", "[`LUT-SOURCES.md`](LUT-SOURCES.md)")
        .replace("`packaging/license-lock.json`", "`LICENSE-LOCK.json`"),
        encoding="utf-8",
    )
    shutil.copy2(ROOT / "packaging" / "runtime-lock.json", folder / "RUNTIME-LOCK.json")
    shutil.copy2(ROOT / "packaging" / "license-lock.json", folder / "LICENSE-LOCK.json")
    shutil.copy2(ROOT / "assets" / "SOURCES.md", folder / "LUT-SOURCES.md")
    shutil.copy2(ROOT / "assets" / "catalog.json", folder / "LUT-catalog.json")
    copy_licenses(target, folder / "licenses")

    archive = zip_release(folder)
    return {
        "target": target,
        "executable": str(executable.relative_to(ROOT)),
        "bytes": executable.stat().st_size,
        "sha256": digest(executable.read_bytes()),
        "archive": str(archive.relative_to(ROOT)),
        "archive_sha256": digest(archive.read_bytes()),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("targets", nargs="*", choices=list(TARGETS))
    args = parser.parse_args()
    results = [build(target) for target in (args.targets or list(TARGETS))]
    manifest = ROOT / "dist" / "build-manifest.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(results, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
