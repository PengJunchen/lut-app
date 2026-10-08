# Third-party materials

The MIT license in `LICENSE` covers the project's original source code. It does not cover bundled DJI LUT files, FFmpeg/FFprobe, Go, Electron, or Chromium; each has its own source and license terms.

## DJI LUT files

The `.cube` files are DJI assets and are not licensed by this project's MIT license. The official [DJI downloads](https://www.dji.com/cn/downloads) and [support pages](https://repair.dji.com/help/content?customId=01700007105&lang=en&paperDocType=ARTICLE&re=US&spaceId=17) identify the LUTs, but a LUT-specific grant allowing third-party redistribution was not found as of 2026-10-08. Redistribution rights are unconfirmed. See [`assets/SOURCES.md`](assets/SOURCES.md) for the catalog and source details.

## FFmpeg and FFprobe

The Go engine bundles the FFmpeg and FFprobe binaries pinned in [`packaging/runtime-lock.json`](packaging/runtime-lock.json). These binaries are separate from the project's MIT-licensed source. The upstream [FFmpeg licensing page](https://ffmpeg.org/legal.html) explains that GPL components make GPL terms apply to FFmpeg. The three selected builds report `--enable-gpl --enable-version3`; each archive includes the matching upstream [`COPYING.GPLv3` for 8.1.2](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n8.1.2/COPYING.GPLv3) or [9.0.2](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n9.0.2/COPYING.GPLv3) at the platform-specific `licenses/` path listed below.

Version-specific vendor records, upstream source, and known limits for the pinned builds:

- **macOS arm64 — Martin Riedl 9.0.2:** [build record](https://ffmpeg.martin-riedl.de/info/detail/macos/arm64/1789931890_9.0.2), [FFmpeg ZIP](https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip), [FFprobe ZIP](https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip), [configuration and dependency versions](https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/versions.txt), and [FFmpeg 9.0.2 source](https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz). The vendor publishes a [build script repository](https://git.martin-riedl.de/ffmpeg/build-script), but a script snapshot tied to this 9.0.2 build was not found.
- **macOS Intel — Evermeet 8.1.2-tessus:** [FFmpeg](https://evermeet.cx/ffmpeg/ffmpeg-8.1.2.zip), [FFprobe](https://evermeet.cx/ffmpeg/ffprobe-8.1.2.zip), [FFmpeg build information](https://evermeet.cx/ffmpeg/info/ffmpeg/8.1.2), [FFprobe build information](https://evermeet.cx/ffmpeg/info/ffprobe/8.1.2), and [FFmpeg 8.1.2 source](https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz). The information API lists bundled library versions and source links; an Evermeet build-script snapshot for this binary was not found.
- **Windows x64 — Gyan Essentials 8.1.2:** [pinned vendor archive](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip), [vendor checksum](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip.sha256), [Gyan build page](https://www.gyan.dev/ffmpeg/builds/), [8.1.2 release record and source commit](https://github.com/GyanD/codexffmpeg/releases/tag/8.1.2), and [FFmpeg 8.1.2 source](https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz). The release page does not provide a matching build-script snapshot or a complete dependency source bundle.

These upstream FFmpeg source links identify the matching FFmpeg versions; they are not vendor-specific rebuild bundles. Where a build-script snapshot or a complete source set for bundled external libraries was not published or identified above, it remains unconfirmed. The archive contains the license text and runtime lock records, not the FFmpeg source archives.

For RC 0.0.1, the GPLv3 notice is at `DJI LUT.app/Contents/Resources/licenses/COPYING.GPLv3` in both macOS archives and `resources/licenses/COPYING.GPLv3` in the Windows archive.

## Go

The app uses the Go standard library. The Go license text is included in each archive as `licenses/Go-LICENSE`.

## Electron and Chromium

The desktop package includes Electron and Chromium. Their notices are included as `licenses/Electron-LICENSE.txt` and `licenses/Chromium-LICENSES.html`.

The project is not an official DJI application and is not endorsed by DJI.
