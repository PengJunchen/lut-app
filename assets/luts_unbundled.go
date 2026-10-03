//go:build !bundled

package assets

import "io/fs"

// LUTFS is populated only for release builds. Keeping it nil allows source
// tests to run without acquiring third-party LUT payloads.
var LUTFS fs.FS
