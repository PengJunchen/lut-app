//go:build bundled && darwin && arm64

package bundle

import _ "embed"

//go:embed runtimes/darwin-arm64.tgz
var runtimeArchive []byte
