//go:build darwin

package main

import "os/exec"

func showStartupError(title, message string) {
	const script = `on run argv
display alert (item 1 of argv) message (item 2 of argv) as critical buttons {"OK"} default button "OK"
end run`
	_ = exec.Command("/usr/bin/osascript", "-e", script, title, message).Run()
}
