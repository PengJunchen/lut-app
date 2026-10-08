from __future__ import annotations

import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERIFY_PATH = ROOT / "desktop" / "scripts" / "verify_desktop_build.py"
COLLECT_PATH = ROOT / "desktop" / "scripts" / "collect_release_artifacts.py"
spec = importlib.util.spec_from_file_location("dji_lut_verify_desktop_build", VERIFY_PATH)
assert spec is not None and spec.loader is not None
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)
collect_spec = importlib.util.spec_from_file_location("dji_lut_collect_release_artifacts", COLLECT_PATH)
assert collect_spec is not None and collect_spec.loader is not None
collect_release = importlib.util.module_from_spec(collect_spec)
collect_spec.loader.exec_module(collect_release)


class ReleaseCheckTests(unittest.TestCase):
    def test_manifest_union_has_exactly_forty_unique_payloads(self) -> None:
        catalog = json.loads((ROOT / "assets" / "catalog.json").read_text(encoding="utf-8"))
        library = json.loads((ROOT / "assets" / "library.json").read_text(encoding="utf-8"))
        payloads = verify.expected_payloads(catalog, library)
        self.assertEqual(len(payloads), 40)
        self.assertEqual(len(catalog["entries"]), 44)

    def test_payload_manifest_paths_reject_traversal_and_windows_separators(self) -> None:
        for value in ("../outside.cube", "/absolute.cube", "folder\\file.cube", ""):
            with self.subTest(value=value), self.assertRaises(ValueError):
                verify.normalize_payload_path(value)

    def test_content_addressed_cache_key_matches_go_hash_order(self) -> None:
        runtime_archive = b"runtime"
        manifest_files = {"library.json": b"library", "SOURCES.md": b"sources", "catalog.json": b"catalog"}
        lut_files = {"luts/z.cube": b"z", "luts/a.cube": b"a"}
        expected = hashlib.sha256()
        expected.update(runtime_archive)
        for group in (manifest_files, lut_files):
            for relative in sorted(group):
                expected.update(relative.encode("utf-8"))
                expected.update(group[relative])
        self.assertEqual(verify.embedded_bundle_key(runtime_archive, manifest_files, lut_files), expected.hexdigest()[:24])

    def test_catalog_and_library_must_agree_on_payload_checksum(self) -> None:
        catalog = {"entries": [{"file": "shared.cube", "sha256": "a" * 64}]}
        library = {"assets": [{"file": "shared.cube", "sha256": "b" * 64}]}
        with self.assertRaisesRegex(ValueError, "disagree about payload checksum"):
            verify.expected_payloads(catalog, library)

    def test_ffmpeg_license_verifier_accepts_locked_legacy_basename(self) -> None:
        with tempfile.TemporaryDirectory(prefix="dji-lut-license-name-") as temporary:
            directory = Path(temporary)
            content = b"locked GPL license text"
            digest = hashlib.sha256(content).hexdigest()
            (directory / "ffmpeg-COPYING.GPLv3").write_bytes(content)
            files = verify.locked_ffmpeg_license_files(directory, digest)
            self.assertEqual(files, {"resources/licenses/ffmpeg-COPYING.GPLv3": content})
            with self.assertRaisesRegex(RuntimeError, "license-lock.json"):
                verify.locked_ffmpeg_license_files(directory, "0" * 64)

    def test_collect_release_assets_requires_all_verified_native_targets(self) -> None:
        with tempfile.TemporaryDirectory(prefix="dji-lut-release-assets-") as temporary:
            root = Path(temporary)
            source = root / "input"
            output = root / "output"
            source.mkdir()
            tag = "rc0.0.1"
            version = "0.0.1-rc.0"
            commit = "0123456789abcdef"
            for target, filename in collect_release.ARTIFACTS.items():
                artifact_dir = source / f"desktop-{target}"
                artifact_dir.mkdir()
                archive_path = artifact_dir / filename
                resource_files = {
                    "resources/engine/engine": target.encode(),
                    "resources/LICENSE": b"license",
                    "resources/THIRD_PARTY.md": b"third party",
                    "resources/USAGE.zh-CN.md": b"usage",
                    "resources/DISTRIBUTION_NOTICES.md": b"distribution notices",
                    "resources/assets/SOURCES.md": b"sources",
                    "resources/assets/catalog.json": b"catalog",
                    "resources/assets/library.json": b"library",
                    "resources/packaging/runtime-lock.json": b"runtime lock",
                    "resources/packaging/license-lock.json": b"license lock",
                    "resources/licenses/COPYING.GPLv3": b"ffmpeg license",
                    "resources/licenses/Go-LICENSE": b"go license",
                    "resources/licenses/Electron-LICENSE.txt": b"electron license",
                    "resources/licenses/Chromium-LICENSES.html": b"chromium license",
                }
                with zipfile.ZipFile(archive_path, "w") as archive:
                    for name, body in resource_files.items():
                        archive.writestr(f"App/Contents/{name}", body)
                archive_hash = hashlib.sha256(archive_path.read_bytes()).hexdigest()
                files = [
                    {"path": "embedded/assets/catalog.json", "sha256": hashlib.sha256(b"catalog").hexdigest()},
                    {"path": f"archive/{filename}", "sha256": archive_hash},
                ]
                files.extend(
                    {"path": f"archive/{name}", "sha256": hashlib.sha256(body).hexdigest()}
                    for name, body in resource_files.items()
                )
                metadata = {
                    "target": target,
                    "tag": tag,
                    "version": version,
                    "commit": commit,
                    "counts": {
                        "catalog_entries": 44,
                        "library_assets": 58,
                        "unique_payloads": 40,
                        "embedded_bundle_files": 48,
                        "loaded_catalog_entries": 44,
                        "loaded_library_assets": 58,
                        "archive_bytes": archive_path.stat().st_size,
                        "archive_resource_files": len(resource_files),
                    },
                    "files": files,
                }
                (artifact_dir / f"build-metadata-{target}.json").write_text(
                    json.dumps(metadata), encoding="utf-8"
                )

            outputs = collect_release.collect(source, output, tag, version, commit)
            self.assertEqual(len(outputs), 5)
            self.assertEqual(len(list(output.glob("*.zip"))), 3)
            self.assertTrue((output / "BUILD-METADATA.json").is_file())
            self.assertTrue((output / "SHA256SUMS").is_file())
            sum_lines = (output / "SHA256SUMS").read_text(encoding="ascii").splitlines()
            self.assertEqual(len(sum_lines), 4)
            self.assertTrue(all(len(line.split()[0]) == 64 for line in sum_lines))
            release_metadata = json.loads((output / "BUILD-METADATA.json").read_text(encoding="utf-8"))
            self.assertEqual(set(release_metadata), {"tag", "version", "commit", "counts", "artifacts"})
            self.assertEqual(release_metadata["counts"], {
                "native_targets": 3,
                "archives": 3,
                "unique_payloads": 40,
            })

    def test_public_metadata_rejects_private_fields_and_runner_paths(self) -> None:
        with tempfile.TemporaryDirectory(prefix="dji-lut-release-metadata-") as temporary:
            root = Path(temporary)
            archive = root / "DJI-LUT-macOS-AppleSilicon.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("resources/assets/catalog.json", b"catalog")
            metadata = {
                "tag": "rc0.0.1", "version": "0.0.1-rc.0", "commit": "abc", "target": "darwin-arm64",
                "counts": {}, "files": [], "runner_path": "/home/runner/work/repo",
            }
            with self.assertRaisesRegex(ValueError, "unsupported fields"):
                collect_release.validate_build_metadata(
                    metadata, "darwin-arm64", archive.name, archive, "rc0.0.1", "0.0.1-rc.0", "abc"
                )


if __name__ == "__main__":
    unittest.main()
