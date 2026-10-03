package engine

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func (c Config) Validate() error {
	_, err := normalizeConfig(c)
	return err
}

type normalizedConfig struct {
	Config
	inputAbs      string
	baseOutput    string
	outputRoot    string
	lutDirAbs     string
	ffmpeg        string
	ffprobe       string
	workers       int
	filterThreads int
	crf           int
	preset        string
}

func normalizeConfig(c Config) (normalizedConfig, error) {
	if strings.TrimSpace(c.Input) == "" {
		return normalizedConfig{}, errors.New("input directory is required")
	}
	inputAbs, err := filepath.Abs(filepath.Clean(c.Input))
	if err != nil {
		return normalizedConfig{}, fmt.Errorf("resolve input directory: %w", err)
	}
	inputInfo, err := os.Stat(inputAbs)
	if err != nil || !inputInfo.IsDir() {
		if err != nil {
			return normalizedConfig{}, fmt.Errorf("input directory is unavailable: %w", err)
		}
		return normalizedConfig{}, fmt.Errorf("input path is not a directory: %s", inputAbs)
	}
	look := c.Look
	if look == "" {
		look = LookStandard
	}
	if look != LookStandard && look != LookVivid {
		return normalizedConfig{}, fmt.Errorf("unsupported look %q (expected standard or vivid)", look)
	}
	encoder := c.Encoder
	if encoder == "" {
		encoder = EncoderAuto
	}
	if encoder != EncoderAuto && encoder != EncoderVideoToolbox && encoder != EncoderX265 {
		return normalizedConfig{}, fmt.Errorf("unsupported encoder %q", encoder)
	}
	baseOutput := strings.TrimSpace(c.Output)
	if baseOutput == "" {
		baseOutput = filepath.Join(inputAbs, "Output")
	}
	baseOutput, err = filepath.Abs(filepath.Clean(baseOutput))
	if err != nil {
		return normalizedConfig{}, fmt.Errorf("resolve output directory: %w", err)
	}
	if samePath(baseOutput, inputAbs) || isAncestor(baseOutput, inputAbs) {
		return normalizedConfig{}, errors.New("output directory cannot be the input directory or one of its parents")
	}
	outputRoot := filepath.Join(baseOutput, titleCaseLook(look))
	workers := c.Workers
	if workers <= 0 {
		workers = 2
	}
	if workers > 6 {
		workers = 6
	}
	filterThreads := c.FilterThreads
	if filterThreads <= 0 {
		filterThreads = 6
	}
	crf := c.CRF
	if crf <= 0 {
		crf = 16
	}
	preset := c.Preset
	if preset == "" {
		preset = "medium"
	}
	ffmpeg := c.FFmpeg
	if ffmpeg == "" {
		ffmpeg = "ffmpeg"
	}
	ffprobe := c.FFprobe
	if ffprobe == "" {
		ffprobe = "ffprobe"
	}
	lutDir := strings.TrimSpace(c.LUTDir)
	if lutDir == "" {
		executable, exeErr := os.Executable()
		if exeErr == nil {
			lutDir = filepath.Join(filepath.Dir(executable), "luts")
		} else {
			lutDir = "luts"
		}
	}
	lutDirAbs, err := filepath.Abs(filepath.Clean(lutDir))
	if err != nil {
		return normalizedConfig{}, fmt.Errorf("resolve LUT directory: %w", err)
	}
	c.Look = look
	c.Encoder = encoder
	c.Workers = workers
	c.FilterThreads = filterThreads
	c.CRF = crf
	c.Preset = preset
	c.Output = baseOutput
	c.LUTDir = lutDirAbs
	return normalizedConfig{
		Config: c, inputAbs: inputAbs, baseOutput: baseOutput,
		outputRoot: outputRoot, lutDirAbs: lutDirAbs, ffmpeg: ffmpeg,
		ffprobe: ffprobe, workers: workers, filterThreads: filterThreads,
		crf: crf, preset: preset,
	}, nil
}

func titleCaseLook(look Look) string {
	if look == LookVivid {
		return "Vivid"
	}
	return "Standard"
}

func samePath(a, b string) bool {
	return filepath.Clean(a) == filepath.Clean(b)
}

func isAncestor(parent, child string) bool {
	rel, err := filepath.Rel(parent, child)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func defaultEncoder(cfg normalizedConfig, available map[string]bool) (EncoderMode, error) {
	if cfg.Encoder == EncoderX265 {
		if !available["libx265"] {
			return "", errors.New("ffmpeg does not provide libx265")
		}
		return EncoderX265, nil
	}
	if cfg.Encoder == EncoderVideoToolbox {
		if !available["hevc_videotoolbox"] {
			return "", errors.New("ffmpeg does not provide hevc_videotoolbox")
		}
		return EncoderVideoToolbox, nil
	}
	if runtime.GOOS == "darwin" && available["hevc_videotoolbox"] {
		return EncoderVideoToolbox, nil
	}
	if available["libx265"] {
		return EncoderX265, nil
	}
	return "", errors.New("auto encoder requires hevc_videotoolbox on macOS or libx265")
}
