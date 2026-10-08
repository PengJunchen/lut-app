package engine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
)

func TestCatalogUsesLatestNumericVersionAndDefaultsLegacyMetadata(t *testing.T) {
	entries := []LUTSpec{
		{Camera: "pocket3", Profile: "dlogm", Look: LookStandard, File: "v2.cube", SHA256: strings.Repeat("a", 64), Grid: 33, Version: "2.0"},
		{Camera: "pocket3", Profile: "dlogm", Look: LookStandard, File: "v10.cube", SHA256: strings.Repeat("b", 64), Grid: 33, Version: "10.0"},
		{Camera: "pocket3", Profile: "dlogm", Look: LookStandard, File: "legacy.cube", SHA256: strings.Repeat("c", 64), Grid: 33},
	}
	got, err := normalizeCatalog(entries, t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Version != "10.0" || filepath.Base(got[0].File) != "v10.cube" {
		t.Fatalf("selected catalog entry = %#v; want version 10.0", got)
	}
	if got[0].Format != lutFormatCube3D || got[0].OutputColorSpace != outputRec709 || got[0].Purpose != purposeRestore {
		t.Fatalf("legacy metadata defaults = format %q, output %q, purpose %q", got[0].Format, got[0].OutputColorSpace, got[0].Purpose)
	}
}

func TestCatalogVersionsStayIndependentAcrossProfilesAndLooks(t *testing.T) {
	entry := func(profile string, look Look, version string, digest byte) LUTSpec {
		return LUTSpec{
			Camera: "pocket3", Profile: profile, Look: look, File: profile + "-" + string(look) + "-" + version + ".cube",
			SHA256: strings.Repeat(string(digest), 64), Grid: 33, Version: version,
		}
	}
	entries := []LUTSpec{
		entry("dlogm", LookStandard, "1.0", 'a'),
		entry("dlogm", LookStandard, "2.0", 'b'),
		entry("dlog2", LookStandard, "1.0", 'c'),
		entry("dlogm", LookVivid, "1.0", 'd'),
		entry("dlogm", LookVivid, "2.0", 'e'),
	}
	got, err := normalizeCatalog(entries, t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("selected profile/look groups = %#v; want 3 independent groups", got)
	}
	selected := make(map[string]string, len(got))
	for _, item := range got {
		selected[item.Profile+"/"+string(item.Look)] = item.Version
	}
	want := map[string]string{"dlogm/standard": "2.0", "dlog2/standard": "1.0", "dlogm/vivid": "2.0"}
	for key, version := range want {
		if selected[key] != version {
			t.Errorf("selected version for %s = %q; want %q", key, selected[key], version)
		}
	}
}

func TestCatalogRejectsAmbiguousOrMalformedVersionsAndUnsafeAutomaticEntries(t *testing.T) {
	base := LUTSpec{Camera: "pocket3", Profile: "dlogm", Look: LookStandard, File: "test.cube", SHA256: strings.Repeat("a", 64), Grid: 33, Version: "V1.0"}
	conflict := base
	conflict.File, conflict.SHA256 = "other.cube", strings.Repeat("b", 64)
	if _, err := normalizeCatalog([]LUTSpec{base, conflict}, t.TempDir(), ""); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("same-version hash conflict = %v; want ambiguity error", err)
	}
	malformed := base
	malformed.Version = "1.beta"
	if _, err := normalizeCatalog([]LUTSpec{malformed}, t.TempDir(), ""); err == nil {
		t.Fatal("malformed explicit version was accepted")
	}
	unsupported := base
	unsupported.Format = "3dl"
	if _, err := normalizeCatalog([]LUTSpec{unsupported}, t.TempDir(), ""); err == nil {
		t.Fatal("unsupported automatic LUT format was accepted")
	}
	unsupported = base
	unsupported.Purpose = "creative"
	if _, err := normalizeCatalog([]LUTSpec{unsupported}, t.TempDir(), ""); err == nil {
		t.Fatal("non-restore LUT purpose was accepted for automatic use")
	}
}

func TestVerifyAndNormalizeCubeInputRangePreservingRowsAndSource(t *testing.T) {
	rows := "0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n"
	original := []byte("\ufeffTITLE \"Input range LUT\"\nLUT_3D_INPUT_RANGE -0.5 1.5\nLUT_3D_SIZE 2\n" + rows)
	path := filepath.Join(t.TempDir(), "range.cube")
	if err := os.WriteFile(path, original, 0o644); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(original)
	expectedHash := hex.EncodeToString(digest[:])
	if grid, gotHash, err := verifyCube(path, 2, expectedHash); err != nil || grid != 2 || gotHash != expectedHash {
		t.Fatalf("input-range cube verification = grid %d, hash %s, err %v", grid, gotHash, err)
	}
	normalized, err := normalizeCubeForFFmpeg(path, 2, expectedHash)
	if err != nil {
		t.Fatal(err)
	}
	if normalized == "" || normalized == path {
		t.Fatalf("expected an ephemeral normalized LUT, got %q", normalized)
	}
	defer os.Remove(normalized)
	converted, err := os.ReadFile(normalized)
	if err != nil {
		t.Fatal(err)
	}
	text := string(converted)
	if strings.Contains(text, "LUT_3D_INPUT_RANGE") || strings.HasPrefix(text, "\ufeff") || !strings.Contains(text, "DOMAIN_MIN -0.5 -0.5 -0.5\nDOMAIN_MAX 1.5 1.5 1.5") {
		t.Fatalf("normalized LUT header is incorrect: %q", text[:min(len(text), 200)])
	}
	dataRows := func(data []byte) []string {
		var result []string
		for _, line := range strings.Split(string(data), "\n") {
			fields := strings.Fields(line)
			if len(fields) != 3 {
				continue
			}
			valid := true
			for _, field := range fields {
				if _, err := strconv.ParseFloat(field, 64); err != nil {
					valid = false
					break
				}
			}
			if valid {
				result = append(result, strings.Join(fields, " "))
			}
		}
		return result
	}
	if strings.Join(dataRows(original), "\n") != strings.Join(dataRows(converted), "\n") {
		t.Fatal("normalization changed the 3D numeric rows")
	}
	if grid, _, err := verifyCube(normalized, 2, ""); err != nil || grid != 2 {
		t.Fatalf("FFmpeg-compatible normalized cube verification = grid %d, err %v", grid, err)
	}
	unchanged, err := os.ReadFile(path)
	if err != nil || string(unchanged) != string(original) {
		t.Fatalf("official/source LUT bytes changed during normalization: %v", err)
	}
	bomOnly := []byte("\ufeffLUT_3D_SIZE 2\n" + rows)
	bomPath := filepath.Join(t.TempDir(), "bom.cube")
	if err := os.WriteFile(bomPath, bomOnly, 0o644); err != nil {
		t.Fatal(err)
	}
	bomDigest := sha256.Sum256(bomOnly)
	bomNormalized, err := normalizeCubeForFFmpeg(bomPath, 2, hex.EncodeToString(bomDigest[:]))
	if err != nil || bomNormalized == "" {
		t.Fatalf("BOM-only cube normalization = %q, %v", bomNormalized, err)
	}
	defer os.Remove(bomNormalized)
	bomOutput, err := os.ReadFile(bomNormalized)
	if err != nil || strings.HasPrefix(string(bomOutput), "\ufeff") || strings.Join(dataRows(bomOnly), "\n") != strings.Join(dataRows(bomOutput), "\n") {
		t.Fatalf("BOM normalization changed LUT rows or retained BOM: %v", err)
	}
	plain := []byte("LUT_3D_SIZE 2\n" + rows)
	plainPath := filepath.Join(t.TempDir(), "plain.cube")
	if err := os.WriteFile(plainPath, plain, 0o644); err != nil {
		t.Fatal(err)
	}
	plainDigest := sha256.Sum256(plain)
	plainNormalized, err := normalizeCubeForFFmpeg(plainPath, 2, hex.EncodeToString(plainDigest[:]))
	if err != nil || plainNormalized != "" {
		t.Fatalf("plain cube should not create a normalization temp file: %q, %v", plainNormalized, err)
	}
}

func TestVerifyCubeRejectsAmbiguousInputRangeHeaders(t *testing.T) {
	rows := "LUT_3D_SIZE 2\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n"
	for _, header := range []string{
		"LUT_3D_INPUT_RANGE 0 1\nLUT_3D_INPUT_RANGE 0 1\n",
		"LUT_3D_INPUT_RANGE 0 1\nDOMAIN_MIN 0 0 0\n",
		"LUT_3D_INPUT_RANGE 0 1\nDOMAIN_MAX 1 1 1\n",
		"LUT_3D_INPUT_RANGE 1 1\n",
		"LUT_3D_INPUT_RANGE NaN 1\n",
	} {
		path := filepath.Join(t.TempDir(), "ambiguous.cube")
		if err := os.WriteFile(path, []byte(header+rows), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, _, err := verifyCube(path, 2, ""); err == nil {
			t.Errorf("verifyCube accepted ambiguous header %q", header)
		}
	}
}

func TestCameraMatchingFailsClosedAndAllowsGenericEncoderWithExactModel(t *testing.T) {
	unknownModelKnownEncoder := Probe{Format: ProbeFormat{Tags: map[string]string{
		cameraModelTag: "DJI Mavic 2 Zoom", "encoder": "DJI Air 3",
	}}}
	if _, _, err := resolveCamera(unknownModelKnownEncoder); err == nil || !strings.Contains(err.Error(), "cannot fall back") {
		t.Fatalf("unknown explicit model with known encoder = %v; want fail-closed error", err)
	}
	knownModelGenericEncoder := Probe{Format: ProbeFormat{Tags: map[string]string{
		cameraModelTag: "DJI Osmo Pocket 3", "encoder": "Lavf60.3.100",
	}}}
	if camera, source, err := resolveCamera(knownModelGenericEncoder); err != nil || camera != "pocket3" || source != "exact_model" {
		t.Fatalf("exact model with generic encoder = %q, %q, %v", camera, source, err)
	}
	knownModelSeveralGenerics := Probe{
		Format:  ProbeFormat{Tags: map[string]string{cameraModelTag: "DJI Osmo Pocket 3", "encoder": "Lavf62.12.102"}},
		Streams: []Stream{{Tags: map[string]string{"encoder": "Lavc62.28.102 ffv1"}}, {Tags: map[string]string{"encoder": "Lavc62.28.102 pcm_s16le"}}},
	}
	if camera, _, err := resolveCamera(knownModelSeveralGenerics); err != nil || camera != "pocket3" {
		t.Fatalf("exact model with generic container/codec encoder tags = %q, %v", camera, err)
	}
}

func TestSupportedVideoExtensionsAreSortedAndIncludeRawAndOSVFormats(t *testing.T) {
	extensions := SupportedVideoExtensions()
	if !sort.StringsAreSorted(extensions) {
		t.Fatalf("extensions are not sorted: %v", extensions)
	}
	for _, required := range []string{".osv", ".264", ".avc", ".h264", ".265", ".h265", ".hevc"} {
		found := false
		for _, extension := range extensions {
			if extension == required {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("supported extension list is missing %s", required)
		}
	}
}

func TestMultitrackAndSphericalProbeRequireReviewCopy(t *testing.T) {
	multitrack := Probe{Streams: []Stream{
		{CodecType: "video", Disposition: map[string]int{"attached_pic": 0}},
		{CodecType: "video"},
		{CodecType: "video", Disposition: map[string]int{"attached_pic": 1}},
	}}
	if count := mainVideoCount(multitrack); count != 2 {
		t.Fatalf("main video count = %d; want 2", count)
	}
	spherical := Probe{Format: ProbeFormat{Tags: map[string]string{"projection-type": "equirectangular"}}}
	if !hasSphericalProjection(spherical) {
		t.Fatal("spherical projection metadata was not detected")
	}
}

func TestScanKeepsMultipleMainVideoTracksAsReviewCopy(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a small POSIX ffprobe stub")
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "multi.mp4"), []byte("not real media"), 0o644); err != nil {
		t.Fatal(err)
	}
	fixture, err := json.Marshal(Probe{Streams: []Stream{{CodecType: "video"}, {CodecType: "video"}}})
	if err != nil {
		t.Fatal(err)
	}
	stub := filepath.Join(t.TempDir(), "ffprobe-stub")
	script := "#!/bin/sh\nprintf '%s\\n' '" + string(fixture) + "'\n"
	if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg, err := normalizeConfig(Config{Input: root, FFprobe: stub})
	if err != nil {
		t.Fatal(err)
	}
	files, err := scanFiles(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0].public.Action != ActionCopy || files[0].public.Status != StatusNeedsReview || !strings.Contains(files[0].public.Reason, "multiple main video tracks") {
		t.Fatalf("multitrack plan = %#v", files)
	}
}

func TestScanKeepsRawElementaryStreamAsReviewCopy(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "camera.h264"), []byte("raw elementary stream"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := normalizeConfig(Config{Input: root, FFprobe: filepath.Join(root, "ffprobe-does-not-exist")})
	if err != nil {
		t.Fatal(err)
	}
	files, err := scanFiles(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0].public.Action != ActionCopy || files[0].public.Status != StatusNeedsReview || !strings.Contains(files[0].public.Reason, "raw elementary video") {
		t.Fatalf("raw stream plan = %#v", files)
	}
}

func TestOutputContainerAndMatroskaPacketValidation(t *testing.T) {
	if got := outputExtension(Probe{Streams: []Stream{{CodecType: "audio", CodecName: "aac"}}}); got != ".mp4" {
		t.Fatalf("AAC output extension = %q; want .mp4", got)
	}
	for _, codec := range []string{"pcm_s24le", "flac", "dts"} {
		if got := outputExtension(Probe{Streams: []Stream{{CodecType: "audio", CodecName: codec}}}); got != ".mkv" {
			t.Errorf("%s output extension = %q; want .mkv", codec, got)
		}
	}
	source := Probe{Streams: []Stream{{CodecType: "video", NbReadPackets: "120"}}}
	output := Probe{Streams: []Stream{{CodecType: "video", NbReadPackets: "120"}}}
	if problems := validateMkvPacketCounts(source, output); len(problems) != 0 {
		t.Fatalf("equal packet counts rejected: %v", problems)
	}
	output.Streams[0].NbReadPackets = "119"
	if problems := validateMkvPacketCounts(source, output); len(problems) != 1 || !strings.Contains(problems[0], "expected 120") {
		t.Fatalf("packet loss was not detected: %v", problems)
	}
}

func TestRunSyntheticPCMSourceUsesMatroskaAndPreservesStreams(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is not installed")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe is not installed")
	}
	encoders, err := queryEncoders(context.Background(), ffmpeg)
	if err != nil || !encoders["libx265"] {
		t.Skip("ffmpeg does not provide libx265")
	}
	root := t.TempDir()
	source := filepath.Join(root, "synthetic.mov")
	generate := exec.Command(ffmpeg,
		"-hide_banner", "-nostdin", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=size=64x64:rate=5",
		"-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000",
		"-t", "1", "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le",
		"-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
		"-c:a", "pcm_s16le",
		"-metadata", cameraModelTag+"=DJI Osmo Pocket 3", "-metadata", gammaTag+"=D-Log M",
		"-metadata:s:v:0", cameraModelTag+"=DJI Osmo Pocket 3", "-metadata:s:v:0", gammaTag+"=D-Log M",
		"-movflags", "+use_metadata_tags",
		source,
	)
	if output, err := generate.CombinedOutput(); err != nil {
		t.Fatalf("generate synthetic source: %v\n%s", err, output)
	}
	inputBefore, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	probe, err := probeFile(context.Background(), source, ffprobe)
	if err != nil {
		t.Fatal(err)
	}
	if values := metadataValues(probe, cameraModelTag); len(values) != 1 || values[0] != "DJI Osmo Pocket 3" {
		t.Skipf("this FFmpeg/Matroska build did not retain custom DJI tags: %v", values)
	}
	if values := metadataValues(probe, gammaTag); len(values) != 1 || values[0] != "D-Log M" {
		t.Skipf("this FFmpeg/Matroska build did not retain the gamma tag: %v", values)
	}
	lutDir := filepath.Join(root, "luts")
	if err := os.MkdirAll(lutDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cube := "LUT_3D_SIZE 2\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n"
	lutPath := filepath.Join(lutDir, "identity.cube")
	if err := os.WriteFile(lutPath, []byte(cube), 0o644); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(cube))
	manifest := []LUTSpec{{Camera: "pocket3", Profile: "dlogm", Look: LookStandard, File: lutPath, SHA256: hex.EncodeToString(digest[:]), Grid: 2, Name: "Synthetic identity", Version: "1.2"}}
	config := Config{Input: root, Output: filepath.Join(root, "out"), FFmpeg: ffmpeg, FFprobe: ffprobe, LUTDir: lutDir, Manifest: manifest, Encoder: EncoderX265, Workers: 1}
	plan, err := Scan(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Items) != 1 || plan.Items[0].Action != ActionEncode || !strings.HasSuffix(strings.ToLower(plan.Items[0].Output), ".mkv") {
		t.Fatalf("PCM source plan = %#v; want encoded Matroska output", plan.Items)
	}
	if plan.Items[0].LUTName != "Synthetic identity" || plan.Items[0].LUTVersion != "1.2" {
		t.Fatalf("LUT identity was not propagated into the plan: %#v", plan.Items[0])
	}
	report, err := Run(context.Background(), config, nil)
	if err != nil {
		t.Fatalf("run synthetic encode: %v", err)
	}
	if len(report.Items) != 1 || report.Items[0].Status != StatusEncoded {
		t.Fatalf("synthetic encode report = %#v", report.Items)
	}
	if report.Items[0].LUTName != "Synthetic identity" || report.Items[0].LUTVersion != "1.2" {
		t.Fatalf("LUT identity was not propagated into the report: %#v", report.Items[0])
	}
	output := filepath.Join(report.OutputRoot, filepath.FromSlash(report.Items[0].Output))
	outputProbe, err := probeFileWithPacketCounts(context.Background(), output, ffprobe, true)
	if err != nil {
		t.Fatal(err)
	}
	video, err := mainVideo(outputProbe)
	if err != nil || !strings.EqualFold(video.CodecName, "hevc") || video.NbReadPackets != "5" {
		t.Fatalf("Matroska video validation = codec %q, packets %q, err %v", video.CodecName, video.NbReadPackets, err)
	}
	if tagValue(video.Tags, "COLOR_PRIMARIES") != "bt709" || tagValue(video.Tags, "COLOR_TRANSFER") != "bt709" {
		t.Fatalf("Matroska color metadata = primaries %q, transfer %q", tagValue(video.Tags, "COLOR_PRIMARIES"), tagValue(video.Tags, "COLOR_TRANSFER"))
	}
	audio := audioStreams(outputProbe)
	if len(audio) != 1 || audio[0].CodecName != "pcm_s16le" {
		t.Fatalf("Matroska audio stream = %#v; want copied PCM", audio)
	}
	inputAfter, err := os.ReadFile(source)
	if err != nil || string(inputAfter) != string(inputBefore) {
		t.Fatalf("source changed during encode: %v", err)
	}
}

func TestRunPhantom4OfficialCubeWithDJIInputRangeHeader(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is not installed")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe is not installed")
	}
	encoders, err := queryEncoders(context.Background(), ffmpeg)
	if err != nil || !encoders["libx265"] {
		t.Skip("ffmpeg does not provide libx265")
	}
	assetRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	lutPath := filepath.Join(assetRoot, "assets", "luts", "sha256-606a69301f1071b9db8e7fb365cc4d24bd3baacf1a7e6678d3961349cef43b01.cube")
	if _, err := os.Stat(lutPath); err != nil {
		t.Skip("official Phantom 4 LUT fixture is not present")
	}
	originalCube, err := os.ReadFile(lutPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(originalCube), "LUT_3D_INPUT_RANGE") {
		t.Skip("official Phantom 4 LUT fixture no longer uses DJI's input-range header")
	}
	grid, digest, err := verifyCube(lutPath, 33, "")
	if err != nil {
		t.Fatalf("verify official Phantom 4 LUT: %v", err)
	}
	root := t.TempDir()
	source := filepath.Join(root, "phantom4.mov")
	generate := exec.Command(ffmpeg,
		"-hide_banner", "-nostdin", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=size=64x64:rate=5",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
		"-t", "1", "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le",
		"-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
		"-c:a", "pcm_s16le",
		"-metadata", cameraModelTag+"=DJI Phantom 4", "-metadata", gammaTag+"=D-Log",
		"-metadata:s:v:0", cameraModelTag+"=DJI Phantom 4", "-metadata:s:v:0", gammaTag+"=D-Log",
		"-movflags", "+use_metadata_tags", source,
	)
	if output, err := generate.CombinedOutput(); err != nil {
		t.Fatalf("generate synthetic Phantom 4 source: %v\n%s", err, output)
	}
	inputHash, err := hashFile(source)
	if err != nil {
		t.Fatal(err)
	}
	manifest := []LUTSpec{{Camera: "phantom4", Profile: "dlog", Look: LookStandard, File: lutPath, SHA256: digest, Grid: grid, Name: "Official Phantom 4", Version: ""}}
	config := Config{Input: root, Output: filepath.Join(root, "out"), FFmpeg: ffmpeg, FFprobe: ffprobe, Manifest: manifest, Encoder: EncoderX265, Workers: 1}
	report, err := Run(context.Background(), config, nil)
	if err != nil {
		t.Fatalf("run Phantom 4 source through official LUT: %v", err)
	}
	if len(report.Items) != 1 || report.Items[0].Status != StatusEncoded || report.Items[0].LUTSHA256 != digest || report.Items[0].LUTFile != lutPath {
		t.Fatalf("Phantom 4 official-LUT report = %#v", report.Items)
	}
	if got, err := hashFile(lutPath); err != nil || got != digest {
		t.Fatalf("official LUT changed during processing: hash %q, err %v", got, err)
	}
	if got, err := hashFile(source); err != nil || got != inputHash {
		t.Fatalf("source clip changed during processing: hash %q, err %v", got, err)
	}
}
