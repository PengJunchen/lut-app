# Validation

This file records repeatable checks for source changes and release builds. Keep local media details, machine paths, screenshots, and generated run logs out of Git.

## Source checkout

Run from `lut-app/`:

```sh
go test ./...
go test -race ./...
python3 -m unittest discover -s packaging -p 'test_*.py'
npm test
```

This check does not require LUT payloads, FFmpeg caches, or embedded runtime archives. It verifies the engine, local web service, command-line startup behavior, and safe bundle extraction helpers.

## Release build

After preparing the target runtime and LUTs as described in `README.md`, build a target:

```sh
python3 packaging/build.py darwin-arm64
```

The packaging script verifies runtime executable hashes against `packaging/runtime-lock.json`, all LUT payload hashes against `assets/library.json`, and the automatic catalog's links to the library, then compiles with the `bundled` build tag. A release record should identify the target, toolchain version, command, result, and final archive SHA-256. Keep per-machine diagnostics and sample-media reports outside Git.

Do not infer a platform release claim from a source test or cross-compilation alone. Record native launch and media-processing checks separately when they are performed.

## 2026-10-08 LUT refresh / version 2.2.0

- Official inventory: 44 LUT pages reviewed, 40 current pages retained, four superseded Pocket 4/4P D-Log V1.0 pages excluded. The library contains 58 source/camera records and 40 unique official Cube payloads; 44 exact camera/profile/look combinations support automatic Rec.709 restoration. See [source research](docs/DJI_LUT_RESEARCH.zh-CN.md).
- Payload checks: all SHA-256 values, eight ZIP archives and their 25 Cube members verified. All 40 unique Cube files were read successfully by the bundled native FFmpeg, using `lut3d` or `lut1d` as appropriate. Seven legacy Cube input-range headers required an equivalent temporary conversion; original files and RGB rows remain unchanged.
- Source checks: Go tests and race checks passed; 13 packaging tests and 22 desktop tests passed. Optional media integration tests require a compatible FFmpeg/FFprobe and, for the legacy official Cube case, the prepared LUT fixture. A source checkout does not need these acquired resources for ordinary tests.
- Native Apple Silicon acceptance: folder picker, library search (six 1D records), nine-file preview, processing, and report save dialog passed. The mixed short-fixture batch encoded four files, copied five, marked three of the copied files for review, and had zero failures. The exported JSON matched the generated report. All encoded outputs passed full decode; copied files matched input hashes. The separate CLI run also preserved AAC packet payloads for all four encoded outputs.
- Fixture scope: Pocket 4P D-Log/D-Log2 clips were short excerpts of real recordings. Other camera labels, Normal/HDR labels and raw/OSV suffixes were controlled classification fixtures; they do not establish native footage support for every listed camera or genuine panoramic media. Synthetic ProRes/PCM integration verified MKV audio preservation. Both original recordings retained their original SHA-256 values.
- Release checks: all three Electron ZIPs contain matching library/catalog data and all 40 LUT payloads; ZIP CRC, target Go executable architecture, Electron package version 2.2.0 and license files verified. Both macOS packages passed strict recursive ad-hoc signature verification. SHA-256 values are generated alongside the ZIPs in `dist/electron/SHA256SUMS.txt`.
- Platform boundary: Apple Silicon launch and processing were tested locally. Intel macOS and Windows x64 were cross-built and inspected, without native execution on those target systems.

Acquired LUTs, runtime caches, release binaries, fixture media, local paths, screenshots and per-run diagnostics are excluded from source Git. Temporary investigation and acceptance artifacts are removed after validation.
