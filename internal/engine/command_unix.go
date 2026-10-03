//go:build !windows

package engine

import (
	"context"
	"os/exec"
)

func newCommandContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, name, args...)
}
