// Package bundle extracts the platform tools and official LUTs from the executable.
package bundle

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"dji-lut-app/assets"
)

type Paths struct{ FFmpeg, FFprobe, LUTDir, ManifestPath string }
type inventory map[string]string

// Prepare verifies an existing content-addressed cache, or extracts a fresh one.
// It never requires FFmpeg, Python or Go on the destination computer.
func Prepare() (Paths, error) {
	if len(runtimeArchive) == 0 {
		return Paths{}, fmt.Errorf("unsupported platform: %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	h := sha256.New()
	h.Write(runtimeArchive)
	err := walkAssets(func(path string, data []byte) error {
		h.Write([]byte(path))
		h.Write(data)
		return nil
	})
	if err != nil {
		return Paths{}, err
	}
	key := hex.EncodeToString(h.Sum(nil))[:24]
	cache, err := os.UserCacheDir()
	if err != nil {
		return Paths{}, err
	}
	parent := filepath.Join(cache, "DJILUTApp", "bundles")
	root := filepath.Join(parent, runtime.GOOS+"-"+runtime.GOARCH+"-"+key)
	if err = verify(root); err == nil {
		return paths(root), nil
	}
	if err = os.MkdirAll(parent, 0700); err != nil {
		return Paths{}, err
	}
	tmp, err := os.MkdirTemp(parent, ".extract-")
	if err != nil {
		return Paths{}, err
	}
	defer os.RemoveAll(tmp)
	if err = unpack(runtimeArchive, tmp); err != nil {
		return Paths{}, err
	}
	err = walkAssets(func(path string, data []byte) error {
		dst := filepath.Join(tmp, "assets", filepath.FromSlash(path))
		if err = os.MkdirAll(filepath.Dir(dst), 0700); err != nil {
			return err
		}
		return os.WriteFile(dst, data, 0600)
	})
	if err != nil {
		return Paths{}, err
	}
	inv := inventory{}
	err = filepath.WalkDir(tmp, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(tmp, path)
		if err != nil {
			return err
		}
		sum, err := hashFile(path)
		if err != nil {
			return err
		}
		inv[filepath.ToSlash(rel)] = sum
		return nil
	})
	if err != nil {
		return Paths{}, err
	}
	b, err := json.Marshal(inv)
	if err != nil {
		return Paths{}, err
	}
	if err = os.WriteFile(filepath.Join(tmp, "inventory.json"), b, 0600); err != nil {
		return Paths{}, err
	}
	if err = verify(tmp); err != nil {
		return Paths{}, err
	}
	if err = os.Rename(tmp, root); err != nil {
		// Another launcher may have completed extraction while we were working.
		if verify(root) != nil {
			// Replace only this application's damaged content-addressed cache.
			if e := os.RemoveAll(root); e != nil {
				return Paths{}, e
			}
			if e := os.Rename(tmp, root); e != nil {
				return Paths{}, e
			}
		}
	}
	return paths(root), nil
}

func walkAssets(fn func(path string, data []byte) error) error {
	filesystems := []fs.FS{assets.FS}
	if assets.LUTFS != nil {
		filesystems = append(filesystems, assets.LUTFS)
	}
	for _, filesystem := range filesystems {
		if err := fs.WalkDir(filesystem, ".", func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() {
				return nil
			}
			data, err := fs.ReadFile(filesystem, path)
			if err != nil {
				return err
			}
			return fn(path, data)
		}); err != nil {
			return err
		}
	}
	return nil
}

func paths(root string) Paths {
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	return Paths{FFmpeg: filepath.Join(root, "bin", "ffmpeg"+ext), FFprobe: filepath.Join(root, "bin", "ffprobe"+ext), LUTDir: filepath.Join(root, "assets", "luts"), ManifestPath: filepath.Join(root, "assets", "catalog.json")}
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func verify(root string) error {
	b, err := os.ReadFile(filepath.Join(root, "inventory.json"))
	if err != nil {
		return err
	}
	inv := inventory{}
	if err = json.Unmarshal(b, &inv); err != nil {
		return err
	}
	if len(inv) < 5 {
		return fmt.Errorf("incomplete bundle")
	}
	for rel, want := range inv {
		p, err := safePath(root, rel)
		if err != nil {
			return err
		}
		st, err := os.Lstat(p)
		if err != nil || !st.Mode().IsRegular() {
			return fmt.Errorf("missing bundle file %s", rel)
		}
		got, err := hashFile(p)
		if err != nil || got != want {
			return fmt.Errorf("bundle checksum mismatch: %s", rel)
		}
	}
	p := paths(root)
	for _, f := range []string{p.FFmpeg, p.FFprobe, p.ManifestPath} {
		if _, err = os.Stat(f); err != nil {
			return err
		}
	}
	return nil
}

func safePath(root, rel string) (string, error) {
	clean := filepath.Clean(filepath.FromSlash(rel))
	if rel == "" || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || strings.Contains(rel, "\\") || strings.Contains(rel, ":") {
		return "", fmt.Errorf("unsafe archive path %q", rel)
	}
	return filepath.Join(root, clean), nil
}

func unpack(data []byte, root string) error {
	z, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return err
	}
	defer z.Close()
	tr := tar.NewReader(z)
	for {
		header, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		dst, err := safePath(root, header.Name)
		if err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err = os.MkdirAll(dst, 0700); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if header.Size > 512<<20 {
				return fmt.Errorf("runtime file too large")
			}
			if err = os.MkdirAll(filepath.Dir(dst), 0700); err != nil {
				return err
			}
			mode := os.FileMode(0600)
			if header.Mode&0111 != 0 {
				mode = 0700
			}
			f, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(f, tr)
			closeErr := f.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
		default:
			return fmt.Errorf("unsupported runtime archive entry: %s", header.Name)
		}
	}
}
