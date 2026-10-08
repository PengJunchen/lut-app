package folderpicker

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestDialogLanguageUsesOnlyWhitelistedPromptsAndPreservesCancellation(t *testing.T) {
	for _, test := range []struct{ language, prompt string }{
		{"en", "Choose a folder"},
		{"zh-CN", "选择文件夹"},
		{"", "选择文件夹"},
		{"arbitrary caller text", "选择文件夹"},
	} {
		t.Run(test.language, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			localized := WithLanguage(ctx, test.language)
			if got := dialogPrompt(localized); got != test.prompt {
				t.Fatalf("dialog prompt = %q, want %q", got, test.prompt)
			}
			cancel()
			if localized.Err() != context.Canceled {
				t.Fatal("language context did not preserve cancellation")
			}
		})
	}
}

func TestTrimProcessLineEndingPreservesDirectorySpaces(t *testing.T) {
	for _, lineEnding := range []string{"\n", "\r\n"} {
		got := trimProcessLineEnding("/tmp/所选目录  " + lineEnding)
		if want := "/tmp/所选目录  "; got != want {
			t.Errorf("trimProcessLineEnding() = %q, want %q", got, want)
		}
	}
}

func TestResolveStartDirectoryFallsBackToExistingParent(t *testing.T) {
	parent := t.TempDir()
	requested := filepath.Join(parent, "removed", "nested")
	got, err := ResolveStartDirectory(requested)
	if err != nil {
		t.Fatal(err)
	}
	if got != parent {
		t.Fatalf("ResolveStartDirectory() = %q, want existing parent %q", got, parent)
	}

	file := filepath.Join(parent, "file")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err = ResolveStartDirectory(file)
	if err != nil {
		t.Fatal(err)
	}
	if got != parent {
		t.Fatalf("ResolveStartDirectory(file) = %q, want parent directory %q", got, parent)
	}
}
