# Third-party materials

The MIT license in `LICENSE` covers original project source only. It does not cover the assets or executables listed below.

## DJI LUT files

The catalog and source notes are tracked; `.cube` payloads are ignored and are not included in a source checkout. `packaging/prepare_luts.py` obtains or imports the files locally and verifies each SHA-256 before a release build embeds them. DJI's public download and support pages identify the LUTs, but no LUT-specific redistribution grant was found. The rights to redistribute those files are therefore unknown. Do not treat this project's MIT license as permission to redistribute DJI LUTs. See [`assets/SOURCES.md`](assets/SOURCES.md) for URLs, labels, hashes, and limitations.

## FFmpeg and FFprobe

Release packages include FFmpeg and FFprobe binaries from the vendors recorded in [`packaging/runtime-lock.json`](packaging/runtime-lock.json). The Apple Silicon and Windows builds are GPL v3 or later; the Intel Mac build is an Evermeet FFmpeg build with its own published license and source materials. The exact selected binary hashes are checked before bundling, and the minimum OS is recorded in the lock and applied to the macOS package metadata. The preparation script includes the matching FFmpeg license text and the pinned Go license text in each local runtime cache.

The release archive does not contain FFmpeg source code. Before redistributing a package, provide the source and other materials required by the license applicable to that target's FFmpeg build. Vendor sources and build information are linked from the lock and the following pages:

- [FFmpeg source releases](https://ffmpeg.org/download.html)
- [Gyan FFmpeg builds](https://www.gyan.dev/ffmpeg/builds/)
- [Evermeet FFmpeg](https://evermeet.cx/ffmpeg/)
- [Martin Riedl FFmpeg builds](https://ffmpeg.martin-riedl.de/)

## Go

The app uses the Go standard library. Each prepared runtime cache includes Go's license text, obtained from the official Go source distribution and pinned in `packaging/license-lock.json`.

The project is not an official DJI application and is not endorsed by DJI.
