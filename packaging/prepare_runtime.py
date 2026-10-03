#!/usr/bin/env python3
"""Fetch and verify FFmpeg runtimes listed in runtime-lock.json."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import tempfile
from urllib.request import Request, urlopen
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LOCK_PATH = ROOT / "packaging" / "runtime-lock.json"
LICENSE_LOCK_PATH = ROOT / "packaging" / "license-lock.json"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_lock() -> dict:
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    if lock.get("schema_version") != 1 or not isinstance(lock.get("targets"), dict):
        raise SystemExit(f"Unsupported runtime lock: {LOCK_PATH}")
    return lock


def ensure_archive(record: dict) -> Path:
    path = ROOT / "packaging" / "downloads" / record["archive"]
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file() and sha256(path.read_bytes()) == record["archive_sha256"]:
        return path
    request = Request(record["url"], headers={"User-Agent": "DJI-LUT-build/1"})
    with urlopen(request, timeout=90) as response:
        data = response.read()
    actual = sha256(data)
    if actual != record["archive_sha256"]:
        raise SystemExit(f"Archive checksum mismatch for {record['url']}: {actual}")
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + ".", delete=False) as tmp:
        tmp.write(data)
        temp_path = Path(tmp.name)
    temp_path.replace(path)
    return path


def prepare(target: str, spec: dict) -> None:
    cache = ROOT / "packaging" / "cache" / target
    bin_dir = cache / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    windows = target.startswith("windows-")
    for tool, record in spec["tools"].items():
        archive = ensure_archive(record)
        try:
            with zipfile.ZipFile(archive) as zipped:
                payload = zipped.read(record["member"])
        except (KeyError, zipfile.BadZipFile) as error:
            raise SystemExit(f"Cannot read {record['member']} from {archive}: {error}") from error
        actual = sha256(payload)
        if actual != record["binary_sha256"]:
            raise SystemExit(f"Binary checksum mismatch for {target}/{tool}: {actual}")
        suffix = ".exe" if windows else ""
        destination = bin_dir / (tool + suffix)
        destination.write_bytes(payload)
        if not windows:
            destination.chmod(0o755)
    license_dir = cache / "licenses"
    license_dir.mkdir(parents=True, exist_ok=True)
    license_lock = json.loads(LICENSE_LOCK_PATH.read_text(encoding="utf-8"))
    ffmpeg_version = next(iter(spec["tools"].values()))["version"].removesuffix("-tessus")
    license_records = {
        "COPYING.GPLv3": license_lock["ffmpeg"][ffmpeg_version],
        "Go-LICENSE": license_lock["go"],
    }
    for filename, record in license_records.items():
        destination = license_dir / filename
        if destination.is_file() and sha256(destination.read_bytes()) == record["sha256"]:
            continue
        request = Request(record["url"], headers={"User-Agent": "DJI-LUT-build/1"})
        with urlopen(request, timeout=30) as response:
            payload = response.read()
        if sha256(payload) != record["sha256"]:
            raise SystemExit(f"License checksum mismatch for {record['url']}")
        with tempfile.NamedTemporaryFile(dir=license_dir, prefix=filename + ".", delete=False) as tmp:
            tmp.write(payload)
            temporary = Path(tmp.name)
        temporary.replace(destination)
    metadata = {
        "schema_version": 1,
        "target": target,
        "platform": spec["platform"],
        "min_os": spec["min_os"],
        "tools": {
            name: {
                "version": record["version"],
                "url": record["url"],
                "archive": record["archive"],
                "archive_sha256": record["archive_sha256"],
                "binary_sha256": record["binary_sha256"],
            }
            for name, record in spec["tools"].items()
        },
    }
    (cache / "metadata-tools.json").write_text(
        json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"Prepared {target} in {cache.relative_to(ROOT)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("targets", nargs="*", help="locked target names; defaults to all targets")
    args = parser.parse_args()
    targets = read_lock()["targets"]
    selected = args.targets or list(targets)
    unknown = sorted(set(selected) - set(targets))
    if unknown:
        parser.error("unknown target(s): " + ", ".join(unknown))
    for target in selected:
        prepare(target, targets[target])


if __name__ == "__main__":
    main()
