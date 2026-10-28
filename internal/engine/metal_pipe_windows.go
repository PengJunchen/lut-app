//go:build windows

package engine

import "os"

func metalFramePipe() (*os.File, *os.File, error) { return os.Pipe() }
