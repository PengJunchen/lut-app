//go:build bundled

package assets

import (
	"embed"
	"io/fs"
)

//go:embed all:luts
var lutFiles embed.FS

// LUTFS is nil in ordinary development/test builds. Release builds embed the
// complete, verified library payload tree, including formats not used by the
// automatic Rec.709 catalog.
var LUTFS fs.FS = lutFiles
