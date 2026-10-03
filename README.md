# DJI LUT

DJI LUT is a local desktop app for identifying DJI Log footage and restoring it with a matching DJI 3D LUT. It opens a Chinese interface in the default browser and keeps processing on the user's computer.

## Run a release package

Put the platform package beside the source videos and launch it:

| Package | Platform | Minimum system |
| --- | --- | --- |
| `Mac-AppleSilicon.zip` | macOS arm64 | macOS 12 |
| `Mac-Intel.zip` | macOS x86_64 | macOS 12 |
| `Windows-x64.zip` | Windows x64 | Windows 10 |

The package includes FFmpeg, FFprobe, the Chinese interface, and the LUT files selected when that release was built. It needs no Go, Python, FFmpeg installation, or network access at runtime. macOS apps are ad-hoc signed and are not notarized; Windows executables are unsigned.

The app scans the selected folder and, optionally, its subfolders. It reads DJI `com.dji.camera.ColorGammaSxS` metadata and matches camera, profile, and look to the catalog. Normal/Rec.709 and HDR footage is copied unchanged. Unknown, unsupported, or conflicting metadata is copied unchanged and marked for review. An unavailable look does not fall back to another LUT. Source videos are never overwritten; an unverified existing output is reported as a conflict.

Outputs are written under `Output/Standard/` or `Output/Vivid/`. Converted video is re-encoded as 10-bit HEVC Rec.709, so the video pixels are not lossless; audio streams are copied. Unmodified footage is copied byte-for-byte. See [LUT source notes](assets/SOURCES.md) for the registered camera/profile/look combinations and provenance.

## Build from a source checkout

A clean source checkout intentionally contains neither LUT bytes nor FFmpeg binaries. It supports source tests, but the app needs a prepared release build to run.

1. Install Go 1.24 or newer (1.26 recommended) and Python 3.10 or newer.
2. Test the source without third-party payloads:

   ```sh
   go test ./...
   ```

3. Prepare the FFmpeg runtime for the target. The URLs, archive hashes, binary hashes, version, platform, and minimum OS are tracked in [`packaging/runtime-lock.json`](packaging/runtime-lock.json):

   ```sh
   python3 packaging/prepare_runtime.py darwin-arm64
   ```

   Use `darwin-amd64` or `windows-amd64` for those packages. The script downloads into ignored `packaging/downloads/`, verifies each archive and executable, and writes a clean local cache with the applicable FFmpeg and Go license files.

4. Prepare LUT files. The five D-Log M `.cube` files have direct DJI download URLs in the catalog and are fetched by the script. For the four Pocket 4P LUTs, download the named files from [DJI's LUT library](https://www.dji.com/lut) into a temporary directory, then import and verify them:

   ```sh
   python3 packaging/prepare_luts.py --source-dir /path/to/pocket4p-luts
   ```

   Files are installed under ignored `assets/luts/` only after their catalog SHA-256 values match. DJI LUT redistribution rights are not documented here; see [THIRD_PARTY.md](THIRD_PARTY.md) before sharing a built package.

5. Build one or more release targets:

   ```sh
   python3 packaging/build.py darwin-arm64
   ```

   The build verifies every LUT and runtime against the tracked lock/catalog, uses the `bundled` Go build tag, and writes packages under ignored `dist/`. Supported targets are `darwin-arm64`, `darwin-amd64`, and `windows-amd64`. A clean clone can run `go test ./...` without steps 3 or 4.

The package build does not copy local validation JSON, screenshots, or version-command output. The project source is MIT-licensed as described in [LICENSE](LICENSE); third-party components have separate terms.
