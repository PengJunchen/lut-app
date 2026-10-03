#!/usr/bin/env python3
"""Acquire official LUT files locally and verify them against the catalog."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import tempfile
from urllib.parse import urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(url: str, destination: Path) -> tuple[bytes, Path]:
    request = Request(url, headers={"User-Agent": "DJI-LUT-build/1"})
    with urlopen(request, timeout=90) as response:
        payload = response.read()
    with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=destination.name + ".", delete=False) as tmp:
        tmp.write(payload)
        temporary = Path(tmp.name)
    return payload, temporary


def prepare(source_dir: Path | None) -> None:
    catalog = json.loads((ROOT / "assets" / "catalog.json").read_text(encoding="utf-8"))
    missing_manual: list[tuple[Path, dict]] = []
    for entry in catalog["entries"]:
        destination = ROOT / "assets" / Path(entry["file"])
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.is_file() and sha256(destination) == entry["sha256"]:
            continue
        source_url = entry.get("source_url", "")
        supplied = source_dir / Path(entry["file"]).name if source_dir is not None else None
        if supplied is not None and supplied.is_file():
            payload = supplied.read_bytes()
            if hashlib.sha256(payload).hexdigest() != entry["sha256"]:
                raise SystemExit(f"Supplied LUT checksum mismatch: {supplied}")
            temporary = destination.with_name(destination.name + ".importing")
            temporary.write_bytes(payload)
            temporary.replace(destination)
        else:
            host = (urlparse(source_url).hostname or "").lower()
            is_dji_cdn = host == "djicdn.com" or host.endswith(".djicdn.com")
            is_dji_cube_host = host == "www.dji.com"
            if (is_dji_cdn or is_dji_cube_host) and urlparse(source_url).path.lower().endswith(".cube"):
                payload, temporary = fetch(source_url, destination)
                if hashlib.sha256(payload).hexdigest() != entry["sha256"]:
                    temporary.unlink(missing_ok=True)
                    raise SystemExit(f"Downloaded LUT checksum mismatch: {destination.name}")
                temporary.replace(destination)
            else:
                missing_manual.append((destination, entry))
        if destination.is_file() and sha256(destination) != entry["sha256"]:
            raise SystemExit(f"LUT checksum mismatch: {destination.name}")
    if missing_manual:
        print("The following files must be downloaded from DJI and passed with --source-dir:")
        for destination, entry in missing_manual:
            print(f"  {destination.name}: {entry.get('source_url', 'see assets/SOURCES.md')}")
        raise SystemExit(1)
    print(f"Verified {len(catalog['entries'])} LUT files under assets/luts/")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, help="directory containing manually downloaded Pocket 4P LUT files")
    args = parser.parse_args()
    prepare(args.source_dir.expanduser() if args.source_dir else None)


if __name__ == "__main__":
    main()
