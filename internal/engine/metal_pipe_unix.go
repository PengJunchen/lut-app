//go:build !windows

package engine

import (
	"os"
	"syscall"
)

// Large RGB frames otherwise spend much of their time traversing macOS's
// small anonymous pipe buffers. Local sockets permit larger bounded buffers;
// children still receive ordinary stdin/stdout file descriptors.
func metalFramePipe() (*os.File, *os.File, error) {
	pair, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		return os.Pipe()
	}
	for _, fd := range pair {
		syscall.CloseOnExec(fd)
		_ = syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_SNDBUF, 1<<20)
		_ = syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_RCVBUF, 1<<20)
	}
	return os.NewFile(uintptr(pair[0]), "metal-read"), os.NewFile(uintptr(pair[1]), "metal-write"), nil
}
