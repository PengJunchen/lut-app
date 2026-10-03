//go:build darwin

package folderpicker

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
)

// The AppleScript is fixed; the starting path is passed as an argv value so
// quotes and other path characters can never become script source.
const appleScript = `on run argv
  set startFolder to POSIX file (item 1 of argv)
  try
    set selectedFolder to choose folder with prompt "选择文件夹" default location startFolder
  on error errorMessage number errorNumber
    if errorNumber is -128 then return "DJI_LUT_FOLDER_PICKER_CANCELLED"
    error errorMessage number errorNumber
  end try
  return POSIX path of selectedFolder
end run`

func (Native) Select(ctx context.Context, initial string) (string, bool, error) {
	start, err := ResolveStartDirectory(initial)
	if err != nil {
		return "", false, err
	}
	command := exec.CommandContext(ctx, "/usr/bin/osascript", "-e", appleScript, start)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	output, err := command.Output()
	if ctx.Err() != nil {
		return "", true, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("osascript: %w: %s", err, stderr.String())
	}
	selected := trimProcessLineEnding(string(output))
	if selected == cancelledSentinel {
		return "", true, nil
	}
	if selected == "" {
		return "", false, fmt.Errorf("osascript returned an empty folder path")
	}
	return selected, false, nil
}
