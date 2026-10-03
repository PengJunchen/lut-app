package engine

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type catalogEnvelope struct {
	Version int       `json:"version"`
	Entries []LUTSpec `json:"entries"`
	LUTs    []LUTSpec `json:"luts"`
}

var builtinCatalog = []LUTSpec{
	{Camera: "pocket4p", Profile: "dlog", Look: LookStandard, File: "DJI OSMO Pocket 4P D-Log to Rec.709 V2.0 size33.cube", SHA256: "04757dd8dd669d60a2d58ea1834f185616ca9952922c168fe69dba29bb2be1b1", Grid: 33},
	{Camera: "pocket4p", Profile: "dlog", Look: LookVivid, File: "DJI OSMO Pocket 4P D-Log to Rec.709 vivid V2.0 size33.cube", SHA256: "95afff501afd0343c3c1a5f1cf7bc34c8d5ed5765474444b58e9db8a8b7e58fb", Grid: 33},
	{Camera: "pocket4p", Profile: "dlog2", Look: LookStandard, File: "DJI OSMO Pocket 4P D-Log2 to Rec.709 V1.0 size65.cube", SHA256: "fa6537da3235c281da6e361806d3e9ee93f5532ad95471878c5d6c05157caa9c", Grid: 65},
	{Camera: "pocket4p", Profile: "dlog2", Look: LookVivid, File: "DJI OSMO Pocket 4P D-Log2 to Rec.709 vivid V1.0 size65.cube", SHA256: "32b9b49d52fde38f95cbc1d0a4f486fcbf176eb82d28481b25d4f9a0b006734e", Grid: 65},
}

// LoadCatalog reads an app catalog, or returns the four verified Pocket 4P
// defaults when manifestPath is empty. Catalog JSON can be a bare entry array
// or an object containing "entries" (preferred) or "luts".
func LoadCatalog(manifestPath, lutDir string) ([]LUTSpec, error) {
	if strings.TrimSpace(lutDir) == "" {
		lutDir = "luts"
	}
	lutDirAbs, err := filepath.Abs(filepath.Clean(lutDir))
	if err != nil {
		return nil, fmt.Errorf("resolve LUT directory: %w", err)
	}
	var entries []LUTSpec
	manifestDir := ""
	if strings.TrimSpace(manifestPath) == "" {
		entries = append([]LUTSpec(nil), builtinCatalog...)
	} else {
		manifestAbs, absErr := filepath.Abs(filepath.Clean(manifestPath))
		if absErr != nil {
			return nil, fmt.Errorf("resolve manifest path: %w", absErr)
		}
		f, openErr := os.Open(manifestAbs)
		if openErr != nil {
			return nil, fmt.Errorf("open LUT manifest: %w", openErr)
		}
		data, readErr := io.ReadAll(f)
		closeErr := f.Close()
		if readErr != nil {
			return nil, fmt.Errorf("read LUT manifest: %w", readErr)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("close LUT manifest: %w", closeErr)
		}
		entries, err = parseCatalog(data)
		if err != nil {
			return nil, fmt.Errorf("parse LUT manifest: %w", err)
		}
		manifestDir = filepath.Dir(manifestAbs)
	}
	return normalizeCatalog(entries, lutDirAbs, manifestDir)
}

func normalizeCatalog(entries []LUTSpec, lutDir, manifestDir string) ([]LUTSpec, error) {
	seen := make(map[string]bool, len(entries))
	for i := range entries {
		entry := &entries[i]
		entry.Camera = strings.TrimSpace(strings.ToLower(entry.Camera))
		entry.Profile = normalizeProfile(entry.Profile)
		entry.Look = Look(strings.ToLower(strings.TrimSpace(string(entry.Look))))
		entry.File = strings.TrimSpace(entry.File)
		entry.SHA256 = strings.ToLower(strings.TrimSpace(entry.SHA256))
		if entry.Camera == "" || entry.Profile == "" || entry.File == "" || entry.SHA256 == "" {
			return nil, fmt.Errorf("catalog entry %d requires camera, profile, file, and sha256", i)
		}
		if entry.Look != LookStandard && entry.Look != LookVivid {
			return nil, fmt.Errorf("catalog entry %d has unsupported look %q", i, entry.Look)
		}
		if entry.Profile != "dlog" && entry.Profile != "dlog2" && entry.Profile != "dlogm" {
			return nil, fmt.Errorf("catalog entry %d has unsupported profile %q", i, entry.Profile)
		}
		if entry.Grid < 2 {
			return nil, fmt.Errorf("catalog entry %d grid must be at least 2", i)
		}
		if len(entry.SHA256) != sha256.Size*2 {
			return nil, fmt.Errorf("catalog entry %d sha256 must be a 64-character hexadecimal digest", i)
		}
		if _, decodeErr := hex.DecodeString(entry.SHA256); decodeErr != nil {
			return nil, fmt.Errorf("catalog entry %d has an invalid sha256: %w", i, decodeErr)
		}
		key := entry.Camera + "\x00" + entry.Profile + "\x00" + string(entry.Look)
		if seen[key] {
			return nil, fmt.Errorf("catalog has duplicate mapping for camera=%s profile=%s look=%s", entry.Camera, entry.Profile, entry.Look)
		}
		seen[key] = true
		entry.File = resolveCatalogFile(entry.File, lutDir, manifestDir)
	}
	return entries, nil
}

func parseCatalog(data []byte) ([]LUTSpec, error) {
	var bare []LUTSpec
	if err := json.Unmarshal(data, &bare); err == nil && bare != nil {
		return bare, nil
	}
	var envelope catalogEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, err
	}
	if envelope.Entries != nil {
		return envelope.Entries, nil
	}
	if envelope.LUTs != nil {
		return envelope.LUTs, nil
	}
	return nil, errors.New("manifest must be an array or contain an entries/luts array")
}

func resolveCatalogFile(file, lutDir, manifestDir string) string {
	if filepath.IsAbs(file) {
		return filepath.Clean(file)
	}
	file = filepath.FromSlash(file)
	candidates := []string{filepath.Join(lutDir, file)}
	if manifestDir != "" {
		candidates = append(candidates, filepath.Join(manifestDir, file))
	} else if strings.EqualFold(filepath.Base(lutDir), "luts") && strings.EqualFold(filepath.Base(filepath.Dir(file)), "luts") {
		candidates = append(candidates, filepath.Join(filepath.Dir(lutDir), file))
	}
	for _, candidate := range candidates {
		if st, err := os.Stat(candidate); err == nil && st.Mode().IsRegular() {
			return filepath.Clean(candidate)
		}
	}
	return filepath.Clean(candidates[0])
}

func verifyCube(path string, expectedGrid int, expectedHash string) (int, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, "", fmt.Errorf("cannot open LUT %q: %w", path, err)
	}
	defer f.Close()
	h := sha256.New()
	scanner := bufio.NewScanner(io.TeeReader(f, h))
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	grid := 0
	rows := 0
	for scanner.Scan() {
		line := strings.TrimSpace(strings.TrimPrefix(scanner.Text(), "\ufeff"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		directive := strings.ToUpper(fields[0])
		switch directive {
		case "LUT_3D_SIZE":
			if grid != 0 || len(fields) != 2 {
				return 0, "", errors.New("LUT has an invalid or repeated LUT_3D_SIZE header")
			}
			if _, err := fmt.Sscanf(fields[1], "%d", &grid); err != nil || grid < 2 || grid > 512 {
				return 0, "", errors.New("LUT_3D_SIZE must be an integer of at least 2")
			}
		case "LUT_1D_SIZE":
			return 0, "", errors.New("1D+3D LUT files are not supported")
		case "TITLE", "DOMAIN_MIN", "DOMAIN_MAX":
			continue
		default:
			if len(fields) != 3 {
				return 0, "", fmt.Errorf("unrecognized LUT directive or malformed row %q", truncate(line, 80))
			}
			for _, field := range fields {
				value, err := strconv.ParseFloat(field, 64)
				if err != nil || value != value || value > 1e100 || value < -1e100 {
					return 0, "", errors.New("LUT rows must contain three finite numbers")
				}
			}
			rows++
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, "", fmt.Errorf("read LUT: %w", err)
	}
	if grid == 0 {
		return 0, "", errors.New("LUT is missing LUT_3D_SIZE")
	}
	if rows != grid*grid*grid {
		return 0, "", fmt.Errorf("LUT has %d rows; grid size %d requires %d", rows, grid, grid*grid*grid)
	}
	digest := hex.EncodeToString(h.Sum(nil))
	if expectedGrid > 0 && grid != expectedGrid {
		return grid, digest, fmt.Errorf("LUT grid is %d; manifest expects %d", grid, expectedGrid)
	}
	if expectedHash != "" && !strings.EqualFold(digest, expectedHash) {
		return grid, digest, errors.New("LUT SHA256 differs from the manifest")
	}
	return grid, digest, nil
}

func truncate(value string, n int) string {
	if len(value) <= n {
		return value
	}
	return value[:n]
}
