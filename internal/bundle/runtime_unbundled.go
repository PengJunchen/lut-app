//go:build !bundled

package bundle

// Source tests and ordinary builds do not require platform runtime archives.
var runtimeArchive []byte
