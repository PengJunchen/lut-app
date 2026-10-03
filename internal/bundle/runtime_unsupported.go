//go:build bundled && ((!darwin && !windows) || (darwin && !amd64 && !arm64) || (windows && !amd64))

package bundle

var runtimeArchive []byte
