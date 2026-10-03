//go:build bundled

package assets

import (
	"embed"
	"io/fs"
)

//go:embed luts/*.cube
var lutFiles embed.FS

// LUTFS is nil in ordinary development/test builds. Release builds embed the
// locally prepared LUT files after their hashes have been checked.
var LUTFS fs.FS = lutFiles
