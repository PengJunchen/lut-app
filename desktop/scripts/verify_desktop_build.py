#!/usr/bin/env python3
"""Smoke-test a native Electron desktop build and its embedded release assets."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import plistlib
import queue
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
from urllib.error import URLError
from urllib.parse import parse_qs, urlsplit, urlunsplit
from urllib.request import ProxyHandler, Request, build_opener
import zipfile

ROOT = Path(__file__).resolve().parents[2]
EXPECTED_PAYLOAD_COUNT = 40
TARGETS = {
    "darwin-arm64": {
        "host": "darwin",
        "machine": {"arm64", "aarch64"},
        "go_os": "darwin",
        "go_arch": "arm64",
        "artifact": "DJI-LUT-macOS-AppleSilicon.zip",
        "engine": "engine",
    },
    "darwin-amd64": {
        "host": "darwin",
        "machine": {"x86_64", "amd64"},
        "go_os": "darwin",
        "go_arch": "amd64",
        "artifact": "DJI-LUT-macOS-Intel.zip",
        "engine": "engine",
    },
    "windows-amd64": {
        "host": "windows",
        "machine": {"amd64", "x86_64"},
        "go_os": "windows",
        "go_arch": "amd64",
        "artifact": "DJI-LUT-Windows-x64.zip",
        "engine": "engine.exe",
    },
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalize_payload_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError(f"invalid payload path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError(f"unsafe payload path: {value!r}")
    normalized = path.as_posix()
    if normalized == ".":
        raise ValueError(f"invalid payload path: {value!r}")
    return normalized


def expected_payloads(catalog: dict, library: dict) -> dict[str, str]:
    records: dict[str, str] = {}

    def add(record: dict, label: str) -> None:
        relative = normalize_payload_path(record.get("file"))
        if label == "catalog" and relative.startswith("luts/"):
            relative = normalize_payload_path(relative[len("luts/"):])
        digest = record.get("sha256")
        if not isinstance(digest, str) or re.fullmatch(r"[0-9a-fA-F]{64}", digest) is None:
            raise ValueError(f"{label} payload {relative} has no valid SHA-256")
        digest = digest.lower()
        previous = records.get(relative)
        if previous is not None and previous != digest:
            raise ValueError(f"manifests disagree about payload checksum for {relative}")
        records[relative] = digest

    library_assets = library.get("assets")
    catalog_entries = catalog.get("entries")
    if not isinstance(library_assets, list) or not isinstance(catalog_entries, list):
        raise ValueError("library.json assets and catalog.json entries must be arrays")
    for asset in library_assets:
        if not isinstance(asset, dict):
            raise ValueError("library.json contains a non-object asset")
        add(asset, "library")
    for entry in catalog_entries:
        if not isinstance(entry, dict):
            raise ValueError("catalog.json contains a non-object entry")
        add(entry, "catalog")
    return records


def verify_native_host(target: str) -> None:
    spec = TARGETS[target]
    machine = platform.machine().lower()
    host = "windows" if sys.platform == "win32" else sys.platform
    if host != spec["host"] or machine not in spec["machine"]:
        raise RuntimeError(
            f"{target} requires a native {spec['host']}/{sorted(spec['machine'])} runner; "
            f"this runner reports {host}/{machine}"
        )


def build_cache_environment() -> tuple[dict[str, str], Path]:
    env = os.environ.copy()
    if sys.platform == "win32":
        cache = Path(env.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        cache = Path.home() / "Library" / "Caches"
    else:
        cache = Path(env.get("XDG_CACHE_HOME") or (Path.home() / ".cache"))
    return env, cache / "DJILUTApp" / "bundles"


def embedded_bundle_key(
    runtime_archive: bytes,
    manifest_files: dict[str, bytes],
    lut_files: dict[str, bytes],
) -> str:
    digest = hashlib.sha256()
    digest.update(runtime_archive)
    for group in (manifest_files, lut_files):
        for relative in sorted(group):
            digest.update(relative.encode("utf-8"))
            digest.update(group[relative])
    return digest.hexdigest()[:24]


def start_sidecar(engine: Path, input_dir: Path, env: dict[str, str]) -> tuple[dict, subprocess.Popen[str]]:
    process = subprocess.Popen(
        [str(engine), "--desktop", "--input", str(input_dir)],
        cwd=ROOT,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
    )
    ready_lines: queue.Queue[str] = queue.Queue()
    def read_protocol_and_discard_later_output() -> None:
        ready_lines.put(process.stdout.readline())
        for _line in process.stdout:
            pass

    reader = threading.Thread(target=read_protocol_and_discard_later_output, daemon=True)
    reader.start()
    try:
        line = ready_lines.get(timeout=45)
    except queue.Empty as error:
        process.terminate()
        process.wait(timeout=10)
        raise RuntimeError("native Go sidecar did not announce readiness within 45 seconds") from error
    if not line:
        status = process.wait(timeout=10)
        raise RuntimeError(f"native Go sidecar exited before readiness with status {status}")
    try:
        ready = json.loads(line)
    except json.JSONDecodeError as error:
        process.terminate()
        process.wait(timeout=10)
        raise RuntimeError("native Go sidecar emitted malformed readiness JSON") from error
    if not isinstance(ready, dict) or ready.get("type") != "ready" or ready.get("protocol") != 1:
        process.terminate()
        process.wait(timeout=10)
        raise RuntimeError("native Go sidecar emitted an unsupported readiness message")
    return ready, process


def fetch_bootstrap(ready: dict) -> dict:
    ready_url = ready.get("url")
    if not isinstance(ready_url, str):
        raise RuntimeError("sidecar readiness message has no URL")
    parsed = urlsplit(ready_url)
    token = parse_qs(parsed.fragment).get("token", [None])[0]
    if not token:
        raise RuntimeError("sidecar readiness URL has no bearer token")
    endpoint = urlunsplit((parsed.scheme, parsed.netloc, "/api/bootstrap", "", ""))
    request = Request(endpoint, headers={"Authorization": f"Bearer {token}"})
    try:
        opener = build_opener(ProxyHandler({}))
        with opener.open(request, timeout=10) as response:
            body = response.read()
    except (OSError, URLError) as error:
        raise RuntimeError(f"native sidecar bootstrap request failed: {error}") from error
    try:
        bootstrap = json.loads(body)
    except json.JSONDecodeError as error:
        raise RuntimeError("native sidecar bootstrap response is not JSON") from error
    if not isinstance(bootstrap, dict):
        raise RuntimeError("native sidecar bootstrap response is not an object")
    return bootstrap


def stop_sidecar(process: subprocess.Popen[str]) -> None:
    if process.stdin is not None:
        process.stdin.close()
    try:
        status = process.wait(timeout=12)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            status = process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
            status = process.wait(timeout=8)
    if status != 0:
        raise RuntimeError(f"native Go sidecar exited with status {status}")


def resource_member(names: list[str], suffix: str) -> str:
    normalized = [name.replace("\\", "/") for name in names]
    matches = [name for name in normalized if name.lower().endswith(suffix.lower())]
    if len(matches) != 1:
        raise RuntimeError(f"expected one Electron archive member ending in {suffix!r}; found {matches}")
    return matches[0]


def macos_app_info_plist_member(names: list[str]) -> str:
    matches = []
    for name in names:
        parts = PurePosixPath(name.replace("\\", "/")).parts
        if len(parts) == 3 and parts[0].lower().endswith(".app") and [part.lower() for part in parts[1:]] == [
            "contents", "info.plist"
        ]:
            matches.append(name)
    if len(matches) != 1:
        raise RuntimeError("expected one top-level macOS application Info.plist in the Electron archive")
    return matches[0]


def _macho_signature_and_linkedit(data: bytes) -> tuple[bool, int]:
    """Return whether a thin 64-bit Mach-O has a signature and its __LINKEDIT vmsize offset."""
    if len(data) < 32:
        raise RuntimeError("native Go sidecar is not a complete 64-bit Mach-O executable")
    if data[:4] == b"\xcf\xfa\xed\xfe":
        endian = "<"
    elif data[:4] == b"\xfe\xed\xfa\xcf":
        endian = ">"
    else:
        raise RuntimeError("native Go sidecar is not a supported 64-bit Mach-O executable")

    ncmds = int.from_bytes(data[16:20], "little" if endian == "<" else "big")
    sizeofcmds = int.from_bytes(data[20:24], "little" if endian == "<" else "big")
    commands_end = 32 + sizeofcmds
    if commands_end > len(data):
        raise RuntimeError("native Go sidecar has an invalid Mach-O load-command table")

    signature_records: list[tuple[int, int]] = []
    linkedit_vmsize_offsets: list[int] = []
    offset = 32
    for _ in range(ncmds):
        if offset + 8 > commands_end:
            raise RuntimeError("native Go sidecar has a truncated Mach-O load command")
        command = int.from_bytes(data[offset:offset + 4], "little" if endian == "<" else "big")
        command_size = int.from_bytes(data[offset + 4:offset + 8], "little" if endian == "<" else "big")
        if command_size < 8 or offset + command_size > commands_end:
            raise RuntimeError("native Go sidecar has an invalid Mach-O load command")
        if command == 0x1D:  # LC_CODE_SIGNATURE
            if command_size < 16:
                raise RuntimeError("native Go sidecar has an invalid code-signature command")
            data_offset = int.from_bytes(data[offset + 8:offset + 12], "little" if endian == "<" else "big")
            data_size = int.from_bytes(data[offset + 12:offset + 16], "little" if endian == "<" else "big")
            if data_size and (data_offset > len(data) or data_size > len(data) - data_offset):
                raise RuntimeError("native Go sidecar has an out-of-bounds code signature")
            signature_records.append((data_offset, data_size))
        elif command == 0x19:  # LC_SEGMENT_64
            if command_size < 72:
                raise RuntimeError("native Go sidecar has an invalid 64-bit segment command")
            if data[offset + 8:offset + 24].split(b"\0", 1)[0] == b"__LINKEDIT":
                linkedit_vmsize_offsets.append(offset + 32)
        offset += command_size
    if offset != commands_end or len(linkedit_vmsize_offsets) != 1 or len(signature_records) > 1:
        raise RuntimeError("native Go sidecar has an unexpected Mach-O load-command layout")
    return bool(signature_records and signature_records[0][1]), linkedit_vmsize_offsets[0]


def _run_codesign(arguments: list[str]) -> None:
    try:
        result = subprocess.run(
            ["codesign", *arguments],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as error:
        raise RuntimeError("macOS codesign is unavailable for native engine verification") from error
    if result.returncode == 0:
        return
    raise RuntimeError("macOS native engine code-signature operation failed")


def verify_macos_engine_signature(engine: Path) -> None:
    signed, _ = _macho_signature_and_linkedit(engine.read_bytes())
    if not signed:
        raise RuntimeError("Electron archive native engine has no Mach-O code signature")
    _run_codesign(["--verify", "--strict", str(engine)])


def normalize_macos_engine_code(data: bytes) -> bytes:
    """Zero only __LINKEDIT.vmsize, which ad-hoc signing can adjust after stripping."""
    _, linkedit_vmsize = _macho_signature_and_linkedit(data)
    normalized = bytearray(data)
    normalized[linkedit_vmsize:linkedit_vmsize + 8] = b"\0" * 8
    return bytes(normalized)


def compare_macos_engine_code(archive_engine: Path, sidecar: Path) -> None:
    """Compare code from temporary copies, normalizing only signature metadata."""
    with tempfile.TemporaryDirectory(prefix="dji-lut-engine-compare-", dir=archive_engine.parent) as temporary:
        compare_dir = Path(temporary)
        archive_copy = compare_dir / "archive-engine"
        sidecar_copy = compare_dir / "generated-engine"
        shutil.copyfile(archive_engine, archive_copy)
        shutil.copyfile(sidecar, sidecar_copy)

        for copy in (archive_copy, sidecar_copy):
            signed, _ = _macho_signature_and_linkedit(copy.read_bytes())
            if signed:
                _run_codesign(["--remove-signature", str(copy)])

        archive_bytes = archive_copy.read_bytes()
        sidecar_bytes = sidecar_copy.read_bytes()
        archive_signed, _ = _macho_signature_and_linkedit(archive_bytes)
        sidecar_signed, _ = _macho_signature_and_linkedit(sidecar_bytes)
        if archive_signed or sidecar_signed:
            raise RuntimeError("macOS native engine signature removal did not complete")

        # Keep every other Mach-O byte, including all remaining load commands, exact.
        if normalize_macos_engine_code(archive_bytes) != normalize_macos_engine_code(sidecar_bytes):
            raise RuntimeError("Electron archive native engine code differs from the verified Go sidecar")


def verify_macos_info_plist(plist_bytes: bytes, version: str) -> None:
    try:
        plist = plistlib.loads(plist_bytes)
    except (plistlib.InvalidFileException, ValueError) as error:
        raise RuntimeError("Electron archive Info.plist is invalid") from error
    numeric_version = version.split("-", 1)[0]
    if not isinstance(plist, dict) or any(
        plist.get(key) != numeric_version
        for key in ("CFBundleShortVersionString", "CFBundleVersion")
    ):
        raise RuntimeError("Electron archive Info.plist versions do not match the numeric package version")


def verify_bundle_cache(
    cache_parent: Path,
    target: str,
    catalog_source: bytes,
    library_source: bytes,
    sources_source: bytes,
    expected: dict[str, str],
    runtime_lock: dict,
    license_lock: dict,
) -> dict:
    spec = TARGETS[target]
    runtime_archive = (ROOT / "internal" / "bundle" / "runtimes" / f"{target}.tgz").read_bytes()
    embedded_assets = ROOT / "assets"
    manifest_files = {
        relative: (embedded_assets / relative).read_bytes()
        for relative in ("catalog.json", "library.json", "SOURCES.md")
    }
    lut_root = embedded_assets / "luts"
    lut_files = sorted(path for path in lut_root.rglob("*") if path.is_file())
    lut_contents: dict[str, bytes] = {}
    for path in lut_files:
        if path.is_symlink():
            raise RuntimeError("embedded LUT source contains a symlink")
        relative = f"luts/{path.relative_to(lut_root).as_posix()}"
        lut_contents[relative] = path.read_bytes()
    key = embedded_bundle_key(runtime_archive, manifest_files, lut_contents)
    bundle_root = cache_parent / f"{spec['go_os']}-{spec['go_arch']}-{key}"
    if not bundle_root.is_dir():
        raise RuntimeError(f"no content-addressed runtime bundle was found for {target}")
    return verify_bundle_root(
        bundle_root, target, catalog_source, library_source, sources_source, expected,
        runtime_lock, license_lock,
    )


def verify_bundle_root(
    bundle_root: Path,
    target: str,
    catalog_source: bytes,
    library_source: bytes,
    sources_source: bytes,
    expected: dict[str, str],
    runtime_lock: dict,
    license_lock: dict,
) -> dict:
    inventory_path = bundle_root / "inventory.json"
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    if not isinstance(inventory, dict) or not inventory:
        raise RuntimeError("extracted bundle has no file inventory")

    indexed: set[str] = set()
    for relative, wanted in inventory.items():
        normalized = normalize_payload_path(relative)
        if normalized != relative:
            raise RuntimeError(f"bundle inventory path is not canonical: {relative}")
        path = bundle_root.joinpath(*PurePosixPath(relative).parts)
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"bundle inventory file is missing or is a symlink: {relative}")
        actual = sha256(path.read_bytes())
        if actual != wanted:
            raise RuntimeError(f"bundle file checksum mismatch for {relative}: {actual}")
        indexed.add(relative)
    actual_files: set[str] = set()
    for path in bundle_root.rglob("*"):
        if path.is_symlink():
            raise RuntimeError("extracted bundle contains a symlink")
        if path.is_file() and path.relative_to(bundle_root).as_posix() != "inventory.json":
            actual_files.add(path.relative_to(bundle_root).as_posix())
    if actual_files != indexed:
        missing = sorted(indexed - actual_files)
        extra = sorted(actual_files - indexed)
        raise RuntimeError(f"bundle inventory differs from extracted files; missing={missing}, extra={extra}")

    manifest_paths = {
        "assets/catalog.json": catalog_source,
        "assets/library.json": library_source,
        "assets/SOURCES.md": sources_source,
    }
    for relative, wanted in manifest_paths.items():
        if (bundle_root / relative).read_bytes() != wanted:
            raise RuntimeError(f"embedded manifest differs from source: {relative}")

    actual_payloads: dict[str, str] = {}
    payload_prefix = "assets/luts/"
    for relative in indexed:
        if relative.startswith(payload_prefix):
            payload = relative[len(payload_prefix):]
            actual_payloads[payload] = inventory[relative]
    if actual_payloads.keys() != expected.keys():
        missing = sorted(expected.keys() - actual_payloads.keys())
        unexpected = sorted(actual_payloads.keys() - expected.keys())
        raise RuntimeError(f"embedded LUT payload set differs from manifests; missing={missing}, extra={unexpected}")
    for relative, wanted in expected.items():
        if actual_payloads[relative] != wanted:
            raise RuntimeError(f"embedded LUT payload checksum differs from manifest: {relative}")
    if len(actual_payloads) != EXPECTED_PAYLOAD_COUNT:
        raise RuntimeError(
            f"expected {EXPECTED_PAYLOAD_COUNT} unique embedded LUT payloads; found {len(actual_payloads)}"
        )

    locked = runtime_lock["targets"][target]
    tool_metadata = json.loads((bundle_root / "metadata-tools.json").read_text(encoding="utf-8"))
    expected_tools = {
        name: {key: record[key] for key in ("version", "url", "archive", "archive_sha256", "binary_sha256")}
        for name, record in locked["tools"].items()
    }
    expected_tool_metadata = {
        "schema_version": 1,
        "target": target,
        "platform": locked["platform"],
        "min_os": locked["min_os"],
        "tools": expected_tools,
    }
    if tool_metadata != expected_tool_metadata:
        raise RuntimeError("embedded runtime metadata does not match packaging/runtime-lock.json")
    extension = ".exe" if target.startswith("windows-") else ""
    for tool, record in locked["tools"].items():
        actual = sha256((bundle_root / "bin" / f"{tool}{extension}").read_bytes())
        if actual != record["binary_sha256"]:
            raise RuntimeError(f"embedded {tool} checksum differs from packaging/runtime-lock.json")
    verify_native_runtime_tools(bundle_root, target)

    ffmpeg_version = locked["tools"]["ffmpeg"]["version"].removesuffix("-tessus")
    expected_ffmpeg_license = license_lock["ffmpeg"][ffmpeg_version]["sha256"]
    gpl_licenses = [
        path for path in (bundle_root / "licenses").iterdir()
        if path.is_file() and re.fullmatch(r"(?:ffmpeg-)?COPYING\.GPLv3", path.name, re.IGNORECASE)
    ]
    matching_gpl_licenses = [path for path in gpl_licenses if sha256(path.read_bytes()) == expected_ffmpeg_license]
    if not matching_gpl_licenses or len(matching_gpl_licenses) != len(gpl_licenses):
        raise RuntimeError("embedded FFmpeg GPL license does not match packaging/license-lock.json")
    go_license = bundle_root / "licenses" / "Go-LICENSE"
    if sha256(go_license.read_bytes()) != license_lock["go"]["sha256"]:
        raise RuntimeError("embedded Go license does not match packaging/license-lock.json")
    return {
        "counts": {
            "inventory_files": len(indexed),
            "catalog_entries": len(json.loads(catalog_source)["entries"]),
            "library_assets": len(json.loads(library_source)["assets"]),
            "unique_payloads": len(actual_payloads),
        },
        "files": [
            {"path": f"embedded/{relative}", "sha256": inventory[relative]}
            for relative in sorted(indexed)
        ],
    }


def locked_ffmpeg_license_files(licenses_dir: Path, expected_sha256: str) -> dict[str, bytes]:
    candidates = sorted(
        path for path in licenses_dir.iterdir()
        if path.is_file() and re.fullmatch(r"(?:ffmpeg-)?COPYING\.GPLv3", path.name, re.IGNORECASE)
    )
    if not candidates:
        raise RuntimeError("generated package has no recognized FFmpeg GPL license file")
    result: dict[str, bytes] = {}
    for path in candidates:
        payload = path.read_bytes()
        if sha256(payload) != expected_sha256:
            raise RuntimeError("generated FFmpeg GPL license does not match packaging/license-lock.json")
        result[f"resources/licenses/{path.name}"] = payload
    return result


def verify_native_runtime_tools(bundle_root: Path, target: str) -> None:
    extension = ".exe" if target.startswith("windows-") else ""
    for name in ("ffmpeg", "ffprobe"):
        executable = bundle_root / "bin" / f"{name}{extension}"
        try:
            result = subprocess.run(
                [str(executable), "-version"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=30,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise RuntimeError(f"embedded {name} failed to start for {target}") from error
        if result.returncode != 0:
            raise RuntimeError(f"embedded {name} failed its native startup check for {target}")


def verify_archive(
    archive_path: Path,
    target: str,
    sidecar: Path,
    source_files: dict[str, bytes],
    extracted_engine: Path,
    version: str,
) -> dict:
    spec = TARGETS[target]
    if archive_path.name != spec["artifact"]:
        raise RuntimeError(f"archive name {archive_path.name!r} does not match expected {spec['artifact']!r}")
    if not archive_path.is_file() or archive_path.stat().st_size == 0:
        raise RuntimeError(f"missing or empty Electron archive for {target}")
    if not zipfile.is_zipfile(archive_path):
        raise RuntimeError(f"Electron output for {target} is not a ZIP archive")
    required = [f"resources/engine/{spec['engine']}", *source_files]
    with zipfile.ZipFile(archive_path) as archive:
        bad = archive.testzip()
        if bad is not None:
            raise RuntimeError(f"Electron archive CRC check failed at {bad}")
        names = archive.namelist()
        members = {suffix: resource_member(names, suffix) for suffix in required}
        for suffix, expected_bytes in source_files.items():
            if suffix.startswith("resources/licenses/") and not expected_bytes:
                raise RuntimeError(f"Electron archive contains an empty public license: {suffix}")
            actual = archive.read(members[suffix])
            if actual != expected_bytes:
                raise RuntimeError(f"Electron archive resource differs from source: {suffix}")
        engine_member = members[f"resources/engine/{spec['engine']}"]
        engine_info = archive.getinfo(engine_member)
        if stat.S_ISLNK(engine_info.external_attr >> 16):
            raise RuntimeError("Electron archive native engine must not be a symbolic link")
        engine_bytes = archive.read(engine_member)
        archive_engine_hash = sha256(engine_bytes)
        if spec["host"] == "darwin":
            plist_member = macos_app_info_plist_member(archive.namelist())
            plist_bytes = archive.read(plist_member)
            verify_macos_info_plist(plist_bytes, version)

        extracted_engine.parent.mkdir(parents=True, exist_ok=True)
        with extracted_engine.open("xb") as output:
            output.write(engine_bytes)
        if spec["host"] == "darwin":
            extracted_engine.chmod(0o700)
            verify_macos_engine_signature(extracted_engine)
            compare_macos_engine_code(extracted_engine, sidecar)
        else:
            extracted_engine_hash = sha256(extracted_engine.read_bytes())
            if extracted_engine_hash != sha256(sidecar.read_bytes()):
                raise RuntimeError("Electron archive does not contain the verified native Go sidecar")
        resource_records = [
            {"path": suffix, "sha256": sha256(archive.read(members[suffix]))}
            for suffix in sorted(required)
        ]
        if spec["host"] == "darwin":
            resource_records.append({"path": plist_member, "sha256": sha256(plist_bytes)})
    return {
        "path": archive_path.name,
        "bytes": archive_path.stat().st_size,
        "sha256": sha256(archive_path.read_bytes()),
        "files": resource_records,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=sorted(TARGETS), required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--tag", default="")
    parser.add_argument("--commit", default="")
    parser.add_argument("--metadata", type=Path, required=True)
    args = parser.parse_args()

    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    if package.get("version") != args.version:
        raise SystemExit(f"source package version {package.get('version')} does not match requested {args.version}")
    verify_native_host(args.target)
    catalog_source = (ROOT / "assets" / "catalog.json").read_bytes()
    library_source = (ROOT / "assets" / "library.json").read_bytes()
    sources_source = (ROOT / "assets" / "SOURCES.md").read_bytes()
    catalog = json.loads(catalog_source)
    library = json.loads(library_source)
    payloads = expected_payloads(catalog, library)
    if len(payloads) != EXPECTED_PAYLOAD_COUNT:
        raise SystemExit(
            f"expected {EXPECTED_PAYLOAD_COUNT} unique manifest payloads, found {len(payloads)}; "
            "review the release acceptance count before publishing"
        )
    runtime_lock_source = (ROOT / "packaging" / "runtime-lock.json").read_bytes()
    license_lock_source = (ROOT / "packaging" / "license-lock.json").read_bytes()
    runtime_lock = json.loads(runtime_lock_source)
    license_lock = json.loads(license_lock_source)

    target_spec = TARGETS[args.target]
    executable = ROOT / "desktop" / ".generated" / args.target / target_spec["engine"]
    if not executable.is_file():
        raise SystemExit(f"missing native sidecar for {args.target}")
    generated_licenses = ROOT / "desktop" / ".generated" / args.target / "licenses"
    ffmpeg_version = runtime_lock["targets"][args.target]["tools"]["ffmpeg"]["version"].removesuffix("-tessus")
    ffmpeg_license_sha256 = license_lock["ffmpeg"][ffmpeg_version]["sha256"]
    source_files = {
        "resources/LICENSE": (ROOT / "LICENSE").read_bytes(),
        "resources/THIRD_PARTY.md": (ROOT / "THIRD_PARTY.md").read_bytes(),
        "resources/USAGE.zh-CN.md": (ROOT / "docs" / "ELECTRON.zh-CN.md").read_bytes(),
        "resources/DISTRIBUTION_NOTICES.md": (ROOT / "docs" / "DISTRIBUTION_NOTICES.md").read_bytes(),
        "resources/assets/SOURCES.md": sources_source,
        "resources/assets/catalog.json": catalog_source,
        "resources/assets/library.json": library_source,
        "resources/packaging/runtime-lock.json": runtime_lock_source,
        "resources/packaging/license-lock.json": license_lock_source,
        "resources/licenses/Go-LICENSE": (generated_licenses / "Go-LICENSE").read_bytes(),
        "resources/licenses/Electron-LICENSE.txt": (generated_licenses / "Electron-LICENSE.txt").read_bytes(),
        "resources/licenses/Chromium-LICENSES.html": (generated_licenses / "Chromium-LICENSES.html").read_bytes(),
    }
    if sha256(source_files["resources/licenses/Go-LICENSE"]) != license_lock["go"]["sha256"]:
        raise RuntimeError("generated Go license does not match packaging/license-lock.json")
    source_files.update(locked_ffmpeg_license_files(generated_licenses, ffmpeg_license_sha256))

    with tempfile.TemporaryDirectory(prefix="dji-lut-release-smoke-") as scratch:
        scratch_root = Path(scratch)
        input_dir = scratch_root / "input"
        input_dir.mkdir()
        extracted_engine = scratch_root / "archive-engine" / target_spec["engine"]
        archive = verify_archive(
            args.archive.resolve(), args.target, executable, source_files, extracted_engine, args.version
        )
        env, cache_parent = build_cache_environment()
        ready, process = start_sidecar(extracted_engine, input_dir, env)
        try:
            bootstrap = fetch_bootstrap(ready)
        finally:
            stop_sidecar(process)
        catalog_entries = bootstrap.get("catalog")
        library_value = bootstrap.get("library")
        if not isinstance(catalog_entries, list) or not catalog_entries:
            raise RuntimeError("native Go sidecar loaded no automatic LUT catalog entries")
        if len(catalog_entries) != len(catalog["entries"]):
            raise RuntimeError("native Go sidecar catalog count differs from catalog.json")
        if not isinstance(library_value, dict) or not isinstance(library_value.get("assets"), list):
            raise RuntimeError("native Go sidecar loaded no public LUT library")
        if len(library_value["assets"]) != len(library["assets"]):
            raise RuntimeError("native Go sidecar public library count differs from library.json")
        bundle_summary = verify_bundle_cache(
            cache_parent,
            args.target,
            catalog_source,
            library_source,
            sources_source,
            payloads,
            runtime_lock,
            license_lock,
        )

    record = {
        "tag": args.tag or None,
        "version": args.version,
        "commit": args.commit or None,
        "target": args.target,
        "counts": {
            "catalog_entries": len(catalog["entries"]),
            "library_assets": len(library["assets"]),
            "unique_payloads": len(payloads),
            "embedded_bundle_files": bundle_summary["counts"]["inventory_files"],
            "loaded_catalog_entries": len(catalog_entries),
            "loaded_library_assets": len(library_value["assets"]),
            "archive_bytes": archive["bytes"],
            "archive_resource_files": len(archive["files"]),
        },
        "files": sorted(
            bundle_summary["files"]
            + [{"path": f"archive/{archive['path']}", "sha256": archive["sha256"]}]
            + [{"path": f"archive/{item['path']}", "sha256": item["sha256"]} for item in archive["files"]],
            key=lambda item: item["path"],
        ),
    }
    args.metadata.parent.mkdir(parents=True, exist_ok=True)
    args.metadata.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(record, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except OSError as error:
        print(f"Desktop release verification failed with an operating system error ({type(error).__name__})", file=sys.stderr)
        raise SystemExit(1) from error
    except (ValueError, KeyError, RuntimeError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(f"Desktop release verification failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
