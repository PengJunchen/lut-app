#!/usr/bin/env python3
"""Seed the locked LUT payloads from the pinned native rc0.0.1 release."""
from __future__ import annotations

import argparse
import hashlib
import os
import platform
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
from urllib.request import Request, urlopen
import zipfile

import prepare_luts

ROOT = Path(__file__).resolve().parents[1]
CHUNK_SIZE = 1024 * 1024
EXPECTED_PAYLOAD_COUNT = 40
RELEASE_BASE_URL = "https://github.com/PengJunchen/lut-app/releases/download/rc0.0.1"
RELEASES = {
    "darwin-arm64": {
        "host": "darwin",
        "machines": {"arm64", "aarch64"},
        "go_os": "darwin",
        "go_arch": "arm64",
        "archive": "DJI-LUT-macOS-AppleSilicon.zip",
        "archive_sha256": "baaedfaedd8ccc7503c733df0c0e2fd44b90d86ccd62c74da0437bc350f704ab",
        "engine_member": "DJI LUT.app/Contents/Resources/engine/engine",
        "engine_name": "engine",
    },
    "darwin-amd64": {
        "host": "darwin",
        "machines": {"x86_64", "amd64"},
        "go_os": "darwin",
        "go_arch": "amd64",
        "archive": "DJI-LUT-macOS-Intel.zip",
        "archive_sha256": "7a384c0e655faaecbac4c7eadc14f649b67694598ab6f27735190ee38af0813a",
        "engine_member": "DJI LUT.app/Contents/Resources/engine/engine",
        "engine_name": "engine",
    },
    "windows-amd64": {
        "host": "windows",
        "machines": {"amd64", "x86_64"},
        "go_os": "windows",
        "go_arch": "amd64",
        "archive": "DJI-LUT-Windows-x64.zip",
        "archive_sha256": "e6a8bc5b02d23878da14dd4bc6520645cd21ed2893cdb7fc1a7c06bca90ab516",
        "engine_member": "resources/engine/engine.exe",
        "engine_name": "engine.exe",
    },
}


class BootstrapError(RuntimeError):
    """The pinned native release could not provide verified LUT payloads."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_native_target(
    target: str, *, host: str | None = None, machine: str | None = None
) -> dict:
    lock = RELEASES.get(target)
    if lock is None:
        raise BootstrapError(f"unsupported LUT bootstrap target: {target}")
    if host is None:
        host = "windows" if sys.platform == "win32" else sys.platform
    if machine is None:
        machine = platform.machine().lower()
    machine = machine.lower()
    if host != lock["host"] or machine not in lock["machines"]:
        raise BootstrapError(
            f"{target} LUT bootstrap requires native {lock['host']}/"
            f"{sorted(lock['machines'])}; this runner reports {host}/{machine}"
        )
    return lock


def normal_user_cache_parent() -> Path:
    """Return the same OS cache location used by Go's os.UserCacheDir."""
    if sys.platform == "win32":
        cache = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        cache = Path.home() / "Library" / "Caches"
    else:
        cache = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return cache / "DJILUTApp" / "bundles"


def download_release_archive(target: str, destination: Path) -> Path:
    lock = RELEASES[target]
    url = f"{RELEASE_BASE_URL}/{lock['archive']}"
    request = Request(url, headers={"User-Agent": "DJI-LUT-CI-bootstrap/1"})
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    digest = hashlib.sha256()
    try:
        with urlopen(request, timeout=600) as response, tempfile.NamedTemporaryFile(
            dir=destination.parent, prefix=destination.name + ".", delete=False
        ) as output:
            temporary = Path(output.name)
            for chunk in iter(lambda: response.read(CHUNK_SIZE), b""):
                digest.update(chunk)
                output.write(chunk)
        actual = digest.hexdigest()
        if actual.lower() != lock["archive_sha256"]:
            raise BootstrapError(
                f"rc0.0.1 {target} release ZIP checksum mismatch: {actual}"
            )
        temporary.replace(destination)
        temporary = None
        return destination
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def extract_verified_engine(archive_path: Path, target: str, destination: Path) -> Path:
    lock = RELEASES[target]
    if archive_path.is_symlink() or not archive_path.is_file():
        raise BootstrapError("pinned release ZIP is missing or is not a regular file")
    actual = sha256_file(archive_path)
    if actual.lower() != lock["archive_sha256"]:
        raise BootstrapError(f"rc0.0.1 {target} release ZIP checksum mismatch: {actual}")

    try:
        with zipfile.ZipFile(archive_path) as archive:
            matches = [
                item for item in archive.infolist()
                if item.filename == lock["engine_member"]
            ]
            if len(matches) != 1:
                raise BootstrapError(
                    f"rc0.0.1 {target} ZIP must contain exactly one native engine; "
                    f"found {len(matches)}"
                )
            member = matches[0]
            mode = member.external_attr >> 16
            file_type = stat.S_IFMT(mode)
            if (
                member.is_dir()
                or stat.S_ISLNK(mode)
                or file_type not in (0, stat.S_IFREG)
                or member.file_size <= 0
            ):
                raise BootstrapError("pinned release engine is not a regular non-empty file")
            destination.mkdir(parents=True, exist_ok=True)
            engine_path = destination / lock["engine_name"]
            with archive.open(member, "r") as source, engine_path.open("xb") as output:
                shutil.copyfileobj(source, output, CHUNK_SIZE)
    except zipfile.BadZipFile as error:
        raise BootstrapError(f"invalid pinned release ZIP: {error}") from error
    except (OSError, RuntimeError, zipfile.LargeZipFile) as error:
        raise BootstrapError(f"cannot extract pinned native engine: {error}") from error

    if not engine_path.is_file() or engine_path.is_symlink():
        raise BootstrapError("extracted native engine is missing or is not a regular file")
    if target.startswith("darwin-"):
        engine_path.chmod(0o700)
    return engine_path


def _payload_path(root: Path, relative: str) -> Path | None:
    try:
        safe_relative = prepare_luts.safe_relative_path(relative)
    except prepare_luts.LUTError:
        return None
    path = root
    for index, part in enumerate(safe_relative.parts):
        path = path / part
        try:
            mode = path.lstat().st_mode
        except OSError:
            return None
        if stat.S_ISLNK(mode):
            return None
        if index == len(safe_relative.parts) - 1:
            if not stat.S_ISREG(mode):
                return None
        elif not stat.S_ISDIR(mode):
            return None
    return path


def verified_lut_cache(
    cache_parent: Path, target: str, records: list[dict]
) -> Path:
    lock = RELEASES[target]
    if cache_parent.is_symlink() or not cache_parent.is_dir():
        raise BootstrapError("native release engine did not create its OS bundle cache")
    prefix = f"{lock['go_os']}-{lock['go_arch']}-"
    try:
        candidates = sorted(
            (item for item in cache_parent.iterdir()
             if item.name.startswith(prefix) and item.is_dir() and not item.is_symlink()),
            key=lambda item: item.name,
        )
    except OSError as error:
        raise BootstrapError(f"cannot inspect native release bundle cache: {error}") from error

    for candidate in candidates:
        assets_root = candidate / "assets"
        lut_root = assets_root / "luts"
        if (
            assets_root.is_symlink()
            or not assets_root.is_dir()
            or lut_root.is_symlink()
            or not lut_root.is_dir()
        ):
            continue
        valid = True
        for record in records:
            payload = _payload_path(lut_root, record["file"])
            if payload is None:
                valid = False
                break
            try:
                if sha256_file(payload).lower() != record["sha256"].lower():
                    valid = False
                    break
            except OSError:
                valid = False
                break
        if valid:
            return lut_root
    raise BootstrapError(
        "native release bundle cache is missing or differs from the current "
        "40-payload SHA-256 lock"
    )


def load_locked_payloads(root: Path, expected_count: int = EXPECTED_PAYLOAD_COUNT) -> list[dict]:
    library, records = prepare_luts.payload_records(root)
    if library is None:
        raise BootstrapError("LUT bootstrap requires the current schema-1 asset library")
    if len(records) != expected_count:
        raise BootstrapError(
            f"pinned rc0.0.1 release contains {EXPECTED_PAYLOAD_COUNT} unique LUT payloads; "
            f"current lock declares {len(records)}"
        )
    return records


def bootstrap(
    target: str,
    *,
    archive_path: Path | None = None,
    root: Path = ROOT,
    cache_parent: Path | None = None,
    host: str | None = None,
    machine: str | None = None,
    expected_count: int = EXPECTED_PAYLOAD_COUNT,
    run_command=subprocess.run,
) -> int:
    lock = validate_native_target(target, host=host, machine=machine)
    records = load_locked_payloads(root, expected_count)

    with tempfile.TemporaryDirectory(prefix="dji-lut-release-bootstrap-") as scratch:
        scratch_root = Path(scratch)
        if archive_path is None:
            print(
                f"[{target}] Downloading and verifying pinned rc0.0.1 ZIP "
                f"for {len(records)} LUT payloads",
                flush=True,
            )
            archive_path = download_release_archive(
                target, scratch_root / lock["archive"]
            )
        else:
            print(
                f"[{target}] Verifying supplied pinned rc0.0.1 ZIP "
                f"for {len(records)} LUT payloads",
                flush=True,
            )
        engine_path = extract_verified_engine(
            archive_path, target, scratch_root / "native-engine"
        )
        input_dir = scratch_root / "empty-input"
        input_dir.mkdir()
        command = [
            str(engine_path),
            "--batch",
            "--dry-run",
            f"--input={input_dir}",
        ]
        print(f"[{target}] Starting native engine with an empty input directory", flush=True)
        try:
            result = run_command(
                command,
                cwd=scratch_root,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
                timeout=180,
            )
        except subprocess.TimeoutExpired as error:
            raise BootstrapError(
                f"pinned rc0.0.1 {target} engine timed out after 180 seconds"
            ) from error
        if result.returncode != 0:
            raise BootstrapError(
                f"pinned rc0.0.1 {target} engine failed to prepare its verified bundle "
                f"(exit {result.returncode})"
            )

        print(f"[{target}] Verifying native cache payload hashes", flush=True)
        if cache_parent is None:
            cache_parent = normal_user_cache_parent()
        source_dir = verified_lut_cache(cache_parent, target, records)
        print(f"[{target}] Rechecking {len(records)} LUT payloads with current prepare_luts", flush=True)
        prepared = prepare_luts.prepare(source_dir, root)
        if prepared != len(records):
            raise BootstrapError(
                f"current prepare_luts prepared {prepared} payloads; expected {len(records)}"
            )
        return prepared


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=sorted(RELEASES))
    parser.add_argument(
        "--archive",
        type=Path,
        help="already downloaded rc0.0.1 ZIP (still checked against its pinned SHA-256)",
    )
    args = parser.parse_args()
    try:
        count = bootstrap(args.target, archive_path=args.archive)
    except (BootstrapError, prepare_luts.LUTError, OSError) as error:
        parser.exit(1, f"{error}\n")
    print(f"Bootstrapped and re-verified {count} LUT payloads for {args.target}")


if __name__ == "__main__":
    main()
