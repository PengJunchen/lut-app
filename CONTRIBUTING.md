# Contributing

The tracked repository contains application source and dependency metadata.
Acquired FFmpeg binaries, runtime archives, build products, and DJI `.cube`
files stay local and are excluded by `.gitignore`.

Use Go 1.24 or newer (1.26 recommended) and Python 3.10 or newer. Electron desktop work also needs Node.js 22.12 or newer; run `npm ci` to install the exact dependencies recorded in `package-lock.json`. To check a clean source checkout:

```sh
go test ./...
```

For a release build, prepare the locked runtimes and LUT files as described in
`README.md`, then run `python3 packaging/build.py [target ...]`. Release builds
use the `bundled` Go build tag; ordinary tests do not need those payloads.
Targets are `darwin-arm64`, `darwin-amd64`, and `windows-amd64`.

For Electron development, prepare the target runtime and LUT files, then run `npm run build:engine` followed by `npm start`. Build desktop archives with `npm run build:desktop -- [target ...]`; omitting targets selects the native architecture. Electron archives and generated sidecars are written to ignored `dist/electron/` and `desktop/.generated/`. See `docs/ELECTRON.zh-CN.md` for target prerequisites and package contents.

Run `gofmt` on changed Go files. Keep source documentation free of local paths,
sample-media details, and machine-specific validation output. Do not add LUT
payloads, runtime downloads, caches, or generated `dist/` files to Git.
