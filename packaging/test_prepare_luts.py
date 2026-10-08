from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
from unittest import mock

PACKAGING = Path(__file__).resolve().parent
sys.path.insert(0, str(PACKAGING))
import prepare_luts

BUILD_SPEC = importlib.util.spec_from_file_location("lut_build", PACKAGING / "build.py")
assert BUILD_SPEC is not None and BUILD_SPEC.loader is not None
build_module = importlib.util.module_from_spec(BUILD_SPEC)
BUILD_SPEC.loader.exec_module(build_module)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, document: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")


def asset(
    asset_id: str,
    filename: str,
    payload: bytes,
    *,
    fmt: str,
    profile: str,
    output: str,
    purpose: str,
    automatic: bool,
) -> dict:
    return {
        "id": asset_id,
        "file": filename,
        "sha256": digest(payload),
        "format": fmt,
        "source_url": "",
        "page_url": "https://www.dji.com/downloads",
        "version": "2.0",
        "title": asset_id,
        "look": "standard",
        "profile": profile,
        "output_color_space": output,
        "purpose": purpose,
        "automatic": automatic,
        "provenance": "supplied",
        "grid": 33,
        "dimension": "3d",
        "cameras": [{"id": "pocket3", "name": "Osmo Pocket 3"}],
    }


def library_document(records: list[dict]) -> dict:
    return {
        "schema_version": 1,
        "cameras": [{"id": "pocket3", "name": "Osmo Pocket 3"}],
        "assets": records,
    }


def write_new_catalog(path: Path, record: dict) -> None:
    write_json(path, {
        "version": 1,
        "entries": [{
            "camera": "pocket3",
            "profile": record["profile"],
            "look": "standard",
            "file": record["file"],
            "sha256": record["sha256"],
            "grid": 33,
            "library_id": record["id"],
            "version": record["version"],
            "title": record["title"],
            "format": record["format"],
            "output_color_space": record["output_color_space"],
            "purpose": record["purpose"],
        }],
    })


class PrepareLUTTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / "assets" / "luts").mkdir(parents=True)
        (self.root / "assets").mkdir(exist_ok=True)
        (self.root / "packaging").mkdir(exist_ok=True)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_prepare_stages_all_formats_prunes_only_app_luts_and_verifies(self) -> None:
        cube = b"cube-v2-payload\n"
        lut3d = b"3dl-payload\n"
        cube_record = asset(
            "pocket3-dlogm-rec709-v2",
            "pocket3_dlogm_rec709_v2.cube",
            cube,
            fmt="cube",
            profile="dlogm",
            output="rec709",
            purpose="restore",
            automatic=True,
        )
        creative_record = asset(
            "air3-creative-v1",
            "air3/creative_v1.3dl",
            lut3d,
            fmt="3dl",
            profile="linear",
            output="srgb",
            purpose="creative",
            automatic=False,
        )
        write_json(self.root / "assets" / "library.json", library_document([cube_record, creative_record]))
        write_new_catalog(self.root / "assets" / "catalog.json", cube_record)

        old_tree = self.root / "assets" / "luts"
        (old_tree / "pocket3_dlogm_rec709_v1.cube").write_bytes(b"superseded-v1")
        (old_tree / "unlisted-stale.look").write_bytes(b"stale")
        source_dir = self.root / "manual-originals"
        (source_dir / "air3").mkdir(parents=True)
        (source_dir / "pocket3_dlogm_rec709_v2.cube").write_bytes(cube)
        (source_dir / "air3" / "creative_v1.3dl").write_bytes(lut3d)
        user_root = self.root / "user-luts"
        user_root.mkdir()
        (user_root / "keep.cube").write_bytes(b"untouched user LUT")

        self.assertEqual(prepare_luts.prepare(source_dir, self.root), 2)
        self.assertEqual(
            {path.relative_to(old_tree).as_posix() for path in old_tree.rglob("*") if path.is_file()},
            {"pocket3_dlogm_rec709_v2.cube", "air3/creative_v1.3dl"},
        )
        self.assertTrue((user_root / "keep.cube").is_file())
        self.assertEqual((user_root / "keep.cube").read_bytes(), b"untouched user LUT")
        build_module.verify_luts(self.root)

    def test_legacy_catalog_prefix_works_without_library_manifest(self) -> None:
        payload = b"legacy-cube\n"
        source_dir = self.root / "manual"
        source_dir.mkdir()
        (source_dir / "old.cube").write_bytes(payload)
        write_json(self.root / "assets" / "catalog.json", {
            "version": 1,
            "entries": [{
                "camera": "pocket4p",
                "profile": "dlog",
                "look": "standard",
                "file": "luts/old.cube",
                "sha256": digest(payload),
                "source_url": "https://www.dji.com/lut",
            }],
        })

        self.assertEqual(prepare_luts.prepare(source_dir, self.root), 1)
        self.assertEqual(
            (self.root / "assets" / "luts" / "old.cube").read_bytes(), payload
        )
        build_module.verify_luts(self.root)

    def test_shared_content_addressed_payload_is_prepared_once(self) -> None:
        payload = b"same cube used by two official product records"
        first = asset(
            "pocket3-dlogm",
            "sha256-shared.cube",
            payload,
            fmt="cube",
            profile="dlogm",
            output="rec709",
            purpose="restore",
            automatic=True,
        )
        second = dict(first)
        second.update({"id": "pocket4p-dlogm", "cameras": [{"id": "pocket4p", "name": "Pocket 4P"}]})
        write_json(self.root / "assets" / "library.json", library_document([first, second]))
        write_json(self.root / "assets" / "catalog.json", {
            "version": 1,
            "entries": [
                {
                    "camera": "pocket3",
                    "profile": "dlogm",
                    "look": "standard",
                    "file": first["file"],
                    "sha256": first["sha256"],
                    "library_id": first["id"],
                },
                {
                    "camera": "pocket4p",
                    "profile": "dlogm",
                    "look": "standard",
                    "file": second["file"],
                    "sha256": second["sha256"],
                    "library_id": second["id"],
                },
            ],
        })
        source_dir = self.root / "manual"
        source_dir.mkdir()
        (source_dir / first["file"]).write_bytes(payload)

        library, unique_payloads = prepare_luts.payload_records(self.root)
        self.assertIsNotNone(library)
        self.assertEqual(len(library["assets"]), 2)
        self.assertEqual(len(unique_payloads), 1)
        self.assertEqual(prepare_luts.prepare(source_dir, self.root), 1)
        self.assertEqual(
            (self.root / "assets" / "luts" / first["file"]).read_bytes(), payload
        )
        build_module.verify_luts(self.root)

        conflicting = dict(second)
        conflicting["grid"] = 65
        write_json(
            self.root / "assets" / "library.json",
            library_document([first, conflicting]),
        )
        with self.assertRaisesRegex(prepare_luts.LUTError, "conflicting hash, format, or grid"):
            prepare_luts.load_library(self.root)

    def test_bad_supplied_checksum_preserves_published_tree(self) -> None:
        existing = self.root / "assets" / "luts" / "previous.cube"
        existing.write_bytes(b"previous verified library")
        expected_payload = b"new verified library"
        record = asset(
            "new-cube",
            "new.cube",
            expected_payload,
            fmt="cube",
            profile="dlog",
            output="rec709",
            purpose="restore",
            automatic=True,
        )
        write_json(self.root / "assets" / "library.json", library_document([record]))
        write_new_catalog(self.root / "assets" / "catalog.json", record)
        source_dir = self.root / "manual"
        source_dir.mkdir()
        supplied = source_dir / "new.cube"
        supplied.write_bytes(b"wrong checksum")

        with self.assertRaisesRegex(prepare_luts.LUTError, "supplied source file checksum mismatch"):
            prepare_luts.prepare(source_dir, self.root)
        self.assertEqual(existing.read_bytes(), b"previous verified library")
        self.assertEqual(supplied.read_bytes(), b"wrong checksum")
        self.assertFalse((self.root / "assets" / "luts" / "new.cube").exists())

    def test_build_helpers_load_without_packaging_on_sys_path(self) -> None:
        payload = b"isolated build helper fixture"
        record = asset(
            "isolated-cube",
            "isolated.cube",
            payload,
            fmt="cube",
            profile="dlog",
            output="rec709",
            purpose="restore",
            automatic=True,
        )
        write_json(self.root / "assets" / "library.json", library_document([record]))
        write_new_catalog(self.root / "assets" / "catalog.json", record)
        (self.root / "assets" / "luts" / record["file"]).write_bytes(payload)

        original_path = sys.path[:]
        sys.path[:] = [
            entry for entry in sys.path
            if Path(entry or ".").resolve() != PACKAGING.resolve()
        ]
        try:
            spec = importlib.util.spec_from_file_location(
                "isolated_lut_build", PACKAGING / "build.py"
            )
            self.assertIsNotNone(spec)
            self.assertIsNotNone(spec.loader)
            isolated_build = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(isolated_build)
            isolated_build.verify_luts(self.root)
        finally:
            sys.path[:] = original_path

    def test_publish_rolls_back_if_stage_rename_fails(self) -> None:
        destination = self.root / "assets" / "luts"
        (destination / "old.cube").write_bytes(b"old")
        stage = self.root / "packaging" / "stage"
        stage.mkdir()
        (stage / "new.cube").write_bytes(b"new")
        temporary_root = self.root / "packaging" / "tmp"
        temporary_root.mkdir()
        original_replace = prepare_luts.os.replace

        def fail_stage(source: object, target: object) -> None:
            if Path(source) == stage and Path(target) == destination:
                raise OSError("injected publish failure")
            original_replace(source, target)

        with mock.patch.object(prepare_luts.os, "replace", side_effect=fail_stage):
            with self.assertRaisesRegex(OSError, "injected publish failure"):
                prepare_luts._publish_tree(stage, destination, temporary_root)
        self.assertEqual((destination / "old.cube").read_bytes(), b"old")
        self.assertFalse((destination / "new.cube").exists())

    def test_zip_member_is_exact_hashed_and_never_path_extracted(self) -> None:
        payload = b"archive cube"
        archive_path = self.root / "source.zip"
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.writestr("official/pocket.cube", payload)
        destination = self.root / "stage" / "pocket.cube"
        prepare_luts.extract_zip_member(
            archive_path,
            "official/pocket.cube",
            prepare_luts.sha256(archive_path),
            digest(payload),
            destination,
        )
        self.assertEqual(destination.read_bytes(), payload)
        with self.assertRaisesRegex(prepare_luts.LUTError, "unsafe path"):
            prepare_luts.safe_archive_member("../outside.cube")
        with self.assertRaisesRegex(prepare_luts.LUTError, "archive checksum mismatch"):
            prepare_luts.extract_zip_member(
                archive_path, "official/pocket.cube", "0" * 64, digest(payload),
                self.root / "bad" / "pocket.cube",
            )

    def test_zip_duplicate_member_is_rejected(self) -> None:
        archive_path = self.root / "duplicate.zip"
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.writestr("official/pocket.cube", b"one")
            archive.writestr("official/pocket.cube", b"two")
        with self.assertRaisesRegex(prepare_luts.LUTError, "exactly one member"):
            prepare_luts.extract_zip_member(
                archive_path,
                "official/pocket.cube",
                prepare_luts.sha256(archive_path),
                digest(b"one"),
                self.root / "stage" / "pocket.cube",
            )

    def test_library_catalog_rejects_unlisted_or_unsafe_auto_asset(self) -> None:
        cube = b"safe cube"
        safe = asset(
            "safe-cube",
            "safe.cube",
            cube,
            fmt="cube",
            profile="dlog",
            output="rec709",
            purpose="restore",
            automatic=True,
        )
        other = asset(
            "other-cube",
            "other.cube",
            b"creative cube",
            fmt="cube",
            profile="rec709",
            output="srgb",
            purpose="creative",
            automatic=False,
        )
        write_json(self.root / "assets" / "library.json", library_document([safe, other]))
        write_new_catalog(self.root / "assets" / "catalog.json", safe)
        (self.root / "assets" / "luts" / "safe.cube").write_bytes(cube)
        (self.root / "assets" / "luts" / "other.cube").write_bytes(b"creative cube")
        (self.root / "assets" / "luts" / "stale-v1.cube").write_bytes(b"stale")

        with self.assertRaisesRegex(SystemExit, "unexpected/stale"):
            build_module.verify_luts(self.root)
        (self.root / "assets" / "luts" / "stale-v1.cube").unlink()
        catalog = json.loads((self.root / "assets" / "catalog.json").read_text(encoding="utf-8"))
        catalog_entry = catalog["entries"][0]
        catalog_entry["library_id"] = other["id"]
        for field in (
            "file", "sha256", "profile", "version", "title", "grid", "format",
            "output_color_space", "purpose",
        ):
            catalog_entry[field] = other[field]
        write_json(self.root / "assets" / "catalog.json", catalog)
        with self.assertRaisesRegex(SystemExit, "non-automatic-safe"):
            build_module.verify_luts(self.root)

    def test_new_catalog_requires_library_id_when_library_is_present(self) -> None:
        cube = b"safe cube"
        record = asset(
            "safe-cube",
            "safe.cube",
            cube,
            fmt="cube",
            profile="dlog",
            output="rec709",
            purpose="restore",
            automatic=True,
        )
        write_json(self.root / "assets" / "library.json", library_document([record]))
        write_json(self.root / "assets" / "catalog.json", {
            "version": 1,
            "entries": [{
                "camera": "pocket3",
                "profile": "dlog",
                "look": "standard",
                "file": record["file"],
                "sha256": record["sha256"],
            }],
        })
        (self.root / "assets" / "luts" / "safe.cube").write_bytes(cube)
        with self.assertRaisesRegex(SystemExit, "must reference a known library_id"):
            build_module.verify_luts(self.root)

    def test_catalog_tuple_must_match_library_camera_profile_look_and_version(self) -> None:
        payload = b"tuple-matched cube"
        record = asset(
            "pocket3-dlog",
            "tuple.cube",
            payload,
            fmt="cube",
            profile="dlog",
            output="rec709",
            purpose="restore",
            automatic=True,
        )
        write_json(self.root / "assets" / "library.json", library_document([record]))
        write_new_catalog(self.root / "assets" / "catalog.json", record)
        (self.root / "assets" / "luts" / record["file"]).write_bytes(payload)
        build_module.verify_luts(self.root)

        cases = [
            ("camera", "action4", "camera does not match"),
            ("profile", "dlog2", "profile does not match"),
            ("look", "vivid", "look does not match"),
            ("version", "1.0", "version does not match"),
            ("grid", 65, "grid does not match"),
        ]
        for field, wrong_value, expected_error in cases:
            with self.subTest(field=field):
                catalog = json.loads(
                    (self.root / "assets" / "catalog.json").read_text(encoding="utf-8")
                )
                catalog["entries"][0][field] = wrong_value
                write_json(self.root / "assets" / "catalog.json", catalog)
                with self.assertRaisesRegex(SystemExit, expected_error):
                    build_module.verify_luts(self.root)
                write_new_catalog(self.root / "assets" / "catalog.json", record)

    def test_automatic_catalog_rejects_one_dimensional_library_asset(self) -> None:
        payload = b"one dimensional cube"
        record = asset(
            "pocket3-dlog",
            "one-d.cube",
            payload,
            fmt="cube",
            profile="dlog",
            output="rec709",
            purpose="restore",
            automatic=True,
        )
        record["dimension"] = "1d"
        write_json(self.root / "assets" / "library.json", library_document([record]))
        write_new_catalog(self.root / "assets" / "catalog.json", record)
        (self.root / "assets" / "luts" / record["file"]).write_bytes(payload)
        with self.assertRaisesRegex(SystemExit, "non-automatic-safe"):
            build_module.verify_luts(self.root)

    def test_dji_download_urls_require_https_and_official_host(self) -> None:
        self.assertTrue(prepare_luts.official_https_url("https://terra-1-g.djicdn.com/lut.cube"))
        self.assertTrue(prepare_luts.official_https_url("https://www.dji.com/files/lut.zip"))
        for url in (
            "http://www.dji.com/lut.cube",
            "https://djicdn.com.attacker.example/lut.cube",
            "https://user@www.dji.com/lut.cube",
            "https://www.dji.com:444/lut.cube",
        ):
            self.assertFalse(prepare_luts.official_https_url(url), url)


if __name__ == "__main__":
    unittest.main()
