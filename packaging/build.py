#!/usr/bin/env python3
"""Build release bundles from verified local runtimes and LUT assets."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tarfile
import zipfile


def _load_prepare_luts():
    """Load the sibling helper by exact path, even when imported by another script."""
    helper_path = Path(__file__).resolve().with_name("prepare_luts.py")
    spec = importlib.util.spec_from_file_location("dji_lut_prepare_luts", helper_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load LUT packaging helpers from {helper_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_prepare_luts = _load_prepare_luts()
LUTError = _prepare_luts.LUTError
load_catalog = _prepare_luts.load_catalog
load_library = _prepare_luts.load_library
safe_relative_path = _prepare_luts.safe_relative_path
file_sha256 = _prepare_luts.sha256
validate_sha256 = _prepare_luts.validate_sha256

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


def _catalog_file(entry: dict, index: int, legacy_shape: bool) -> str:
    raw_file = entry.get("file")
    if legacy_shape and isinstance(raw_file, str) and raw_file.startswith("luts/"):
        raw_file = raw_file[len("luts/"):]
    try:
        return safe_relative_path(raw_file, f"catalog entry {index} file").as_posix()
    except LUTError as error:
        raise SystemExit(f"Invalid LUT catalog: {error}") from error


def _catalog_hash(entry: dict, index: int) -> str:
    try:
        return validate_sha256(entry.get("sha256"), f"catalog entry {index} sha256")
    except LUTError as error:
        raise SystemExit(f"Invalid LUT catalog: {error}") from error


def _check_payload(root: Path, relative: str, expected: str, label: str) -> None:
    path = root / "assets" / "luts" / Path(*relative.split("/"))
    if path.is_symlink() or not path.is_file():
        raise SystemExit(
            f"Missing LUT payload {relative}; run python3 packaging/prepare_luts.py"
        )
    actual = file_sha256(path)
    if actual.lower() != expected.lower():
        raise SystemExit(
            f"LUT checksum differs from {label} for {relative}: expected {expected}, got {actual}"
        )


def _catalog_payloads(
    root: Path,
    entries: list[dict],
    *,
    library: dict | None,
    legacy_shape: bool,
) -> set[str]:
    if library is None:
        expected: set[str] = set()
        for index, entry in enumerate(entries):
            relative = _catalog_file(entry, index, legacy_shape=True)
            checksum = _catalog_hash(entry, index)
            _check_payload(root, relative, checksum, "catalog")
            expected.add(relative)
        return expected

    assets_by_id = {asset["id"]: asset for asset in library["assets"]}
    expected = {asset["file"] for asset in library["assets"]}
    for index, entry in enumerate(entries):
        library_id = entry.get("library_id")
        if library_id is None and legacy_shape:
            relative = _catalog_file(entry, index, legacy_shape=True)
            checksum = _catalog_hash(entry, index)
            _check_payload(root, relative, checksum, "legacy catalog")
            expected.add(relative)
            continue
        if not isinstance(library_id, str) or library_id not in assets_by_id:
            raise SystemExit(
                f"Catalog entry {index} must reference a known library_id when library.json is present"
            )
        asset = assets_by_id[library_id]
        relative = _catalog_file(entry, index, legacy_shape=False)
        checksum = _catalog_hash(entry, index)
        if relative != asset["file"] or checksum != asset["sha256"]:
            raise SystemExit(
                f"Catalog entry {index} file/checksum does not match library asset {library_id}"
            )
        camera = entry.get("camera")
        cameras = asset.get("cameras")
        camera_ids = {
            camera_record.get("id")
            for camera_record in cameras
            if isinstance(camera_record, dict) and isinstance(camera_record.get("id"), str)
        } if isinstance(cameras, list) else set()
        if not isinstance(camera, str) or camera not in camera_ids:
            raise SystemExit(
                f"Catalog entry {index} camera does not match library asset {library_id}"
            )
        for field in (
            "profile",
            "look",
            "version",
            "title",
            "grid",
            "format",
            "output_color_space",
            "purpose",
        ):
            if field in entry and entry[field] != asset.get(field):
                raise SystemExit(
                    f"Catalog entry {index} {field} does not match library asset {library_id}"
                )
        dimension = str(asset.get("dimension", "")).strip().lower()
        has_1d_signal = dimension in {"1", "1d", "1-d"} or asset.get("lut_1d_size") not in (
            None, "", 0, "0"
        )
        grid = asset.get("grid")
        if (
            asset.get("automatic") is not True
            or asset.get("profile") not in {"dlog", "dlog2", "dlogm"}
            or asset.get("output_color_space") != "rec709"
            or asset.get("purpose") != "restore"
            or asset.get("format") != "cube"
            or not isinstance(grid, int)
            or isinstance(grid, bool)
            or grid < 2
            or has_1d_signal
        ):
            raise SystemExit(
                f"Catalog entry {index} references a non-automatic-safe Log-to-Rec.709 library asset: {library_id}"
            )
    return expected


def _payload_file_set(root: Path) -> set[str]:
    lut_root = root / "assets" / "luts"
    if lut_root.is_symlink():
        raise SystemExit(f"Refusing symlinked LUT directory: {lut_root}")
    if not lut_root.exists():
        return set()
    if not lut_root.is_dir():
        raise SystemExit(f"LUT payload path is not a directory: {lut_root}")
    found: set[str] = set()
    seen_casefold: set[str] = set()
    for path in lut_root.rglob("*"):
        if path.is_symlink():
            raise SystemExit(f"Unexpected symlink in LUT payload tree: {path}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise SystemExit(f"Unexpected non-file entry in LUT payload tree: {path}")
        relative = path.relative_to(lut_root).as_posix()
        try:
            normalized = safe_relative_path(relative, "payload path").as_posix()
        except LUTError as error:
            raise SystemExit(f"Unexpected payload file: {error}") from error
        key = normalized.casefold()
        if key in seen_casefold:
            raise SystemExit(f"Case-colliding payload paths are not portable: {normalized}")
        seen_casefold.add(key)
        found.add(normalized)
    return found


def verify_luts(root: Path = ROOT) -> None:
    """Verify every library/catalog asset and reject stale embedded payloads."""
    try:
        library = load_library(root)
        _, entries, legacy_shape = load_catalog(root)
    except LUTError as error:
        raise SystemExit(f"Invalid LUT manifests: {error}") from error

    expected: set[str] = set()
    if library is not None:
        for asset in library["assets"]:
            relative = asset["file"]
            _check_payload(root, relative, asset["sha256"], "library")
            expected.add(relative)
    expected.update(
        _catalog_payloads(root, entries, library=library, legacy_shape=legacy_shape)
    )
    actual = _payload_file_set(root)
    missing = sorted(expected - actual)
    unexpected = sorted(actual - expected)
    if missing or unexpected:
        details = []
        if missing:
            details.append("missing: " + ", ".join(missing))
        if unexpected:
            details.append("unexpected/stale: " + ", ".join(unexpected))
        raise SystemExit(
            "LUT payload set differs from the current manifest ("
            + "; ".join(details)
            + "). Run python3 packaging/prepare_luts.py."
        )


def build(target: str) -> dict:
    verify_luts()
    archive_runtime(target)
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
            "CFBundleShortVersionString": "0.0.1",
            "CFBundleVersion": "0.0.1",
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
    library_manifest = ROOT / "assets" / "library.json"
    if library_manifest.is_file():
        shutil.copy2(library_manifest, folder / "LUT-library.json")
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
