from __future__ import annotations

import importlib.util
import hashlib
import json
from pathlib import Path
import plistlib
import struct
import tempfile
import unittest
from unittest import mock
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


def make_macho64(*, signature: bool, linkedit_vmsize: int = 4096, vmaddr: int = 0x1000) -> bytes:
    segment = struct.pack(
        "<II16sQQQQIIII",
        0x19,
        72,
        b"__LINKEDIT\0\0\0\0\0\0\0",
        vmaddr,
        linkedit_vmsize,
        0,
        0,
        0,
        0,
        0,
        0,
    )
    header = bytearray(b"\xcf\xfa\xed\xfe" + b"\0" * 28)
    commands = segment
    if signature:
        commands += struct.pack("<IIII", 0x1D, 16, 120, 8)
    struct.pack_into("<I", header, 16, 2 if signature else 1)
    struct.pack_into("<I", header, 20, len(commands))
    return bytes(header) + commands + (b"SIGBYTES" if signature else b"")


def remove_test_signature(path: Path) -> None:
    data = path.read_bytes()
    header = bytearray(data[:32])
    struct.pack_into("<I", header, 16, 1)
    struct.pack_into("<I", header, 20, 72)
    path.write_bytes(bytes(header) + data[32:104])


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

    def test_macho_normalization_only_clears_linkedit_vmsize(self) -> None:
        generated = make_macho64(signature=False, linkedit_vmsize=1453074)
        packaged = make_macho64(signature=False, linkedit_vmsize=507904)
        self.assertEqual(
            verify.normalize_macos_engine_code(generated),
            verify.normalize_macos_engine_code(packaged),
        )
        changed_code = make_macho64(signature=False, linkedit_vmsize=507904, vmaddr=0x2000)
        self.assertNotEqual(
            verify.normalize_macos_engine_code(generated),
            verify.normalize_macos_engine_code(changed_code),
        )

    def test_macos_comparison_strips_only_temporary_copies_and_accepts_unsigned_sidecar(self) -> None:
        with tempfile.TemporaryDirectory(prefix="dji-lut-macho-compare-test-") as temporary:
            root = Path(temporary)
            archive_engine = root / "archive-engine"
            sidecar = root / "generated-engine"
            archive_bytes = make_macho64(signature=True, linkedit_vmsize=507904)
            sidecar_bytes = make_macho64(signature=False, linkedit_vmsize=1453074)
            archive_engine.write_bytes(archive_bytes)
            sidecar.write_bytes(sidecar_bytes)

            def run_codesign(command, **_kwargs):
                if command[1] == "--remove-signature":
                    remove_test_signature(Path(command[-1]))
                return mock.Mock(returncode=0, stderr="", stdout="")

            with mock.patch.object(verify.subprocess, "run", side_effect=run_codesign) as run:
                verify.compare_macos_engine_code(archive_engine, sidecar)

            self.assertEqual(archive_engine.read_bytes(), archive_bytes)
            self.assertEqual(sidecar.read_bytes(), sidecar_bytes)
            removals = [call.args[0] for call in run.call_args_list if call.args[0][1] == "--remove-signature"]
            self.assertEqual(len(removals), 1)
            self.assertNotEqual(Path(removals[0][-1]), archive_engine)
            self.assertNotEqual(Path(removals[0][-1]), sidecar)

    def test_macos_archive_validation_records_signed_zip_engine_and_info_plist(self) -> None:
        with tempfile.TemporaryDirectory(prefix="dji-lut-macos-archive-test-") as temporary:
            root = Path(temporary)
            archive_path = root / verify.TARGETS["darwin-arm64"]["artifact"]
            sidecar = root / "generated-engine"
            extracted_engine = root / "owned-temp" / "engine"
            sidecar.write_bytes(make_macho64(signature=False, linkedit_vmsize=1453074))
            archive_engine = make_macho64(signature=True, linkedit_vmsize=507904)
            resources = {"resources/LICENSE": b"license"}
            plist = plistlib.dumps({
                "CFBundleShortVersionString": "0.0.1",
                "CFBundleVersion": "0.0.1",
            })
            with zipfile.ZipFile(archive_path, "w") as output:
                output.writestr("App.app/Contents/Resources/resources/engine/engine", archive_engine)
                output.writestr("App.app/Contents/Info.plist", plist)
                output.writestr("App.app/Contents/Resources/resources/LICENSE", resources["resources/LICENSE"])

            def run_codesign(command, **_kwargs):
                if command[1] == "--remove-signature":
                    remove_test_signature(Path(command[-1]))
                return mock.Mock(returncode=0, stderr="", stdout="")

            with mock.patch.object(verify.subprocess, "run", side_effect=run_codesign) as codesign:
                metadata = verify.verify_archive(
                    archive_path, "darwin-arm64", sidecar, resources, extracted_engine, "0.0.1-rc.0"
                )

            files = {item["path"]: item["sha256"] for item in metadata["files"]}
            self.assertEqual(extracted_engine.read_bytes(), archive_engine)
            self.assertEqual(
                files["resources/engine/engine"], hashlib.sha256(archive_engine).hexdigest()
            )
            self.assertEqual(files["App.app/Contents/Info.plist"], hashlib.sha256(plist).hexdigest())
            self.assertEqual(metadata["sha256"], hashlib.sha256(archive_path.read_bytes()).hexdigest())
            self.assertEqual(codesign.call_args_list[0].args[0][1], "--verify")

    def test_macos_info_plist_requires_numeric_semver_base(self) -> None:
        valid = plistlib.dumps({
            "CFBundleShortVersionString": "0.0.1",
            "CFBundleVersion": "0.0.1",
        })
        verify.verify_macos_info_plist(valid, "0.0.1-rc.0")
        invalid = plistlib.dumps({
            "CFBundleShortVersionString": "0.0.1-rc.0",
            "CFBundleVersion": "0.0.1-rc.0",
        })
        with self.assertRaisesRegex(RuntimeError, "Info.plist versions"):
            verify.verify_macos_info_plist(invalid, "0.0.1-rc.0")

    def test_macos_app_plist_selection_ignores_helper_plists(self) -> None:
        names = [
            "DJI LUT.app/Contents/Info.plist",
            "DJI LUT.app/Contents/Frameworks/DJI LUT Helper.app/Contents/Info.plist",
            "DJI LUT.app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist",
        ]
        self.assertEqual(
            verify.macos_app_info_plist_member(names),
            "DJI LUT.app/Contents/Info.plist",
        )

    def test_windows_archive_engine_is_compared_by_direct_hash(self) -> None:
        with tempfile.TemporaryDirectory(prefix="dji-lut-windows-archive-test-") as temporary:
            root = Path(temporary)
            archive_path = root / verify.TARGETS["windows-amd64"]["artifact"]
            sidecar = root / "generated-engine.exe"
            extracted_engine = root / "owned-temp" / "engine.exe"
            engine_bytes = b"verified windows engine"
            sidecar.write_bytes(engine_bytes)
            resources = {"resources/LICENSE": b"license"}
            with zipfile.ZipFile(archive_path, "w") as output:
                output.writestr("App/resources/engine/engine.exe", engine_bytes)
                output.writestr("App/resources/LICENSE", resources["resources/LICENSE"])
            metadata = verify.verify_archive(
                archive_path, "windows-amd64", sidecar, resources, extracted_engine, "0.0.1-rc.0"
            )
            self.assertEqual(extracted_engine.read_bytes(), engine_bytes)
            files = {item["path"]: item["sha256"] for item in metadata["files"]}
            self.assertEqual(files["resources/engine/engine.exe"], hashlib.sha256(engine_bytes).hexdigest())

    def test_runtime_tool_startup_discards_output_and_checks_both_tools(self) -> None:
        with tempfile.TemporaryDirectory(prefix="dji-lut-runtime-tools-test-") as temporary:
            with mock.patch.object(
                verify.subprocess,
                "run",
                side_effect=[mock.Mock(returncode=0), mock.Mock(returncode=0)],
            ) as run:
                verify.verify_native_runtime_tools(Path(temporary), "darwin-arm64")
            self.assertEqual(
                [[Path(call.args[0][0]).name, call.args[0][1]] for call in run.call_args_list],
                [["ffmpeg", "-version"], ["ffprobe", "-version"]],
            )
            self.assertTrue(all(call.kwargs["stdout"] == verify.subprocess.DEVNULL for call in run.call_args_list))
            self.assertTrue(all(call.kwargs["stderr"] == verify.subprocess.DEVNULL for call in run.call_args_list))

    def test_runtime_tool_startup_fails_closed_on_nonzero_exit(self) -> None:
        with tempfile.TemporaryDirectory(prefix="dji-lut-runtime-tools-failure-test-") as temporary:
            with mock.patch.object(verify.subprocess, "run", return_value=mock.Mock(returncode=1)):
                with self.assertRaisesRegex(RuntimeError, "ffmpeg failed its native startup check"):
                    verify.verify_native_runtime_tools(Path(temporary), "darwin-arm64")

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
                plist_path = "App.app/Contents/Info.plist"
                plist_bytes = b"main app Info.plist"
                with zipfile.ZipFile(archive_path, "w") as archive:
                    for name, body in resource_files.items():
                        archive.writestr(f"App/Contents/{name}", body)
                    if target.startswith("darwin-"):
                        archive.writestr(plist_path, plist_bytes)
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
                        "archive_resource_files": len(resource_files) + int(target.startswith("darwin-")),
                    },
                    "files": files,
                }
                if target.startswith("darwin-"):
                    metadata["files"].append({
                        "path": f"archive/{plist_path}",
                        "sha256": hashlib.sha256(plist_bytes).hexdigest(),
                    })
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
