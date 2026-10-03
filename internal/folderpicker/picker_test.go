package folderpicker

import (
	"os"
	"path/filepath"
	"testing"
)

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
