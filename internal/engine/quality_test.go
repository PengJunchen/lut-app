package engine

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestQualityValidationAndExplicitCRFPreservation(t *testing.T) {
	root := t.TempDir()
	for _, tc := range []struct {
		quality QualityMode
		crf     int
		want    int
	}{
		{"", 0, 16}, {QualityBalanced, 0, 16}, {QualityDetail, 0, 14}, {QualityDetail, 19, 19},
	} {
		cfg, err := normalizeConfig(Config{Input: root, Quality: tc.quality, CRF: tc.crf})
		if err != nil || cfg.crf != tc.want {
			t.Fatalf("quality %q CRF %d: got %d, %v", tc.quality, tc.crf, cfg.crf, err)
		}
		if cfg.Quality == "" {
			t.Fatal("quality must be normalized for reports and resume checks")
		}
	}
	if _, err := normalizeConfig(Config{Input: root, Quality: "unknown"}); err == nil {
		t.Fatal("unsupported quality was accepted")
	}
}

func TestDetailQualitySelectsSupportedPlatformEncoder(t *testing.T) {
	available := map[string]bool{"hevc_videotoolbox": true, "libx265": true}
	for _, tc := range []struct {
		os, arch string
		quality  QualityMode
		want     EncoderMode
	}{
		{"darwin", "arm64", QualityDetail, EncoderVideoToolbox},
		{"darwin", "amd64", QualityDetail, EncoderX265},
		{"darwin", "amd64", QualityBalanced, EncoderVideoToolbox},
		{"windows", "amd64", QualityDetail, EncoderX265},
		{"linux", "amd64", QualityDetail, EncoderX265},
	} {
		cfg := normalizedConfig{Config: Config{Encoder: EncoderAuto, Quality: tc.quality}}
		got, err := defaultEncoderForPlatform(cfg, available, tc.os, tc.arch)
		if err != nil || got != tc.want {
			t.Errorf("%s/%s %s: encoder %q, %v; want %q", tc.os, tc.arch, tc.quality, got, err, tc.want)
		}
	}
	cfg := normalizedConfig{Config: Config{Encoder: EncoderVideoToolbox, Quality: QualityDetail}}
	if _, err := defaultEncoderForPlatform(cfg, available, "darwin", "amd64"); err == nil {
		t.Fatal("Intel VideoToolbox must not silently ignore detail quality")
	}
}

func TestDetailVideoToolboxDoesNotUseBitratePadding(t *testing.T) {
	file := filePlan{inputMatrix: "bt709", inputRange: "tv", lut: &LUTSpec{File: "restore.cube"}}
	cfg := normalizedConfig{Config: Config{Quality: QualityDetail}, ffmpeg: "ffmpeg", filterThreads: 6}
	command := strings.Join(buildFFmpegCommand(cfg, file, "temp.mp4", EncoderVideoToolbox), " ")
	if !strings.Contains(command, "-q:v 90") || strings.Contains(command, "-b:v") || strings.Contains(command, "constant_bit_rate") {
		t.Fatalf("detail quality must select fidelity rather than padding a bitrate target: %s", command)
	}
}

func TestDifferentEncodingQualityPreservesExistingOutputForReview(t *testing.T) {
	root := t.TempDir()
	source, output := filepath.Join(root, "input.mp4"), filepath.Join(root, "output.mp4")
	if err := os.WriteFile(source, []byte("source"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(output, []byte("existing"), 0600); err != nil {
		t.Fatal(err)
	}
	file := filePlan{source: source, output: output, relative: "input.mp4", public: ItemPlan{Action: ActionEncode}}
	balanced := configKey(file, LookStandard, QualityBalanced)
	detail := configKey(file, LookStandard, QualityDetail)
	if balanced == detail {
		t.Fatal("encoding quality must be part of resume identity")
	}
	inputHash, _ := hashFile(source)
	outputHash, _ := hashFile(output)
	previous := Report{Items: []ItemReport{{Input: file.relative, ConfigKey: balanced, InputSHA256: inputHash, OutputSHA256: outputHash, OutputVerified: true}}}
	item, err := skipExisting(context.Background(), ItemReport{Input: file.relative, ConfigKey: detail}, file, previous)
	if err != nil || !item.NeedsReview || item.OutputVerified || item.Status != StatusSkippedExisting {
		t.Fatalf("old quality output must be preserved for review: %#v, %v", item, err)
	}
	contents, err := os.ReadFile(output)
	if err != nil || string(contents) != "existing" {
		t.Fatalf("existing result was changed: %q, %v", contents, err)
	}
	file.public.Action = ActionCopy
	if configKey(file, LookStandard, QualityBalanced) != configKey(file, LookStandard, QualityDetail) {
		t.Fatal("encoding quality must not invalidate byte copies")
	}
}
