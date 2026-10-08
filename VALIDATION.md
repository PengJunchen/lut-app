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

## 2026-10-08 guided interface / version 2.3.0

- Interface: the default workflow uses three views in one application window, with back navigation and a classic-layout switch. LUT resources open in a dialog; both catalogs start collapsed and have pagination. Video pages contain at most five items, with complete details available separately. Changing settings invalidates the plan; active batches lock settings, and completed batches cannot be restarted through navigation.
- Source checks: 60 Go tests and 22 desktop tests passed. Renderer and Electron entrypoint syntax checks, unique HTML IDs, static ID references and whitespace checks passed. No dependencies or media-processing algorithms changed.
- Chromium checks: an isolated, hidden Electron run passed 55 assertions covering navigation, settings invalidation, empty plans, pagination, escaping, modal focus, pending requests, cancellation, reconnection and terminal-state protection. At content sizes 1120×790 and 960×650, all five preview rows, paging controls and the start button were visible without document scrolling. Long names, paths and reasons stayed within their rows and remained complete in the detail dialog. Lost run acknowledgement followed by reconnection resumed polling and reached completion without another run request.
- Native Apple Silicon acceptance: on-demand LUT browsing, six-result 1D search, folder selection, nonrecursive and recursive previews, mode switching, configuration locking, completed-batch review, empty-directory feedback and the report save dialog passed. The 18-file Vivid batch encoded two files, copied 16, marked two of the copied files for review, and had zero failures. The saved report matched the generated report byte for byte.
- Media checks: both restored outputs retained 3840×2160, used 10-bit HEVC Rec.709, passed full video/audio decode and preserved all 188 AAC packet payloads per clip. All 16 copied files matched input hashes. All 18 fixture input hashes and both original-recording hashes remained unchanged. The D-Log/D-Log2 fixtures were short, remuxed real excerpts with original camera identifiers restored; Normal, OSV and missing-gamma variants were controlled classification fixtures, not evidence of new camera or panoramic-format support.
- Release checks: all three Electron ZIPs passed CRC checks and contained the exact final renderer, library and catalog data, all 40 Cube payloads, four nonempty license files, and the expected Go and Electron executable architectures. All three ASAR packages reported version 2.3.0 and matched the final Electron entrypoints. Both macOS packages passed strict recursive ad-hoc signature verification; archive SHA-256 checks passed. No local build path was found in the embedded Go executables.
- Platform boundary: Apple Silicon launch and processing were tested locally. Intel macOS and Windows x64 were cross-built and inspected, without native execution on those target systems. Temporary test harnesses, media and per-machine diagnostics were removed after validation; release packages and required build resources remain ignored by source Git.

## Public RC release acceptance

The first public release uses application version `0.0.1-rc.0` and tag `rc0.0.1`. Earlier development version labels above are validation history, not public releases.

The GitHub workflow runs source tests, validates committed version fields and builds each desktop target on its native operating system and architecture. Its release smoke check starts the actual Go sidecar, verifies catalog/library loading and checks extracted runtime binaries, all 40 LUT payloads, license hashes and archive resources. The aggregation job checks all three ZIP CRCs and their recorded hashes before publishing.

`BUILD-METADATA.json` and `SHA256SUMS` accompany the release. They bind the three platform archives to the tag, version and commit using public relative paths and SHA-256 values. They intentionally exclude private machine paths, account data, runtime tokens and media reports. Native sidecar startup is a narrower claim than GUI interaction or camera-footage acceptance. See [release procedure](docs/RELEASING.zh-CN.md) and the linked GitHub Actions run for results from the exact published commit.

## 2026-10-08 published rc0.0.1

- Published source: annotated tag `rc0.0.1` resolves to `611b475448e0515b77b778f09374947f049d3ba2`; application version is `0.0.1-rc.0`. The Release display title is `DJI LUT 0.0.1-rc.0` and it is a public prerelease, not a draft.
- Native CI: [the tag workflow](https://github.com/PengJunchen/lut-app/actions/runs/37743036466) completed successfully, including source/version checks, all three native build jobs and verified publication. Go package tests and race checks passed, along with 28 Python packaging/release tests and 27 Electron desktop tests; optional media integrations remain subject to the prerequisites described above. Both macOS architectures and Windows x64 passed the actual archived Go-sidecar startup, runtime and resource checks described above.
- Release assets: the three platform ZIPs, `BUILD-METADATA.json` and `SHA256SUMS` were uploaded, downloaded again by the publication job and hash-verified before the draft was made public.
- Independent package audit: all five published assets were downloaded separately and matched GitHub's asset sizes and SHA-256 digests. All three ZIPs passed CRC checks, Electron and Go executable architecture checks, packaged application-version checks, source-resource and license checks, and exact comparison of packaged Electron entrypoints and library modules with the release source. Public build metadata matched the tag/source commit, contained the expected 44 catalog entries, 58 library records and 40 unique LUT payloads, and passed schema and private-path checks.
- Native GUI: the published Apple Silicon ZIP was independently downloaded, checked against GitHub's asset digest and extracted. The entire application passed `codesign --verify --deep --strict`, started with the default guided interface, loaded the on-demand LUT dialog with 58 library records, and shut down without leaving its application processes running.
- Acceptance boundary: manual GUI interaction for Intel macOS and Windows, and additional real-camera footage coverage, were not performed for this RC. Native sidecar checks and static package checks do not expand the real-footage coverage recorded in the earlier acceptance entries.
