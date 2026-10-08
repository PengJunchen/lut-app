//go:build windows

package folderpicker

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf16"
)

const initialPathEnvironmentKey = "DJI_LUT_FOLDER_PICKER_INITIAL_DIR"
const promptEnvironmentKey = "DJI_LUT_FOLDER_PICKER_PROMPT"

// This fixed script receives the initial path and whitelisted prompt through
// environment values rather than generated script source.
// Its output is explicitly UTF-8 so Unicode paths round-trip through Go.
const powerShellScript = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
try {
  $dialog.Description = [Environment]::GetEnvironmentVariable('DJI_LUT_FOLDER_PICKER_PROMPT')
  $dialog.ShowNewFolderButton = $true
  $initial = [Environment]::GetEnvironmentVariable('DJI_LUT_FOLDER_PICKER_INITIAL_DIR')
  if (-not [string]::IsNullOrWhiteSpace($initial) -and [System.IO.Directory]::Exists($initial)) {
    $dialog.SelectedPath = $initial
  }
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.WriteLine($dialog.SelectedPath)
  } else {
    [Console]::Out.WriteLine('DJI_LUT_FOLDER_PICKER_CANCELLED')
  }
} finally {
  $dialog.Dispose()
}`

func (Native) Select(ctx context.Context, initial string) (string, bool, error) {
	start, err := ResolveStartDirectory(initial)
	if err != nil {
		return "", false, err
	}
	systemRoot := os.Getenv("SystemRoot")
	if systemRoot == "" {
		systemRoot = os.Getenv("windir")
	}
	if systemRoot == "" {
		return "", false, fmt.Errorf("SystemRoot is not set")
	}
	powershell := filepath.Join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	command := exec.CommandContext(ctx, powershell,
		"-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden",
		"-EncodedCommand", encodePowerShell(powerShellScript),
	)
	command.Env = withEnvironmentValue(os.Environ(), initialPathEnvironmentKey, start)
	command.Env = withEnvironmentValue(command.Env, promptEnvironmentKey, dialogPrompt(ctx))
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); ctx.Err() != nil {
		return "", true, nil
	} else if err != nil {
		return "", false, fmt.Errorf("PowerShell folder dialog: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	selected := trimProcessLineEnding(stdout.String())
	if selected == cancelledSentinel {
		return "", true, nil
	}
	if selected == "" {
		return "", false, fmt.Errorf("PowerShell returned an empty folder path")
	}
	return selected, false, nil
}

func encodePowerShell(script string) string {
	encoded := utf16.Encode([]rune(script))
	var bytesLE bytes.Buffer
	for _, codeUnit := range encoded {
		_ = binary.Write(&bytesLE, binary.LittleEndian, codeUnit)
	}
	return base64.StdEncoding.EncodeToString(bytesLE.Bytes())
}
