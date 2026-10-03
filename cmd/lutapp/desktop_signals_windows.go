//go:build windows

package main

import "os"

func desktopTerminationSignals() []os.Signal {
	return []os.Signal{os.Interrupt}
}
