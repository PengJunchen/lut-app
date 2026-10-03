package assets

import "embed"

// FS contains the public LUT catalog and its source notes. LUT payloads are
// embedded only by release builds using the bundled build tag.
//
//go:embed catalog.json SOURCES.md
var FS embed.FS
