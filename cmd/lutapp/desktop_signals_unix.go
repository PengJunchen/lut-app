//go:build !windows

package main

import (
	"os"
	"syscall"
)

func desktopTerminationSignals() []os.Signal {
	return []os.Signal{os.Interrupt, syscall.SIGTERM}
}
