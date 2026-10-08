#!/usr/bin/env python3
"""Prepare verified, target-specific resources for an Electron desktop package."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[2]
PACKAGING_BUILD = ROOT / "packaging" / "build.py"
TARGETS = {"darwin-arm64", "darwin-amd64", "windows-amd64"}


def load_packaging_build():
    spec = importlib.util.spec_from_file_location("dji_lut_packaging_build", PACKAGING_BUILD)
    if spec is None or spec.loader is None:
        raise SystemExit(f"Cannot load packaging helpers from {PACKAGING_BUILD}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def copy_electron_notices(destination: Path) -> None:
    package = ROOT / "node_modules" / "electron"
    sources = (
        (package / "LICENSE", "Electron-LICENSE.txt"),
        (package / "dist" / "LICENSES.chromium.html", "Chromium-LICENSES.html"),
    )
    for source, name in sources:
        if source.is_file():
            shutil.copy2(source, destination / name)


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in TARGETS:
        raise SystemExit("Usage: python3 desktop/scripts/prepare_assets.py <darwin-arm64|darwin-amd64|windows-amd64>")
    target = sys.argv[1]
    packaging = load_packaging_build()

    # These helpers verify the exact locked FFmpeg runtime and catalogued LUT
    # payloads before the Go `bundled` build embeds them in the sidecar.
    packaging.verify_luts()
    packaging.archive_runtime(target)

    generated = ROOT / "desktop" / ".generated" / target
    licenses = generated / "licenses"
    if licenses.exists():
        shutil.rmtree(licenses)
    licenses.mkdir(parents=True)
    packaging.copy_licenses(target, licenses)
    copy_electron_notices(licenses)


if __name__ == "__main__":
    main()
