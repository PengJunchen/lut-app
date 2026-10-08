# DJI LUT

[简体中文](README.md) | **English**

DJI LUT is an offline video color-restoration tool. It reads DJI video metadata, selects an exact matching official LUT, and saves the result as a new file.

The project maintains a catalog of official DJI LUTs and expands automatic conversion coverage over time. The catalog spans DJI product lines, but automatic conversion is limited to footage with an exact camera, Log profile, and look mapping in `assets/catalog.json`. A catalog entry does not by itself mean that a camera is supported for automatic conversion or has passed camera-footage acceptance testing.

[rc0.0.1 downloads](https://github.com/PengJunchen/lut-app/releases/tag/rc0.0.1) · [Usage guide (Chinese)](docs/USAGE.zh-CN.md) · [Architecture (Chinese)](docs/ARCHITECTURE.zh-CN.md) · [Contributing (Chinese)](CONTRIBUTING.md) · [Release process (Chinese)](docs/RELEASING.zh-CN.md)

## Current coverage

As of 2026-10-08, the audit of DJI's official catalog records 44 LUT detail pages, four of which have been superseded by later versions. `assets/library.json` contains 58 source and camera asset records; deduplicating by SHA-256 leaves 40 unique `.cube` files. `assets/catalog.json` has another 44 exact camera, Log-profile, and look mappings for automatic conversion. These counts refer to different things: detail pages, catalog records, LUT payloads, and automatic mappings. See the [official LUT research (Chinese)](docs/DJI_LUT_RESEARCH.zh-CN.md) and [asset source list (Chinese)](assets/SOURCES.md) for sources and version details.

Automatic conversion requires metadata that identifies a supported DJI camera and a D-Log, D-Log2, or D-Log M profile in `com.dji.camera.ColorGammaSxS`. The app must then find an exact mapping for the camera, input profile, and selected look. If camera or Gamma metadata is missing, conflicting, or unrecognized, or if no exact LUT mapping exists, the app does not guess or fall back to a similar camera model.

| Footage | Current behavior |
| --- | --- |
| Camera and Log metadata are recognized, with a matching D-Log, D-Log2, or D-Log M LUT | Convert using the exact mapping for the selected Standard or Vivid look |
| Normal / Rec.709 or recognized HDR footage, including HLG | Copy unchanged without applying a Log LUT |
| Camera or Gamma information is unknown, missing, conflicting, or has no exact LUT mapping | Copy unchanged and mark for review |
| HLG, creative-grading, sRGB, Linear, and other non-restoration LUTs | Available in the LUT catalog, but not used for automatic conversion |

The scanner discovers candidate videos by **38 filename extensions**. An extension only identifies a candidate; it does not guarantee that FFmpeg can decode the file, that it contains reliable DJI metadata, or that its camera and LUT are supported. FFprobe checks whether it can inspect a candidate and find a supported video stream; passing this check does not guarantee a full decode will succeed. Special footage such as raw H.264/H.265, OSV panoramas, or files with multiple main video streams may be preserved for review. See the [usage guide (Chinese)](docs/USAGE.zh-CN.md) for format and processing details.

## Interface language

The current source build offers an in-app selector between Simplified Chinese and English. The Electron desktop app stores the selection in its `userData` preferences; the local browser app stores it in the browser's `localStorage`. Browser storage is scoped to an origin, including the local service port, so a restart that uses a different port may make the previous language preference unavailable. The public `0.0.1-rc.0` installers listed below predate the interface change and still have a Chinese-only interface.

Use the header **Language** selector to choose 中文 or English in either interface mode, including during processing. Switching preserves settings, a valid preview and the active batch; official LUT names, paths and JSON reports retain their original values. See [Localization](docs/LOCALIZATION.md) for translation maintenance.

## Downloads and releases

The current public RC has application version `0.0.1-rc.0`, Git tag **`rc0.0.1`**, and GitHub Release title `DJI LUT 0.0.1-rc.0`. Download the packages from the [rc0.0.1 Release page](https://github.com/PengJunchen/lut-app/releases/tag/rc0.0.1):

| Platform | Download |
| --- | --- |
| macOS Apple Silicon | [DJI-LUT-macOS-AppleSilicon.zip](https://github.com/PengJunchen/lut-app/releases/download/rc0.0.1/DJI-LUT-macOS-AppleSilicon.zip) |
| macOS Intel | [DJI-LUT-macOS-Intel.zip](https://github.com/PengJunchen/lut-app/releases/download/rc0.0.1/DJI-LUT-macOS-Intel.zip) |
| Windows x64 | [DJI-LUT-Windows-x64.zip](https://github.com/PengJunchen/lut-app/releases/download/rc0.0.1/DJI-LUT-Windows-x64.zip) |

The release targets macOS 13 or later (Apple Silicon and Intel) and Windows 10 x64. Pull requests and `main` run native build checks on all three target platforms; pushing an `rc*` or `v*` tag builds the three release packages and attaches them to a GitHub Release. Maintainers must update the application version fields in a commit merged to `main` before creating a tag. The release workflow checks the source version against the tag; it does not rewrite version files. Build status is available in [GitHub Actions](https://github.com/PengJunchen/lut-app/actions). See the [release process (Chinese)](docs/RELEASING.zh-CN.md) for the full steps.

After a successful PR or `main` build, download `preview-darwin-arm64`, `preview-darwin-amd64`, or `preview-windows-amd64` from that Actions run's Artifacts to try its interface changes. Each preview archive contains the desktop ZIP and build metadata and is retained for seven days. GitHub may require sign-in to download it. Preview builds are not formal releases.

Desktop packages include the Electron interface, Go engine, FFmpeg, FFprobe, and LUT resources pinned at build time. They do not require separate installation of these tools or an internet connection for normal use. macOS packages are ad-hoc signed and not notarized; Windows packages have no commercial code signature. See [third-party materials](THIRD_PARTY.md) for licensing boundaries in release packages and local builds.

## Workflow and processing behavior

1. Unzip the package for your platform and launch it from beside the footage folder. The Electron package opens a desktop window; the lightweight Go package opens the local interface in your default browser. Video inspection and processing run on your computer.
2. Enter the footage folder. You can leave the output base folder blank (the default is `Output/` inside the footage folder) or choose another location. Subfolders are not scanned unless you enable recursive scanning.
3. Choose the Standard or Vivid look and scan for a preview. Before processing, review each file's detected metadata, planned LUT, and reason. Items marked for review are copied unchanged and counted among the preserved files.
4. Start the batch to view progress or cancel it. Completed outputs are retained. When the batch finishes, open the output folder or export a JSON report. Reports may contain paths, filenames, and summaries; review and remove personal information before sharing.

Original footage is never overwritten. Files that need conversion are written to `Output/Standard/` or `Output/Vivid/` (or to the selected output base folder). Converted video is re-encoded as 10-bit HEVC Rec.709, so the pixel data is not lossless. Audio streams are copied when possible. If an audio stream cannot be muxed into MP4 (for example, PCM), the output uses MKV to preserve it. Footage that does not need a LUT is copied byte for byte. See the [usage guide (Chinese)](docs/USAGE.zh-CN.md) for the full workflow.

The Go version can also provide a local browser interface or run headless batch processing. The Electron desktop app uses the same Go engine.

## Build from source

Go 1.24 or later is required. The regular Go source tests do not require FFmpeg, LUTs, or other runtime files:

```sh
go test ./...
```

Electron development also requires Node.js 22.12 or later:

```sh
npm ci
npm test
```

For runtime preparation, LUT verification, and platform packaging, see the [Electron build guide (Chinese)](docs/ELECTRON.zh-CN.md). The [architecture guide (Chinese)](docs/ARCHITECTURE.zh-CN.md) describes the modules and data; the [contributing guide (Chinese)](CONTRIBUTING.md) explains issue reports, LUT catalog changes, and code contributions.

Native CI prepares the current 40 LUT payloads from the SHA-256-pinned `rc0.0.1` archive for its target, then validates every payload against the current manifest to reduce dependence on the official CDN's availability. The final Go engine is still compiled from the current source. Maintainers can also run `packaging/bootstrap_luts_from_release.py --target <target>`; new or changed manifest payloads absent from that archive stop preparation and require matching official resources.

## License and project notice

The MIT license in [`LICENSE`](LICENSE) applies to the project's original source code. It does not automatically cover DJI LUTs, FFmpeg, Electron, Chromium, or other third-party materials in release packages. The project has not confirmed permission to redistribute DJI LUT files; public DJI download links are not a redistribution grant. Do not treat the project's MIT license as authorization for the LUT files or packages containing them. See [third-party materials](THIRD_PARTY.md) for details.

This is a community tool. It is not an official DJI application and is not endorsed by DJI.
