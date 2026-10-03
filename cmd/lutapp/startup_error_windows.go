//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

func showStartupError(title, message string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	messageBox := user32.NewProc("MessageBoxW")
	caption, err1 := syscall.UTF16PtrFromString(title)
	text, err2 := syscall.UTF16PtrFromString(message)
	if err1 != nil || err2 != nil {
		return
	}
	const mbOK = 0x00000000
	const mbIconError = 0x00000010
	const mbSetForeground = 0x00010000
	_, _, _ = messageBox.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(caption)), mbOK|mbIconError|mbSetForeground)
}
