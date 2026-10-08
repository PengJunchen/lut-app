from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest import mock

PACKAGING = Path(__file__).resolve().parent
sys.path.insert(0, str(PACKAGING))
import bootstrap_luts_from_release as bootstrap
import prepare_luts


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


class ReleaseLUTBootstrapTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.scratch = Path(self.temp.name)
        self.root = self.scratch / "repo"
        self.payload = b"locked test LUT payload"
        self.record = {
            "id": "test-lut",
            "file": "sha256-test.cube",
            "sha256": digest(self.payload),
            "format": "cube",
            "source_url": "",
        }
        write_json(
            self.root / "assets" / "library.json",
            {"schema": 1, "assets": [self.record]},
        )
        self.cache_parent = self.scratch / "user-cache" / "DJILUTApp" / "bundles"
        self.lock = dict(bootstrap.RELEASES["darwin-arm64"])
        self.archive = self.scratch / "rc0.0.1.zip"
        self.write_engine_archive()
        self.lock["archive_sha256"] = bootstrap.sha256_file(self.archive)
        self.patch_lock()

    def patch_lock(self) -> None:
        patcher = mock.patch.dict(bootstrap.RELEASES, {"darwin-arm64": self.lock})
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_engine_archive(self, *, symlink: bool = False, include_engine: bool = True) -> None:
        with zipfile.ZipFile(self.archive, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
            if include_engine:
                member = zipfile.ZipInfo(self.lock["engine_member"])
                member.create_system = 3
                member.external_attr = (
                    (stat.S_IFLNK | 0o777) if symlink else (stat.S_IFREG | 0o700)
                ) << 16
                zipped.writestr(member, b"test native engine bytes")

    def native_args(self) -> dict:
        return {"host": "darwin", "machine": "arm64", "expected_count": 1}

    def runner(self, payload: bytes | None, *, exit_code: int = 0):
        def run(command: list[str], **kwargs):
            self.assertEqual(command[1:3], ["--batch", "--dry-run"])
            self.assertTrue(command[3].startswith("--input="))
            empty_input = Path(command[3].split("=", 1)[1])
            self.assertTrue(empty_input.is_dir())
            self.assertEqual(list(empty_input.iterdir()), [])
            self.assertIsNone(kwargs.get("env"))
            self.assertEqual(kwargs.get("stdin"), subprocess.DEVNULL)
            self.assertEqual(kwargs.get("timeout"), 180)
            self.assertEqual(empty_input.parent, kwargs.get("cwd"))
            self.assertTrue(Path(kwargs["cwd"]).is_dir())
            if exit_code == 0:
                lut_root = (
                    self.cache_parent / "darwin-arm64-test" / "assets" / "luts"
                )
                lut_root.mkdir(parents=True, exist_ok=True)
                if payload is not None:
                    (lut_root / self.record["file"]).write_bytes(payload)
            return subprocess.CompletedProcess(command, exit_code, stdout="{}", stderr="")

        return run

    def test_archive_checksum_is_checked_before_engine_execution(self) -> None:
        self.lock["archive_sha256"] = "0" * 64
        self.patch_lock()
        run_command = mock.Mock()
        with self.assertRaisesRegex(bootstrap.BootstrapError, "ZIP checksum mismatch"):
            bootstrap.bootstrap(
                "darwin-arm64",
                archive_path=self.archive,
                root=self.root,
                cache_parent=self.cache_parent,
                run_command=run_command,
                **self.native_args(),
            )
        run_command.assert_not_called()
        self.assertFalse((self.root / "assets" / "luts").exists())

    def test_archive_must_contain_a_regular_native_engine(self) -> None:
        for label, symlink, include_engine in (
            ("missing", False, False),
            ("symlink", True, True),
        ):
            with self.subTest(label=label):
                self.write_engine_archive(symlink=symlink, include_engine=include_engine)
                self.lock["archive_sha256"] = bootstrap.sha256_file(self.archive)
                self.patch_lock()
                run_command = mock.Mock()
                with self.assertRaises(bootstrap.BootstrapError):
                    bootstrap.bootstrap(
                        "darwin-arm64",
                        archive_path=self.archive,
                        root=self.root,
                        cache_parent=self.cache_parent,
                        run_command=run_command,
                        **self.native_args(),
                    )
                run_command.assert_not_called()

    def test_engine_failure_does_not_call_current_prepare_or_publish(self) -> None:
        run_command = self.runner(self.payload, exit_code=1)
        prepare = mock.patch.object(bootstrap.prepare_luts, "prepare")
        with prepare as prepare_mock:
            with self.assertRaisesRegex(bootstrap.BootstrapError, "engine failed"):
                bootstrap.bootstrap(
                    "darwin-arm64",
                    archive_path=self.archive,
                    root=self.root,
                    cache_parent=self.cache_parent,
                    run_command=run_command,
                    **self.native_args(),
                )
        prepare_mock.assert_not_called()
        self.assertFalse((self.root / "assets" / "luts").exists())

    def test_engine_timeout_does_not_call_current_prepare_or_publish(self) -> None:
        run_command = mock.Mock(
            side_effect=subprocess.TimeoutExpired(cmd="engine", timeout=180)
        )
        existing = self.root / "assets" / "luts" / "preserve.cube"
        existing.parent.mkdir(parents=True)
        existing.write_bytes(b"previous published tree")
        prepare = mock.patch.object(bootstrap.prepare_luts, "prepare")
        with prepare as prepare_mock:
            with self.assertRaisesRegex(bootstrap.BootstrapError, "timed out after 180 seconds"):
                bootstrap.bootstrap(
                    "darwin-arm64",
                    archive_path=self.archive,
                    root=self.root,
                    cache_parent=self.cache_parent,
                    run_command=run_command,
                    **self.native_args(),
                )
        run_command.assert_called_once()
        self.assertEqual(run_command.call_args.kwargs["timeout"], 180)
        prepare_mock.assert_not_called()
        self.assertEqual(existing.read_bytes(), b"previous published tree")

    def test_missing_or_changed_cached_payload_cannot_publish(self) -> None:
        existing = self.root / "assets" / "luts" / "preserve.cube"
        existing.parent.mkdir(parents=True)
        existing.write_bytes(b"previous published tree")

        for label, source_payload in (("missing", None), ("changed", b"wrong bytes")):
            with self.subTest(label=label):
                self.cache_parent = self.scratch / f"{label}-cache" / "DJILUTApp" / "bundles"
                run_command = self.runner(source_payload)
                prepare = mock.patch.object(bootstrap.prepare_luts, "prepare")
                with prepare as prepare_mock:
                    with self.assertRaisesRegex(bootstrap.BootstrapError, "40-payload SHA-256 lock"):
                        bootstrap.bootstrap(
                            "darwin-arm64",
                            archive_path=self.archive,
                            root=self.root,
                            cache_parent=self.cache_parent,
                            run_command=run_command,
                            **self.native_args(),
                        )
                prepare_mock.assert_not_called()
                self.assertEqual(existing.read_bytes(), b"previous published tree")

    def test_valid_native_release_cache_is_rechecked_by_current_prepare(self) -> None:
        run_command = self.runner(self.payload)
        original_prepare = prepare_luts.prepare
        with mock.patch.object(
            bootstrap.prepare_luts, "prepare", wraps=original_prepare
        ) as prepare_mock:
            prepared = bootstrap.bootstrap(
                "darwin-arm64",
                archive_path=self.archive,
                root=self.root,
                cache_parent=self.cache_parent,
                run_command=run_command,
                **self.native_args(),
            )
        self.assertEqual(prepared, 1)
        prepare_mock.assert_called_once_with(
            self.cache_parent / "darwin-arm64-test" / "assets" / "luts",
            self.root,
        )
        self.assertEqual(
            (self.root / "assets" / "luts" / self.record["file"]).read_bytes(),
            self.payload,
        )

    def test_wrong_native_target_is_rejected_before_downloading(self) -> None:
        download = mock.patch.object(bootstrap, "download_release_archive")
        with download as download_mock:
            with self.assertRaisesRegex(bootstrap.BootstrapError, "requires native"):
                bootstrap.bootstrap(
                    "darwin-arm64",
                    root=self.root,
                    cache_parent=self.cache_parent,
                    host="darwin",
                    machine="x86_64",
                    expected_count=1,
                )
        download_mock.assert_not_called()

    def test_bad_download_hash_preserves_archive_cleans_partial_and_skips_engine(self) -> None:
        retained_scratch = self.scratch / "retained-bootstrap-scratch"
        retained_scratch.mkdir()
        destination = retained_scratch / self.lock["archive"]
        original_archive = b"previous archive must remain intact"
        destination.write_bytes(original_archive)

        class RetainedTemporaryDirectory:
            def __enter__(self) -> str:
                return str(retained_scratch)

            def __exit__(self, exc_type, exc, traceback) -> bool:
                return False

        run_command = mock.Mock()
        prepare = mock.patch.object(bootstrap.prepare_luts, "prepare")
        with (
            mock.patch.object(
                bootstrap.tempfile,
                "TemporaryDirectory",
                return_value=RetainedTemporaryDirectory(),
            ),
            mock.patch.object(
                bootstrap, "urlopen", return_value=io.BytesIO(b"bad ZIP download")
            ),
            prepare as prepare_mock,
        ):
            with self.assertRaisesRegex(bootstrap.BootstrapError, "ZIP checksum mismatch"):
                bootstrap.bootstrap(
                    "darwin-arm64",
                    root=self.root,
                    cache_parent=self.cache_parent,
                    run_command=run_command,
                    **self.native_args(),
                )

        self.assertEqual(destination.read_bytes(), original_archive)
        self.assertEqual(list(retained_scratch.glob(destination.name + ".*")), [])
        run_command.assert_not_called()
        prepare_mock.assert_not_called()
        self.assertFalse((self.root / "assets" / "luts").exists())


if __name__ == "__main__":
    unittest.main()
