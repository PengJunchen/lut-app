package engine

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	lutFormatCube3D = ".cube"
	outputRec709    = "rec709"
	purposeRestore  = "restore"
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

// LoadCatalog reads an automatic-application catalog, or returns the four
// verified Pocket 4P defaults when manifestPath is empty. Catalog JSON can be
// a bare entry array or an object containing "entries" (preferred) or "luts".
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
	for i := range entries {
		entry := &entries[i]
		entry.Camera = strings.TrimSpace(strings.ToLower(entry.Camera))
		entry.Profile = normalizeProfile(entry.Profile)
		entry.Look = Look(strings.ToLower(strings.TrimSpace(string(entry.Look))))
		entry.File = strings.TrimSpace(entry.File)
		entry.SHA256 = strings.ToLower(strings.TrimSpace(entry.SHA256))
		entry.Version = strings.TrimSpace(entry.Version)
		entry.Name = strings.TrimSpace(entry.Name)
		entry.LibraryID = strings.TrimSpace(entry.LibraryID)
		if entry.Camera == "" || entry.Profile == "" || entry.File == "" || entry.SHA256 == "" {
			return nil, fmt.Errorf("catalog entry %d requires camera, profile, file, and sha256", i)
		}
		if entry.Look != LookStandard && entry.Look != LookVivid {
			return nil, fmt.Errorf("catalog entry %d has unsupported look %q", i, entry.Look)
		}
		if entry.Profile != "dlog" && entry.Profile != "dlog2" && entry.Profile != "dlogm" {
			return nil, fmt.Errorf("catalog entry %d has unsupported profile %q", i, entry.Profile)
		}
		if entry.OutputColorSpace == "" {
			entry.OutputColorSpace = outputRec709
		} else if output := normalizeOutputColorSpace(entry.OutputColorSpace); output != outputRec709 {
			return nil, fmt.Errorf("catalog entry %d has unsupported automatic output color space %q; only Rec.709 restore LUTs are automatic", i, entry.OutputColorSpace)
		} else {
			entry.OutputColorSpace = output
		}
		if entry.Purpose == "" {
			entry.Purpose = purposeRestore
		} else {
			entry.Purpose = strings.ToLower(strings.TrimSpace(entry.Purpose))
			if entry.Purpose != purposeRestore {
				return nil, fmt.Errorf("catalog entry %d has unsupported automatic LUT purpose %q; only restore LUTs are automatic", i, entry.Purpose)
			}
		}
		if entry.Format == "" {
			entry.Format = lutFormatCube3D
		} else {
			switch strings.ToLower(strings.TrimSpace(entry.Format)) {
			case "cube", ".cube", "cube3d", "3d-cube":
				entry.Format = lutFormatCube3D
			default:
				return nil, fmt.Errorf("catalog entry %d has unsupported automatic LUT format %q; only 3D .cube is automatic", i, entry.Format)
			}
		}
		if entry.Version != "" {
			if _, err := parseNumericVersion(entry.Version); err != nil {
				return nil, fmt.Errorf("catalog entry %d has invalid numeric version %q: %w", i, entry.Version, err)
			}
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
		entry.File = resolveCatalogFile(entry.File, lutDir, manifestDir)
		if !strings.EqualFold(filepath.Ext(entry.File), lutFormatCube3D) {
			return nil, fmt.Errorf("catalog entry %d declares automatic 3D .cube but file extension is %q", i, filepath.Ext(entry.File))
		}
	}
	return latestCatalogEntries(entries)
}

func normalizeOutputColorSpace(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.NewReplacer(" ", "", "-", "", "_", "", ".", "").Replace(value)
	switch value {
	case "rec709", "bt709", "iturbt709", "iturbt7096":
		return outputRec709
	default:
		return ""
	}
}

// parseNumericVersion accepts dotted integers with an optional V prefix. It
// returns components without leading zeroes for stable numeric comparison.
func parseNumericVersion(value string) ([]string, error) {
	value = strings.TrimSpace(value)
	if len(value) > 0 && (value[0] == 'v' || value[0] == 'V') {
		value = value[1:]
	}
	if value == "" {
		return nil, errors.New("version is empty")
	}
	parts := strings.Split(value, ".")
	for i, part := range parts {
		if part == "" {
			return nil, errors.New("version components must be non-empty integers")
		}
		for _, digit := range part {
			if digit < '0' || digit > '9' {
				return nil, errors.New("version components must be non-negative integers")
			}
		}
		parts[i] = strings.TrimLeft(part, "0")
		if parts[i] == "" {
			parts[i] = "0"
		}
	}
	return parts, nil
}

func normalizedVersionKey(value string) string {
	if value == "" {
		return "legacy"
	}
	parts, _ := parseNumericVersion(value)
	for len(parts) > 1 && parts[len(parts)-1] == "0" {
		parts = parts[:len(parts)-1]
	}
	return strings.Join(parts, ".")
}

func compareNumericVersions(a, b string) int {
	if a == "" {
		if b == "" {
			return 0
		}
		return -1
	}
	if b == "" {
		return 1
	}
	left, _ := parseNumericVersion(a)
	right, _ := parseNumericVersion(b)
	length := max(len(left), len(right))
	for i := 0; i < length; i++ {
		l, r := "0", "0"
		if i < len(left) {
			l = left[i]
		}
		if i < len(right) {
			r = right[i]
		}
		if len(l) < len(r) {
			return -1
		}
		if len(l) > len(r) {
			return 1
		}
		if l < r {
			return -1
		}
		if l > r {
			return 1
		}
	}
	return 0
}

func latestCatalogEntries(entries []LUTSpec) ([]LUTSpec, error) {
	groups := make(map[string][]LUTSpec, len(entries))
	for _, entry := range entries {
		key := catalogKey(entry.Camera, entry.Profile, entry.Look, entry.OutputColorSpace, entry.Purpose)
		groups[key] = append(groups[key], entry)
	}

	selected := make([]LUTSpec, 0, len(groups))
	keys := make([]string, 0, len(groups))
	for key := range groups {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		candidates := groups[key]
		hashesByVersion := make(map[string]string, len(candidates))
		latest := candidates[0]
		for _, candidate := range candidates {
			versionKey := normalizedVersionKey(candidate.Version)
			if hash, exists := hashesByVersion[versionKey]; exists && hash != candidate.SHA256 {
				return nil, fmt.Errorf("catalog has ambiguous LUTs at version %q for camera=%s profile=%s look=%s output=%s purpose=%s", candidate.Version, candidate.Camera, candidate.Profile, candidate.Look, candidate.OutputColorSpace, candidate.Purpose)
			}
			hashesByVersion[versionKey] = candidate.SHA256
			comparison := compareNumericVersions(candidate.Version, latest.Version)
			if comparison > 0 || (comparison == 0 && catalogEntryLess(candidate, latest)) {
				latest = candidate
			}
		}
		selected = append(selected, latest)
	}
	return selected, nil
}

func catalogEntryLess(a, b LUTSpec) bool {
	if a.Name != b.Name {
		return a.Name < b.Name
	}
	if a.File != b.File {
		return a.File < b.File
	}
	return a.LibraryID < b.LibraryID
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
	hasInputRange := false
	hasDomainMin := false
	hasDomainMax := false
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
		case "LUT_3D_INPUT_RANGE":
			if hasInputRange || len(fields) != 3 {
				return 0, "", errors.New("LUT has an invalid or repeated LUT_3D_INPUT_RANGE header")
			}
			minimum, minErr := parseCubeFiniteFloat(fields[1])
			maximum, maxErr := parseCubeFiniteFloat(fields[2])
			if minErr != nil || maxErr != nil || minimum >= maximum {
				return 0, "", errors.New("LUT_3D_INPUT_RANGE must contain two finite values with minimum less than maximum")
			}
			hasInputRange = true
		case "TITLE":
			continue
		case "DOMAIN_MIN", "DOMAIN_MAX":
			if len(fields) != 4 {
				return 0, "", fmt.Errorf("LUT %s must contain three finite values", directive)
			}
			for _, field := range fields[1:] {
				if _, err := parseCubeFiniteFloat(field); err != nil {
					return 0, "", fmt.Errorf("LUT %s must contain three finite values", directive)
				}
			}
			if directive == "DOMAIN_MIN" {
				if hasDomainMin {
					return 0, "", errors.New("LUT has a repeated DOMAIN_MIN header")
				}
				hasDomainMin = true
			} else {
				if hasDomainMax {
					return 0, "", errors.New("LUT has a repeated DOMAIN_MAX header")
				}
				hasDomainMax = true
			}
		default:
			if len(fields) != 3 {
				return 0, "", fmt.Errorf("unrecognized LUT directive or malformed row %q", truncate(line, 80))
			}
			for _, field := range fields {
				if _, err := parseCubeFiniteFloat(field); err != nil {
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
	if hasInputRange && (hasDomainMin || hasDomainMax) {
		return 0, "", errors.New("LUT_3D_INPUT_RANGE cannot be combined with DOMAIN_MIN or DOMAIN_MAX")
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

func parseCubeFiniteFloat(value string) (float64, error) {
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed > 1e100 || parsed < -1e100 {
		return 0, errors.New("value is not finite")
	}
	return parsed, nil
}

// normalizeCubeForFFmpeg translates DJI's scalar input-range directive into
// the per-channel domain headers understood by FFmpeg. It never edits path;
// callers own and remove any returned temporary file.
func normalizeCubeForFFmpeg(path string, expectedGrid int, expectedHash string) (string, error) {
	_, originalDigest, err := verifyCube(path, expectedGrid, expectedHash)
	if err != nil {
		return "", err
	}
	input, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open LUT for FFmpeg normalization: %w", err)
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	hasBOM := false
	hasInputRange := false
	var minimum, maximum string
	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(line, "\ufeff") {
			hasBOM = true
		}
		line = strings.TrimSpace(strings.TrimPrefix(line, "\ufeff"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if strings.EqualFold(fields[0], "LUT_3D_INPUT_RANGE") {
			hasInputRange = true
			minimum, maximum = fields[1], fields[2]
		}
	}
	scanErr := scanner.Err()
	closeErr := input.Close()
	if scanErr != nil {
		return "", fmt.Errorf("read LUT headers: %w", scanErr)
	}
	if closeErr != nil {
		return "", fmt.Errorf("close LUT after header scan: %w", closeErr)
	}
	if !hasBOM && !hasInputRange {
		return "", nil
	}

	input, err = os.Open(path)
	if err != nil {
		return "", fmt.Errorf("reopen LUT for FFmpeg normalization: %w", err)
	}
	temp, err := os.CreateTemp("", "dji-lut-normalized-*.cube")
	if err != nil {
		input.Close()
		return "", fmt.Errorf("create temporary normalized LUT: %w", err)
	}
	tempPath := temp.Name()
	cleanup := func(cause error) (string, error) {
		input.Close()
		temp.Close()
		os.Remove(tempPath)
		return "", cause
	}
	h := sha256.New()
	scanner = bufio.NewScanner(io.TeeReader(input, h))
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	writer := bufio.NewWriter(temp)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "\ufeff") {
			line = strings.TrimPrefix(line, "\ufeff")
		}
		trimmed := strings.TrimSpace(line)
		if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			fields := strings.Fields(trimmed)
			if strings.EqualFold(fields[0], "LUT_3D_INPUT_RANGE") {
				if len(fields) != 3 {
					return cleanup(errors.New("LUT_3D_INPUT_RANGE must contain two finite values"))
				}
				if _, err := fmt.Fprintf(writer, "DOMAIN_MIN %s %s %s\nDOMAIN_MAX %s %s %s\n", minimum, minimum, minimum, maximum, maximum, maximum); err != nil {
					return cleanup(fmt.Errorf("write normalized LUT domain: %w", err))
				}
				continue
			}
		}
		if _, err := io.WriteString(writer, line+"\n"); err != nil {
			return cleanup(fmt.Errorf("write normalized LUT: %w", err))
		}
	}
	if err := scanner.Err(); err != nil {
		return cleanup(fmt.Errorf("read LUT for normalization: %w", err))
	}
	if got := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(got, originalDigest) {
		return cleanup(errors.New("LUT changed during FFmpeg normalization"))
	}
	if err := writer.Flush(); err != nil {
		return cleanup(fmt.Errorf("flush normalized LUT: %w", err))
	}
	if err := input.Close(); err != nil {
		temp.Close()
		os.Remove(tempPath)
		return "", fmt.Errorf("close LUT after normalization: %w", err)
	}
	if err := temp.Close(); err != nil {
		os.Remove(tempPath)
		return "", fmt.Errorf("close normalized LUT: %w", err)
	}
	return tempPath, nil
}

func truncate(value string, n int) string {
	if len(value) <= n {
		return value
	}
	return value[:n]
}
