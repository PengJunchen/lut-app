# Contributing

The tracked repository contains application source and dependency metadata.
Acquired FFmpeg binaries, runtime archives, build products, and DJI `.cube`
files stay local and are excluded by `.gitignore`.

Use Go 1.24 or newer (1.26 recommended) and Python 3.10 or newer. To check a clean source checkout:

```sh
go test ./...
```

For a release build, prepare the locked runtimes and LUT files as described in
`README.md`, then run `python3 packaging/build.py [target ...]`. Release builds
use the `bundled` Go build tag; ordinary tests do not need those payloads.
Targets are `darwin-arm64`, `darwin-amd64`, and `windows-amd64`.

Run `gofmt` on changed Go files. Keep source documentation free of local paths,
sample-media details, and machine-specific validation output. Do not add LUT
payloads, runtime downloads, caches, or generated `dist/` files to Git.
