#!/usr/bin/env python3
"""Acquire, verify, and transactionally publish the locked DJI LUT payloads."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
from typing import BinaryIO
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CHUNK_SIZE = 1024 * 1024
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")


class LUTError(ValueError):
    """Invalid manifest, source, archive, or payload."""


class MissingPayload(LUTError):
    """No supplied, cached, or downloadable payload is available."""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_stream(source: BinaryIO, destination: Path, expected: str, label: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    digest = hashlib.sha256()
    try:
        with tempfile.NamedTemporaryFile(
            dir=destination.parent, prefix=destination.name + ".", delete=False
        ) as output:
            temporary = Path(output.name)
            for chunk in iter(lambda: source.read(CHUNK_SIZE), b""):
                digest.update(chunk)
                output.write(chunk)
        actual = digest.hexdigest()
        if actual.lower() != expected.lower():
            raise LUTError(f"SHA-256 mismatch for {label}: expected {expected}, got {actual}")
        temporary.replace(destination)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def validate_sha256(value: object, label: str) -> str:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        raise LUTError(f"{label} must be a 64-character SHA-256 hex digest")
    return value.lower()


def safe_relative_path(value: object, label: str = "file") -> PurePosixPath:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise LUTError(f"{label} must be a non-empty relative POSIX path")
    if "\\" in value or "\x00" in value:
        raise LUTError(f"{label} contains an invalid path separator or NUL")
    path = PurePosixPath(value)
    if path.is_absolute() or path.as_posix() != value:
        raise LUTError(f"{label} must be a normalized relative POSIX path: {value}")
    if not path.parts or any(part in ("", ".", "..") for part in path.parts):
        raise LUTError(f"{label} contains an unsafe path component: {value}")
    if path.parts[0].casefold() in {"luts", "assets"}:
        raise LUTError(f"{label} must be relative to assets/luts without a luts/ prefix: {value}")
    for part in path.parts:
        if any(char in part for char in '<>:"|?*') or part.endswith((" ", ".")):
            raise LUTError(f"{label} is not portable to Windows: {value}")
        if part.split(".", 1)[0].upper() in {
            "CON", "PRN", "AUX", "NUL",
            *(f"COM{i}" for i in range(1, 10)),
            *(f"LPT{i}" for i in range(1, 10)),
        }:
            raise LUTError(f"{label} uses a reserved Windows filename: {value}")
    if not path.suffix:
        raise LUTError(f"{label} must have a file extension: {value}")
    return path


def safe_archive_member(value: object) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise LUTError("archive_member must be a non-empty exact ZIP member name")
    if "\\" in value or "\x00" in value:
        raise LUTError(f"archive_member contains an invalid separator: {value}")
    member = PurePosixPath(value)
    if member.is_absolute() or member.as_posix() != value:
        raise LUTError(f"archive_member must be a normalized relative path: {value}")
    if not member.parts or any(part in ("", ".", "..") for part in member.parts):
        raise LUTError(f"archive_member contains an unsafe path component: {value}")
    return value


def _schema_version(document: dict) -> object:
    for key in ("schema_version", "schema", "version"):
        if key in document:
            return document[key]
    return None


def read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise LUTError(f"cannot read JSON manifest {path}: {error}") from error


def load_library(root: Path = ROOT) -> dict | None:
    """Return a normalized schema-1 library, or None for no/legacy library."""
    path = root / "assets" / "library.json"
    if not path.is_file():
        return None
    document = read_json(path)
    if isinstance(document, list):
        return None
    if not isinstance(document, dict):
        raise LUTError("assets/library.json must contain a JSON object")
    if "assets" not in document:
        if "entries" in document or "luts" in document:
            return None
        raise LUTError("assets/library.json must contain an assets array")
    version = _schema_version(document)
    if type(version) is not int or version != 1:
        raise LUTError(f"unsupported assets/library.json schema: {version!r}")
    records = document.get("assets")
    if not isinstance(records, list) or not records:
        raise LUTError("assets/library.json assets must be a non-empty array")

    seen_ids: set[str] = set()
    seen_files: dict[str, tuple[str, tuple[object, ...]]] = {}
    normalized: list[dict] = []
    for index, original in enumerate(records):
        label = f"library asset {index}"
        if not isinstance(original, dict):
            raise LUTError(f"{label} must be an object")
        asset_id = original.get("id")
        if not isinstance(asset_id, str) or not asset_id.strip() or asset_id != asset_id.strip():
            raise LUTError(f"{label} requires a non-empty id")
        if any(char in asset_id for char in "/\\\x00"):
            raise LUTError(f"{label} id must not contain path separators")
        if asset_id in seen_ids:
            raise LUTError(f"duplicate library asset id: {asset_id}")
        seen_ids.add(asset_id)

        relative = safe_relative_path(original.get("file"), f"{label} file")
        file_key = relative.as_posix().casefold()

        asset_hash = validate_sha256(original.get("sha256"), f"{label} sha256")
        raw_format = original.get("format")
        if not isinstance(raw_format, str) or not raw_format.strip():
            raise LUTError(f"{label} requires a format")
        asset_format = raw_format.strip().lower().removeprefix(".")
        if asset_format != relative.suffix[1:].lower():
            raise LUTError(f"{label} format {raw_format!r} does not match {relative.suffix}")
        content_shape = (
            asset_hash,
            asset_format,
            original.get("grid"),
            original.get("dimension"),
        )
        prior_file = seen_files.get(file_key)
        if prior_file is not None:
            prior_name, prior_shape = prior_file
            if prior_name != relative.as_posix():
                raise LUTError(f"case-colliding library files are not portable: {relative}")
            if prior_shape != content_shape:
                raise LUTError(
                    f"shared library file has conflicting hash, format, or grid/dimension: {relative}"
                )
        else:
            seen_files[file_key] = (relative.as_posix(), content_shape)

        source_url = original.get("source_url", "")
        if source_url is None:
            source_url = ""
        if not isinstance(source_url, str):
            raise LUTError(f"{label} source_url must be a string")
        archive_member = original.get("archive_member")
        archive_hash = original.get("archive_sha256")
        if (archive_member is None) != (archive_hash is None):
            raise LUTError(f"{label} archive_member and archive_sha256 must be supplied together")
        if archive_member is not None:
            archive_member = safe_archive_member(archive_member)
            archive_hash = validate_sha256(archive_hash, f"{label} archive_sha256")

        record = dict(original)
        record.update({
            "id": asset_id,
            "file": relative.as_posix(),
            "sha256": asset_hash,
            "format": asset_format,
            "source_url": source_url,
            "archive_member": archive_member,
            "archive_sha256": archive_hash,
        })
        normalized.append(record)
    return {"document": document, "assets": normalized, "legacy": False}


def load_catalog(root: Path = ROOT) -> tuple[object, list[dict], bool]:
    path = root / "assets" / "catalog.json"
    document = read_json(path)
    if isinstance(document, list):
        entries = document
        legacy_shape = True
    elif isinstance(document, dict):
        if isinstance(document.get("entries"), list):
            entries = document["entries"]
            legacy_shape = False
        elif isinstance(document.get("luts"), list):
            entries = document["luts"]
            legacy_shape = True
        else:
            raise LUTError("assets/catalog.json must contain an entries or luts array")
    else:
        raise LUTError("assets/catalog.json must contain a JSON array or object")
    if not entries:
        raise LUTError("assets/catalog.json contains no LUT entries")
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise LUTError(f"catalog entry {index} must be an object")
    return document, entries, legacy_shape


def _legacy_catalog_records(root: Path) -> list[dict]:
    _, entries, _ = load_catalog(root)
    records_by_file: dict[str, dict] = {}
    for index, entry in enumerate(entries):
        raw_file = entry.get("file")
        if isinstance(raw_file, str) and raw_file.startswith("luts/"):
            raw_file = raw_file[len("luts/"):]
        relative = safe_relative_path(raw_file, f"catalog entry {index} file")
        checksum = validate_sha256(entry.get("sha256"), f"catalog entry {index} sha256")
        key = relative.as_posix().casefold()
        existing = records_by_file.get(key)
        if existing is not None:
            if existing["sha256"] != checksum:
                raise LUTError(f"legacy catalog maps one file to different checksums: {relative}")
            continue
        extension = relative.suffix[1:].lower()
        source_url = entry.get("source_url", "")
        if source_url is None:
            source_url = ""
        if not isinstance(source_url, str):
            source_url = ""
        records_by_file[key] = {
            "id": f"legacy-{index}",
            "file": relative.as_posix(),
            "sha256": checksum,
            "format": extension,
            "source_url": source_url,
            "archive_member": None,
            "archive_sha256": None,
            "_legacy": True,
        }
    return list(records_by_file.values())


def payload_records(root: Path = ROOT) -> tuple[dict | None, list[dict]]:
    library = load_library(root)
    if library is not None:
        grouped: dict[str, dict] = {}
        for asset in library["assets"]:
            key = asset["file"].casefold()
            selected = grouped.get(key)
            if selected is None:
                selected = dict(asset)
                selected["_source_aliases"] = []
                grouped[key] = selected
            elif not selected.get("source_url") and asset.get("source_url"):
                selected.update({
                    key: value for key, value in asset.items()
                    if not key.startswith("_")
                })
            aliases = selected["_source_aliases"]
            source_url = asset.get("source_url", "")
            if source_url:
                name = PurePosixPath(unquote(urlparse(source_url).path)).name
                if name and name not in aliases:
                    aliases.append(name)
            source_filename = asset.get("source_filename")
            if isinstance(source_filename, str):
                name = PurePosixPath(source_filename.replace("\\", "/")).name
                if name and name not in aliases:
                    aliases.append(name)
            member = asset.get("archive_member")
            if isinstance(member, str):
                name = PurePosixPath(member).name
                if name and name not in aliases:
                    aliases.append(name)
        return library, list(grouped.values())
    return None, _legacy_catalog_records(root)


def official_https_url(url: str) -> bool:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower().rstrip(".")
    try:
        valid_port = parsed.port in (None, 443)
    except ValueError:
        return False
    return (
        parsed.scheme.lower() == "https"
        and parsed.username is None
        and parsed.password is None
        and valid_port
        and (
        host == "dji.com" or host.endswith(".dji.com")
        or host == "djicdn.com" or host.endswith(".djicdn.com")
        )
    )


def validate_dji_url(url: str) -> None:
    if not official_https_url(url):
        raise LUTError(f"download URL must use official DJI HTTPS hosts: {url}")


def download_verified(url: str, destination: Path, expected_sha: str) -> None:
    validate_dji_url(url)
    request = Request(url, headers={"User-Agent": "DJI-LUT-build/2"})
    temporary: Path | None = None
    digest = hashlib.sha256()
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urlopen(request, timeout=90) as response:
            final_url = response.geturl()
            validate_dji_url(final_url)
            with tempfile.NamedTemporaryFile(
                dir=destination.parent, prefix=destination.name + ".", delete=False
            ) as output:
                temporary = Path(output.name)
                for chunk in iter(lambda: response.read(CHUNK_SIZE), b""):
                    digest.update(chunk)
                    output.write(chunk)
        actual = digest.hexdigest()
        if actual.lower() != expected_sha.lower():
            raise LUTError(f"download checksum mismatch for {url}: {actual}")
        temporary.replace(destination)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def extract_zip_member(
    archive_path: Path,
    member_name: str,
    archive_sha: str,
    payload_sha: str,
    destination: Path,
) -> None:
    member_name = safe_archive_member(member_name)
    actual_archive_sha = sha256(archive_path)
    if actual_archive_sha.lower() != archive_sha.lower():
        raise LUTError(
            f"archive checksum mismatch for {archive_path.name}: "
            f"expected {archive_sha}, got {actual_archive_sha}"
        )
    try:
        with zipfile.ZipFile(archive_path) as archive:
            matches = [item for item in archive.infolist() if item.filename == member_name]
            if len(matches) != 1:
                raise LUTError(
                    f"ZIP must contain exactly one member named {member_name!r}; found {len(matches)}"
                )
            member = matches[0]
            mode = member.external_attr >> 16
            if member.is_dir() or stat.S_ISLNK(mode):
                raise LUTError(f"ZIP member is not a regular file: {member_name}")
            if member.flag_bits & 0x1:
                raise LUTError(f"encrypted ZIP members are not supported: {member_name}")
            with archive.open(member, "r") as payload:
                sha256_stream(payload, destination, payload_sha, f"{archive_path.name}:{member_name}")
    except zipfile.BadZipFile as error:
        raise LUTError(f"invalid ZIP archive {archive_path}: {error}") from error


def _verified_file(source: Path, destination: Path, expected_sha: str, label: str) -> None:
    if not source.is_file():
        raise MissingPayload(f"missing LUT payload: {source}")
    actual = sha256(source)
    if actual.lower() != expected_sha.lower():
        raise LUTError(f"SHA-256 mismatch for {label}: expected {expected_sha}, got {actual}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with source.open("rb") as input_file, tempfile.NamedTemporaryFile(
            dir=destination.parent, prefix=destination.name + ".", delete=False
        ) as output:
            temporary = Path(output.name)
            shutil.copyfileobj(input_file, output, CHUNK_SIZE)
        temporary.replace(destination)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _manual_source(
    source_dir: Path | None, record: dict, relative: PurePosixPath
) -> Path | None:
    if source_dir is None:
        return None
    candidates = [source_dir.joinpath(*relative.parts), source_dir / relative.name]
    for alias in record.get("_source_aliases", []):
        if isinstance(alias, str) and alias and alias not in (".", ".."):
            candidates.append(source_dir / alias)
    for field in ("source_filename", "original_filename"):
        value = record.get(field)
        if isinstance(value, str) and value.strip():
            name = PurePosixPath(value.replace("\\", "/")).name
            if name and name not in (".", ".."):
                candidates.append(source_dir / name)
    source_url = record.get("source_url", "")
    if source_url:
        name = PurePosixPath(unquote(urlparse(source_url).path)).name
        if name:
            candidates.append(source_dir / name)
    member = record.get("archive_member")
    if isinstance(member, str):
        member_path = PurePosixPath(member)
        candidates.extend((source_dir.joinpath(*member_path.parts), source_dir / member_path.name))

    found: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        if candidate.is_file():
            found.append(candidate)
    if not found:
        return None
    expected = record["sha256"]
    for candidate in found:
        if sha256(candidate).lower() == expected.lower():
            return candidate
    raise LUTError(
        "supplied source file checksum mismatch for "
        + record["file"]
        + ": "
        + ", ".join(str(path) for path in found)
    )


def _downloadable(record: dict, library_present: bool) -> bool:
    if not record.get("source_url"):
        return False
    if not library_present and not record.get("archive_member"):
        # Older catalog entries sometimes used a product page as source_url.
        return urlparse(record["source_url"]).path.lower().endswith("." + record["format"])
    return True


def _resolve_record(
    record: dict,
    source_dir: Path | None,
    existing_luts: Path,
    cache_dir: Path,
    destination: Path,
    library_present: bool,
) -> None:
    relative = safe_relative_path(record["file"])
    expected = record["sha256"]
    manual = _manual_source(source_dir, record, relative)
    if manual is not None:
        _verified_file(manual, destination, expected, f"supplied file {manual}")
        return

    existing = existing_luts.joinpath(*relative.parts)
    if existing.is_file() and sha256(existing).lower() == expected.lower():
        _verified_file(existing, destination, expected, f"existing file {existing}")
        return

    source_url = record.get("source_url", "")
    if record.get("archive_member"):
        archive_hash = record["archive_sha256"]
        cache_path = cache_dir / f"archive-{archive_hash}.zip"
        if cache_path.is_file() and sha256(cache_path).lower() != archive_hash.lower():
            cache_path.unlink()
        if not cache_path.is_file():
            if not _downloadable(record, library_present):
                raise MissingPayload(f"source_dir required for {record['file']}")
            download_verified(source_url, cache_path, archive_hash)
        extract_zip_member(
            cache_path, record["archive_member"], archive_hash, expected, destination
        )
        return

    cache_path = cache_dir / f"asset-{expected}.payload"
    if cache_path.is_file() and sha256(cache_path).lower() != expected.lower():
        cache_path.unlink()
    if not cache_path.is_file():
        if not _downloadable(record, library_present):
            raise MissingPayload(f"source_dir required for {record['file']}")
        download_verified(source_url, cache_path, expected)
    _verified_file(cache_path, destination, expected, f"cached asset {record['file']}")


def _publish_tree(stage: Path, destination: Path, temporary_root: Path) -> None:
    if destination.is_symlink() or (destination.exists() and not destination.is_dir()):
        raise LUTError(f"refusing to replace non-directory LUT root: {destination}")
    backup: Path | None = None
    if destination.exists():
        backup = temporary_root / f"luts-backup-{uuid.uuid4().hex}"
        os.replace(destination, backup)
    try:
        os.replace(stage, destination)
    except Exception:
        if backup is not None and backup.exists():
            os.replace(backup, destination)
            backup = None
        raise
    if backup is not None:
        shutil.rmtree(backup)


def prepare(source_dir: Path | None, root: Path = ROOT) -> int:
    library, records = payload_records(root)
    if not records:
        raise LUTError("no LUT payloads are declared by assets/library.json or assets/catalog.json")
    if source_dir is not None:
        source_dir = source_dir.expanduser().resolve()
        if not source_dir.is_dir():
            raise LUTError(f"--source-dir is not a directory: {source_dir}")

    assets_dir = root / "assets"
    destination = assets_dir / "luts"
    temporary_root = root / "packaging" / "tmp"
    cache_dir = root / "packaging" / "downloads"
    temporary_root.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    stage: Path | None = Path(tempfile.mkdtemp(prefix="luts-stage-", dir=temporary_root))
    missing: list[str] = []
    try:
        seen: set[str] = set()
        for record in records:
            relative = safe_relative_path(record["file"])
            key = relative.as_posix().casefold()
            if key in seen:
                raise LUTError(f"duplicate payload file in manifest: {relative}")
            seen.add(key)
            staged_file = stage.joinpath(*relative.parts)
            staged_file.parent.mkdir(parents=True, exist_ok=True)
            try:
                _resolve_record(
                    record, source_dir, destination, cache_dir, staged_file,
                    library_present=library is not None,
                )
            except MissingPayload:
                missing.append(record["file"])
        if missing:
            raise MissingPayload(
                "payloads require --source-dir or an official direct download URL:\n  "
                + "\n  ".join(sorted(missing))
            )
        _publish_tree(stage, destination, temporary_root)
        stage = None
        print(f"Prepared and verified {len(records)} LUT payloads in {destination}")
        return len(records)
    finally:
        if stage is not None and stage.exists():
            shutil.rmtree(stage)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-dir",
        type=Path,
        help="directory containing manually supplied LUT originals, including Pocket 4 files",
    )
    args = parser.parse_args()
    try:
        prepare(args.source_dir)
    except LUTError as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
