#!/usr/bin/env python3
"""Validate the three native build records and prepare GitHub Release assets."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from pathlib import PurePosixPath
import re
import shutil
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = {
    "darwin-arm64": "DJI-LUT-macOS-AppleSilicon.zip",
    "darwin-amd64": "DJI-LUT-macOS-Intel.zip",
    "windows-amd64": "DJI-LUT-Windows-x64.zip",
}


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_build_metadata(metadata: object, target: str, filename: str, archive_path: Path,
                            tag: str, version: str, commit: str) -> dict:
    allowed = {"tag", "version", "commit", "target", "counts", "files"}
    if not isinstance(metadata, dict) or set(metadata) != allowed:
        raise ValueError(f"{target} build metadata has unsupported fields")
    if metadata.get("target") != target or metadata.get("version") != version:
        raise ValueError(f"build metadata target/version mismatch for {target}")
    if metadata.get("tag") != tag or metadata.get("commit") != commit:
        raise ValueError(f"build metadata tag/commit mismatch for {target}")

    counts = metadata.get("counts")
    required_counts = {
        "catalog_entries", "library_assets", "unique_payloads", "embedded_bundle_files",
        "loaded_catalog_entries", "loaded_library_assets", "archive_bytes", "archive_resource_files",
    }
    if not isinstance(counts, dict) or set(counts) != required_counts:
        raise ValueError(f"{target} build metadata has incomplete verification counts")
    if (counts["unique_payloads"] != 40
            or counts["loaded_catalog_entries"] != counts["catalog_entries"]
            or counts["loaded_library_assets"] != counts["library_assets"]
            or counts["embedded_bundle_files"] < counts["unique_payloads"]
            or counts["archive_bytes"] != archive_path.stat().st_size):
        raise ValueError(f"{target} build metadata verification counts do not match the package")

    files = metadata.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError(f"{target} build metadata has no public file hashes")
    by_path: dict[str, str] = {}
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256"}:
            raise ValueError(f"{target} build metadata contains an invalid file record")
        relative = entry["path"]
        checksum = entry["sha256"]
        path = PurePosixPath(relative) if isinstance(relative, str) else PurePosixPath(".")
        if (not isinstance(relative, str) or "\\" in relative or path.is_absolute()
                or any(part in ("", ".", "..") for part in path.parts)
                or not (relative.startswith("embedded/") or relative.startswith("archive/"))):
            raise ValueError(f"{target} build metadata contains a non-relative file path")
        if not isinstance(checksum, str) or re.fullmatch(r"[0-9a-f]{64}", checksum) is None:
            raise ValueError(f"{target} build metadata contains an invalid SHA-256")
        if relative in by_path:
            raise ValueError(f"{target} build metadata repeats a file path")
        by_path[relative] = checksum

    archive_record = f"archive/{filename}"
    if by_path.get(archive_record) != file_sha256(archive_path):
        raise ValueError(f"{target} archive checksum does not match its build metadata")
    archive_members = {
        path: checksum for path, checksum in by_path.items()
        if path.startswith("archive/") and path != archive_record
    }
    if len(archive_members) != counts["archive_resource_files"]:
        raise ValueError(f"{target} resource file count does not match its build metadata")
    if not any(path == "embedded/assets/catalog.json" for path in by_path):
        raise ValueError(f"{target} metadata does not hash the embedded catalog")

    if not zipfile.is_zipfile(archive_path):
        raise ValueError(f"{target} release artifact is not a ZIP archive")
    with zipfile.ZipFile(archive_path) as archive:
        bad = archive.testzip()
        if bad is not None:
            raise ValueError(f"{target} release artifact failed ZIP CRC verification")
        names = archive.namelist()
        for relative, expected_hash in archive_members.items():
            suffix = relative.removeprefix("archive/")
            matches = [name for name in names if name.replace("\\", "/").lower().endswith(suffix.lower())]
            if len(matches) != 1 or hashlib.sha256(archive.read(matches[0])).hexdigest() != expected_hash:
                raise ValueError(f"{target} archive resource hash does not match metadata: {suffix}")
    return metadata


def collect(input_dir: Path, output_dir: Path, tag: str, version: str, commit: str) -> list[Path]:
    if output_dir.exists() and any(output_dir.iterdir()):
        raise ValueError("output directory must be empty")
    output_dir.mkdir(parents=True, exist_ok=True)

    records: list[dict] = []
    pending_archives: list[tuple[Path, str]] = []
    outputs: list[Path] = []
    for target, filename in ARTIFACTS.items():
        archive_candidates = list(input_dir.rglob(filename))
        metadata_candidates = list(input_dir.rglob(f"build-metadata-{target}.json"))
        if len(archive_candidates) != 1 or len(metadata_candidates) != 1:
            raise ValueError(
                f"expected exactly one {filename} and build-metadata-{target}.json; "
                f"found {len(archive_candidates)} and {len(metadata_candidates)}"
            )
        archive_path = archive_candidates[0]
        metadata_path = metadata_candidates[0]
        metadata = validate_build_metadata(
            json.loads(metadata_path.read_text(encoding="utf-8")), target, filename,
            archive_path, tag, version, commit,
        )
        pending_archives.append((archive_path, filename))
        records.append({"target": target, "counts": metadata["counts"], "files": metadata["files"]})

    payload_counts = {item["counts"]["unique_payloads"] for item in records}
    if len(payload_counts) != 1:
        raise ValueError("native targets disagree about the embedded LUT payload count")
    manifest = {
        "tag": tag,
        "version": version,
        "commit": commit,
        "counts": {"native_targets": len(records), "archives": len(records), "unique_payloads": payload_counts.pop()},
        "artifacts": sorted(records, key=lambda item: item["target"]),
    }

    for archive_path, filename in pending_archives:
        destination = output_dir / filename
        shutil.copy2(archive_path, destination)
        outputs.append(destination)
    metadata_output = output_dir / "BUILD-METADATA.json"
    metadata_output.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    outputs.append(metadata_output)

    checksums = "".join(f"{file_sha256(path)}  {path.name}\n" for path in sorted(outputs, key=lambda item: item.name))
    checksum_output = output_dir / "SHA256SUMS"
    checksum_output.write_text(checksums, encoding="ascii")
    outputs.append(checksum_output)
    return outputs


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    outputs = collect(args.input.resolve(), args.output.resolve(), args.tag, args.version, args.commit)
    for output in outputs:
        print(output.name)


if __name__ == "__main__":
    try:
        main()
    except OSError as error:
        print(f"Release artifact collection failed with an operating system error ({type(error).__name__})", file=sys.stderr)
        raise SystemExit(1) from error
    except (ValueError, KeyError, zipfile.BadZipFile) as error:
        print(f"Release artifact collection failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
