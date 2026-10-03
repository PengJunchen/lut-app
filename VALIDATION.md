# Validation

This file records repeatable checks for source changes and release builds. Keep local media details, machine paths, screenshots, and generated run logs out of Git.

## Source checkout

Run from `lut-app/`:

```sh
go test ./...
```

This check does not require LUT payloads, FFmpeg caches, or embedded runtime archives. It verifies the engine, local web service, command-line startup behavior, and safe bundle extraction helpers.

## Release build

After preparing the target runtime and LUTs as described in `README.md`, build a target:

```sh
python3 packaging/build.py darwin-arm64
```

The packaging script verifies runtime executable hashes against `packaging/runtime-lock.json` and LUT hashes against `assets/catalog.json`, then compiles with the `bundled` build tag. A release record should identify the target, toolchain version, command, result, and final archive SHA-256. Keep per-machine diagnostics and sample-media reports outside Git.

Do not infer a platform release claim from a source test or cross-compilation alone. Record native launch and media-processing checks separately when they are performed.
