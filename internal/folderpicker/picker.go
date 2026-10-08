// Package folderpicker provides a small native folder picker for the desktop UI.
package folderpicker

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const cancelledSentinel = "DJI_LUT_FOLDER_PICKER_CANCELLED"

type languageContextKey struct{}

// WithLanguage chooses the native dialog prompt without putting caller data
// into either platform's fixed script. Unknown values use the Chinese prompt.
func WithLanguage(ctx context.Context, language string) context.Context {
	if language != "en" {
		language = "zh-CN"
	}
	return context.WithValue(ctx, languageContextKey{}, language)
}

func dialogPrompt(ctx context.Context) string {
	if ctx.Value(languageContextKey{}) == "en" {
		return "Choose a folder"
	}
	return "选择文件夹"
}

// Picker opens an operating-system folder selection dialog.
type Picker interface {
	Select(context.Context, string) (path string, cancelled bool, err error)
}

// Native is the operating-system backed folder picker.
type Native struct{}

// New returns the native picker for the current operating system.
func New() Picker { return Native{} }

// ResolveStartDirectory returns an existing directory to use as a dialog's
// starting point. If the requested path is missing or is a file, it walks up
// to the nearest existing parent. An empty path falls back to the current
// working directory.
func ResolveStartDirectory(requested string) (string, error) {
	if requested == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return "", fmt.Errorf("read current directory: %w", err)
		}
		requested = cwd
	}
	abs, err := filepath.Abs(requested)
	if err != nil {
		return "", fmt.Errorf("resolve start path: %w", err)
	}
	for candidate := filepath.Clean(abs); ; candidate = filepath.Dir(candidate) {
		info, statErr := os.Stat(candidate)
		if statErr == nil && info.IsDir() {
			return candidate, nil
		}
		parent := filepath.Dir(candidate)
		if parent == candidate {
			if statErr != nil {
				return "", fmt.Errorf("find existing parent for %q: %w", requested, statErr)
			}
			return "", fmt.Errorf("find existing parent for %q", requested)
		}
	}
}

func withEnvironmentValue(env []string, key, value string) []string {
	prefix := strings.ToUpper(key) + "="
	result := make([]string, 0, len(env)+1)
	for _, item := range env {
		if !strings.HasPrefix(strings.ToUpper(item), prefix) {
			result = append(result, item)
		}
	}
	return append(result, key+"="+value)
}

// trimProcessLineEnding removes only the line ending written by the picker
// script. It preserves spaces that are valid parts of a directory name.
func trimProcessLineEnding(value string) string {
	value = strings.TrimSuffix(value, "\n")
	return strings.TrimSuffix(value, "\r")
}
