//go:build bundled && darwin && amd64

package bundle

import _ "embed"

//go:embed runtimes/darwin-amd64.tgz
var runtimeArchive []byte
