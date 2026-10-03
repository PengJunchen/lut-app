//go:build !darwin && !windows

package folderpicker

import (
	"context"
	"errors"
)

func (Native) Select(context.Context, string) (string, bool, error) {
	return "", false, errors.New("native folder selection is supported on macOS and Windows")
}
