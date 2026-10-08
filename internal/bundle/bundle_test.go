package bundle

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func testArchive(t *testing.T, name string, kind byte) []byte {
	t.Helper()
	var b bytes.Buffer
	z := gzip.NewWriter(&b)
	tarWriter := tar.NewWriter(z)
	h := &tar.Header{Name: name, Mode: 0755, Typeflag: kind}
	if kind == tar.TypeReg {
		h.Size = 4
	} else if kind == tar.TypeSymlink {
		h.Linkname = "../../outside"
	}
	if err := tarWriter.WriteHeader(h); err != nil {
		t.Fatal(err)
	}
	if kind == tar.TypeReg {
		_, _ = tarWriter.Write([]byte("test"))
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestRuntimeArchiveRejectsEscapeAndSymlinks(t *testing.T) {
	for _, c := range []struct {
		name string
		kind byte
	}{
		{"../outside", tar.TypeReg},
		{"folder/../../outside", tar.TypeReg},
		{"/absolute", tar.TypeReg},
		{"//server/share", tar.TypeReg},
		{"C:/outside", tar.TypeReg},
		{"C:\\outside", tar.TypeReg},
		{"\\\\server\\share", tar.TypeReg},
		{"bin\\outside", tar.TypeReg},
		{"bin/tool", tar.TypeSymlink},
	} {
		t.Run(c.name, func(t *testing.T) {
			if err := unpack(testArchive(t, c.name, c.kind), t.TempDir()); err == nil {
				t.Fatal("unsafe archive accepted")
			}
		})
	}
}

func TestRuntimeExtractsExecutable(t *testing.T) {
	root := t.TempDir()
	if err := unpack(testArchive(t, "bin/tool", tar.TypeReg), root); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(root, "bin", "tool"))
	if err != nil || string(b) != "test" {
		t.Fatalf("incorrect extraction: %q %v", b, err)
	}
	st, err := os.Stat(filepath.Join(root, "bin", "tool"))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && st.Mode()&0100 == 0 {
		t.Fatal("executable bit lost")
	}
}
