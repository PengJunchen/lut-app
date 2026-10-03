//go:build bundled && windows && amd64

package bundle

import _ "embed"

//go:embed runtimes/windows-amd64.tgz
var runtimeArchive []byte
