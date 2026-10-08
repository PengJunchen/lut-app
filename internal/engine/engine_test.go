package engine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeAndClassifyExactGammaAliases(t *testing.T) {
	for _, test := range []struct {
		value, profile string
	}{
		{"D-Log", "dlog"}, {"dlog", "dlog"}, {"D-Log2", "dlog2"},
		{"D-Log M", "dlogm"}, {"dlogm", "dlogm"}, {"D-Log-M", "dlogm"},
	} {
		if got := normalizeProfile(test.value); got != test.profile {
			t.Errorf("normalizeProfile(%q) = %q, want %q", test.value, got, test.profile)
		}
	}
	for _, value := range []string{"D-Log3", "D-Log M V2", "Standard", "SDR"} {
		if got := normalizeProfile(value); got != "" {
			t.Errorf("normalizeProfile(%q) = %q, want unsupported", value, got)
		}
	}

	probe := Probe{Format: ProbeFormat{Tags: map[string]string{gammaTag: "D-Log2"}}}
	if result := classifyGamma(probe); result.kind != "log" || result.profile != "dlog2" {
		t.Fatalf("D-Log2 classification = %#v", result)
	}
	probe.Streams = []Stream{{Tags: map[string]string{gammaTag: "dlog2"}}}
	if result := classifyGamma(probe); result.kind != "log" || result.profile != "dlog2" {
		t.Fatalf("equivalent gamma tags should agree: %#v", result)
	}
	probe.Streams[0].Tags[gammaTag] = "D-Log M"
	if result := classifyGamma(probe); result.kind != "review" {
		t.Fatalf("conflicting gamma tags should need review: %#v", result)
	}
	if result := classifyGamma(Probe{}); result.kind != "review" {
		t.Fatalf("missing gamma should need review: %#v", result)
	}
	if result := classifyGamma(Probe{Format: ProbeFormat{Tags: map[string]string{gammaTag: "HLG"}}}); result.kind != "hdr" {
		t.Fatalf("explicit HDR gamma should be copied as HDR: %#v", result)
	}
}

func TestCameraMatchingUsesExactEvidenceAndPocket4PPair(t *testing.T) {
	pocket4p := Probe{Format: ProbeFormat{Tags: map[string]string{
		cameraModelTag: "PP-041", "encoder": "DJI OsmoPocket4P",
	}}}
	if got, source, err := resolveCamera(pocket4p); err != nil || got != "pocket4p" || source != "metadata_pair" {
		t.Fatalf("Pocket 4P pair = %q, %q, %v", got, source, err)
	}
	missingPair := Probe{Format: ProbeFormat{Tags: map[string]string{cameraModelTag: "PP-041"}}}
	if _, _, err := resolveCamera(missingPair); err == nil {
		t.Fatal("PP-041 without the matching encoder must fail closed")
	}
	knownModel := Probe{Format: ProbeFormat{Tags: map[string]string{cameraModelTag: "DJI OsmoPocket 3"}}}
	if got, source, err := resolveCamera(knownModel); err != nil || got != "pocket3" || source != "exact_model" {
		t.Fatalf("exact model alias = %q, %q, %v", got, source, err)
	}
	knownEncoder := Probe{Format: ProbeFormat{Tags: map[string]string{"encoder": "DJI Air3"}}}
	if got, source, err := resolveCamera(knownEncoder); err != nil || got != "air3" || source != "exact_encoder" {
		t.Fatalf("exact encoder alias = %q, %q, %v", got, source, err)
	}
	unknown := Probe{Format: ProbeFormat{Tags: map[string]string{cameraModelTag: "Osmo Pocket 30"}}}
	if _, _, err := resolveCamera(unknown); err == nil {
		t.Fatal("a similar but unlisted camera name must not match")
	}
	conflict := Probe{Format: ProbeFormat{Tags: map[string]string{cameraModelTag: "DJI Osmo Pocket 3", "encoder": "DJI Air 3"}}}
	if _, _, err := resolveCamera(conflict); err == nil {
		t.Fatal("conflicting model and encoder evidence must fail closed")
	}
}

func TestMainVideoIgnoresAttachedCover(t *testing.T) {
	probe := Probe{Streams: []Stream{
		{Index: 0, CodecType: "video", Disposition: map[string]int{"attached_pic": 1}},
		{Index: 1, CodecType: "video", Width: 3840, Height: 2160},
	}}
	video, err := mainVideo(probe)
	if err != nil || video.Index != 1 {
		t.Fatalf("main video = %#v, %v", video, err)
	}
}

func TestCatalogLoadsManifestRelativeLUTAndVerifiesGridHash(t *testing.T) {
	root := t.TempDir()
	assets := filepath.Join(root, "assets")
	lutDir := filepath.Join(assets, "luts")
	if err := os.MkdirAll(lutDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cube := "LUT_3D_SIZE 2\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n"
	cubePath := filepath.Join(lutDir, "test.cube")
	if err := os.WriteFile(cubePath, []byte(cube), 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(cube))
	manifestPath := filepath.Join(assets, "catalog.json")
	manifest := map[string]any{"version": 1, "entries": []LUTSpec{{
		Camera: "pocket3", Profile: "D-Log M", Look: LookStandard,
		File: "luts/test.cube", SHA256: hex.EncodeToString(sum[:]), Grid: 2,
		Version: "1.2", OutputColorSpace: "Rec.709", Purpose: "restore",
		LibraryID: "pocket3-dlogm-v1.2", Name: "Pocket 3 D-Log M to Rec.709", Format: "cube",
	}}}
	data, _ := json.Marshal(manifest)
	if err := os.WriteFile(manifestPath, data, 0o644); err != nil {
		t.Fatal(err)
	}
	entries, err := LoadCatalog(manifestPath, lutDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Profile != "dlogm" || entries[0].File != cubePath || entries[0].Version != "1.2" || entries[0].Name != "Pocket 3 D-Log M to Rec.709" || entries[0].OutputColorSpace != outputRec709 || entries[0].Purpose != purposeRestore || entries[0].LibraryID != "pocket3-dlogm-v1.2" || entries[0].Format != lutFormatCube3D {
		t.Fatalf("catalog entry = %#v", entries)
	}
	grid, digest, err := verifyCube(entries[0].File, entries[0].Grid, entries[0].SHA256)
	if err != nil || grid != 2 || digest != hex.EncodeToString(sum[:]) {
		t.Fatalf("verified cube = %d, %s, %v", grid, digest, err)
	}
	if _, _, err := verifyCube(entries[0].File, 3, entries[0].SHA256); err == nil {
		t.Fatal("manifest grid mismatch must be rejected")
	}
}

func TestDiscoveryExcludesHiddenLRFLUTOutputAndManagedOutput(t *testing.T) {
	root := t.TempDir()
	write := func(rel string) {
		t.Helper()
		path := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("video"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("root.MP4")
	write("nested/clip.mov")
	write("DJI_001_LRF.MP4")
	write(".hidden/hidden.mp4")
	write("luts/asset.mp4")
	write("Output/Standard/old.mp4")
	write("managed/render.mp4")
	if err := os.WriteFile(filepath.Join(root, "managed", "report.json"), []byte(`{"generated_by":"dji-lut-app/1.0.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	write("foreign/clip.mp4")
	if err := os.WriteFile(filepath.Join(root, "foreign", "report.json"), []byte(`{"generated_by":"other"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := normalizeConfig(Config{Input: root, Recursive: true})
	if err != nil {
		t.Fatal(err)
	}
	paths, err := discoverVideos(cfg)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, path := range paths {
		rel, _ := filepath.Rel(root, path)
		got = append(got, filepath.ToSlash(rel))
	}
	want := []string{"foreign/clip.mp4", "nested/clip.mov", "root.MP4"}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("discovered %v, want %v", got, want)
	}
}

func TestCopyFileVerifiesExactBytesAndPreservesSource(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "camera", "clip.mp4")
	output := filepath.Join(root, "out", "clip.mp4")
	content := []byte("original container bytes\x00\x01\x02")
	if err := os.MkdirAll(filepath.Dir(source), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, content, 0o644); err != nil {
		t.Fatal(err)
	}
	file := filePlan{source: source, output: output, relative: "camera/clip.mp4", public: ItemPlan{Status: StatusCopiedNonLog}}
	item, err := copyFile(context.Background(), file, ItemReport{Input: file.relative, Output: "camera/clip.mp4", Action: ActionCopy}, Report{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if item.Status != StatusCopiedNonLog || !item.OutputVerified || item.BytesCopied != int64(len(content)) {
		t.Fatalf("copy result = %#v", item)
	}
	if item.InputSHA256 != item.OutputSHA256 {
		t.Fatalf("copy hashes differ: input=%s output=%s", item.InputSHA256, item.OutputSHA256)
	}
	if got, err := os.ReadFile(output); err != nil || string(got) != string(content) {
		t.Fatalf("output bytes = %q, %v", got, err)
	}
	if got, err := os.ReadFile(source); err != nil || string(got) != string(content) {
		t.Fatalf("source changed: %q, %v", got, err)
	}
}

func TestSkipExistingRequiresMatchingSourceConfigAndOutputHash(t *testing.T) {
	root := t.TempDir()
	source, output := filepath.Join(root, "source.mp4"), filepath.Join(root, "output.mp4")
	if err := os.WriteFile(source, []byte("source"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(output, []byte("converted"), 0o644); err != nil {
		t.Fatal(err)
	}
	inputHash, _ := hashFile(source)
	outputHash, _ := hashFile(output)
	file := filePlan{source: source, output: output, relative: "source.mp4", public: ItemPlan{Status: StatusPlannedEncode}}
	item := ItemReport{Input: file.relative, ConfigKey: "profile|camera|look|lut"}
	previous := Report{Items: []ItemReport{{
		Input: item.Input, ConfigKey: item.ConfigKey, InputSHA256: inputHash,
		OutputSHA256: outputHash, OutputVerified: true,
	}}}
	got, err := skipExisting(context.Background(), item, file, previous)
	if err != nil || got.Status != StatusSkippedExisting || got.NeedsReview {
		t.Fatalf("matching existing output = %#v, %v", got, err)
	}
	if err := os.WriteFile(output, []byte("changed output"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err = skipExisting(context.Background(), item, file, previous)
	if err != nil || got.Status != StatusSkippedExisting || !got.NeedsReview {
		t.Fatalf("modified existing output must need review: %#v, %v", got, err)
	}
}

func TestFilterPathUsesTwoLayerEscapingWithoutQuotes(t *testing.T) {
	got := escapeFilterPath(`C:/My LUT's, [中];x.cube`)
	want := `C\\:/My LUT\\\'s\, \[中\]\;x.cube`
	if got != want {
		t.Fatalf("escaped path = %q, want %q", got, want)
	}
	file := filePlan{inputMatrix: "bt709", inputRange: "tv", lut: &LUTSpec{File: `C:/My LUT's, [中];x.cube`}}
	command := buildFFmpegCommand(normalizedConfig{ffmpeg: "ffmpeg", filterThreads: 6}, file, "temp.mp4", EncoderX265)
	joined := strings.Join(command, " ")
	if strings.Contains(joined, "lut3d=file='") || !strings.Contains(joined, "-nostdin") {
		t.Fatalf("unsafe filter path quoting or missing noninteractive flag: %s", joined)
	}
}
