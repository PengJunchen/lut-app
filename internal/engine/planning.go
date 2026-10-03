package engine

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type filePlan struct {
	public        ItemPlan
	source        string
	output        string
	relative      string
	probe         Probe
	hasProbe      bool
	video         Stream
	profile       string
	camera        string
	gamma         string
	lut           *LUTSpec
	rotation      int
	inputRange    string
	inputMatrix   string
	encoder       EncoderMode
	duration      float64
	sourceSize    int64
	sourceModTime time.Time
}

func Scan(ctx context.Context, config Config) (*Plan, error) {
	ncfg, err := normalizeConfig(config)
	if err != nil {
		return nil, err
	}
	files, err := scanFiles(ctx, ncfg)
	if err != nil {
		return nil, err
	}
	result := &Plan{InputRoot: ncfg.inputAbs, OutputRoot: ncfg.outputRoot, Look: ncfg.Look, Items: make([]ItemPlan, 0, len(files))}
	for _, file := range files {
		result.Items = append(result.Items, file.public)
	}
	return result, nil
}

func scanFiles(ctx context.Context, cfg normalizedConfig) ([]filePlan, error) {
	catalog, err := catalogFor(cfg)
	if err != nil {
		return nil, err
	}
	paths, err := discoverVideos(cfg)
	if err != nil {
		return nil, fmt.Errorf("scan input directory: %w", err)
	}
	lookup := make(map[string]LUTSpec, len(catalog))
	for _, entry := range catalog {
		lookup[catalogKey(entry.Camera, entry.Profile, entry.Look)] = entry
	}
	type verification struct {
		grid   int
		digest string
		err    error
	}
	verified := make(map[string]verification)
	var out []filePlan
	for pathIndex, path := range paths {
		if err := ctx.Err(); err != nil {
			for _, remaining := range paths[pathIndex:] {
				rel, relErr := filepath.Rel(cfg.inputAbs, remaining)
				if relErr != nil {
					continue
				}
				rel = filepath.ToSlash(rel)
				st, _ := os.Stat(remaining)
				size := int64(0)
				modTime := time.Time{}
				if st != nil {
					size, modTime = st.Size(), st.ModTime()
				}
				out = append(out, filePlan{
					source: remaining, output: filepath.Join(cfg.outputRoot, filepath.FromSlash(rel)), relative: rel,
					sourceSize: size, sourceModTime: modTime,
					public: ItemPlan{Input: rel, Output: rel, Action: ActionCopy, Status: StatusNeedsReview, Bytes: size, Reason: "scan cancelled before metadata classification"},
				})
			}
			return out, err
		}
		rel, err := filepath.Rel(cfg.inputAbs, path)
		if err != nil {
			return nil, err
		}
		rel = filepath.ToSlash(rel)
		st, statErr := os.Stat(path)
		var size int64
		if statErr == nil {
			size = st.Size()
		}
		copyOutput := filepath.Join(cfg.outputRoot, filepath.FromSlash(rel))
		fp := filePlan{source: path, output: copyOutput, relative: rel, sourceSize: size, public: ItemPlan{Input: rel, Output: filepath.ToSlash(rel), Action: ActionCopy, Status: StatusNeedsReview, Bytes: size}}
		if statErr == nil {
			fp.sourceModTime = st.ModTime()
		}
		probe, probeErr := probeFile(ctx, path, cfg.ffprobe)
		if probeErr != nil {
			if ctx.Err() != nil {
				fp.public.Reason = "scan cancelled during ffprobe; file was not classified"
				out = append(out, fp)
				continue
			}
			fp.public.Reason = "ffprobe could not classify this file: " + probeErr.Error()
			out = append(out, fp)
			continue
		}
		fp.probe, fp.hasProbe = probe, true
		gamma := classifyGamma(probe)
		fp.gamma = gamma.raw
		fp.public.Gamma = gamma.raw
		if gamma.kind == "nonlog" || gamma.kind == "hdr" {
			fp.public.Status = StatusCopiedNonLog
			if gamma.kind == "hdr" {
				fp.public.Status = StatusCopiedHDR
			}
			fp.public.Reason = gamma.reason
			out = append(out, fp)
			continue
		}
		if gamma.kind != "log" {
			fp.public.Reason = gamma.reason
			out = append(out, fp)
			continue
		}
		fp.profile = gamma.profile
		fp.public.Profile = gamma.profile
		video, videoErr := mainVideo(probe)
		if videoErr != nil {
			fp.public.Reason = videoErr.Error()
			out = append(out, fp)
			continue
		}
		fp.video = video
		camera, cameraSource, cameraErr := resolveCamera(probe)
		if cameraErr != nil {
			fp.public.Reason = cameraErr.Error()
			out = append(out, fp)
			continue
		}
		fp.camera = camera
		fp.public.Camera = camera
		entry, ok := lookup[catalogKey(camera, gamma.profile, cfg.Look)]
		if !ok {
			fp.public.Reason = fmt.Sprintf("no LUT configured for camera=%s profile=%s look=%s; copied for review", camera, gamma.profile, cfg.Look)
			out = append(out, fp)
			continue
		}
		stat, statErr := os.Stat(entry.File)
		cacheKey := entry.File + "|" + entry.SHA256 + "|" + fmt.Sprint(entry.Grid)
		if statErr == nil {
			cacheKey += fmt.Sprintf("|%d|%d", stat.Size(), stat.ModTime().UnixNano())
		}
		verificationResult, cached := verified[cacheKey]
		if !cached {
			verificationResult.grid, verificationResult.digest, verificationResult.err = verifyCube(entry.File, entry.Grid, entry.SHA256)
			verified[cacheKey] = verificationResult
		}
		grid, digest, verifyErr := verificationResult.grid, verificationResult.digest, verificationResult.err
		if verifyErr != nil {
			fp.public.LUTFile = entry.File
			fp.public.LUTSHA256 = digest
			fp.public.Reason = fmt.Sprintf("matching LUT is unavailable or invalid (%v); copied for review", verifyErr)
			out = append(out, fp)
			continue
		}
		_ = grid
		fp.lut = &entry
		fp.public.LUTFile = entry.File
		fp.public.LUTSHA256 = digest
		fp.rotation, err = rotationDegrees(video)
		if err != nil {
			fp.public.Reason = fmt.Sprintf("%v; copied for review", err)
			out = append(out, fp)
			continue
		}
		fp.inputRange, err = resolveRange(video.ColorRange)
		if err != nil {
			fp.public.Reason = fmt.Sprintf("%v; copied for review", err)
			out = append(out, fp)
			continue
		}
		fp.inputMatrix, err = resolveMatrix(video.ColorSpace)
		if err != nil {
			fp.public.Reason = fmt.Sprintf("%v; copied for review", err)
			out = append(out, fp)
			continue
		}
		baseName := filepath.Base(rel)
		outRel := filepath.Join(filepath.Dir(filepath.FromSlash(rel)), baseName+".Rec709.mp4")
		if filepath.Dir(filepath.FromSlash(rel)) == "." {
			outRel = baseName + ".Rec709.mp4"
		}
		fp.output = filepath.Join(cfg.outputRoot, outRel)
		fp.public.Output = filepath.ToSlash(outRel)
		fp.public.Action = ActionEncode
		fp.public.Status = StatusPlannedEncode
		fp.public.Encoder = string(cfg.Encoder)
		fp.public.Reason = "exact DJI gamma metadata, camera evidence, and matching LUT"
		_ = cameraSource
		fp.duration = streamDuration(video, probe)
		out = append(out, fp)
	}
	return out, nil
}

func catalogFor(cfg normalizedConfig) ([]LUTSpec, error) {
	if len(cfg.Manifest) > 0 {
		return normalizeCatalog(append([]LUTSpec(nil), cfg.Manifest...), cfg.lutDirAbs, "")
	}
	return LoadCatalog(cfg.ManifestPath, cfg.lutDirAbs)
}

func catalogKey(camera, profile string, look Look) string {
	return strings.ToLower(strings.TrimSpace(camera)) + "\x00" + normalizeProfile(profile) + "\x00" + strings.ToLower(strings.TrimSpace(string(look)))
}

func resolveRange(value string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "tv", "limited", "mpeg":
		return "tv", nil
	case "pc", "full", "jpeg":
		return "pc", nil
	default:
		return "", fmt.Errorf("video color_range is missing or unsupported (%q); copied for review", value)
	}
}

var matrixNames = map[string]bool{
	"bt709": true, "bt601": true, "bt470": true, "bt470bg": true, "smpte170m": true,
	"fcc": true, "smpte240m": true, "bt2020": true, "bt2020nc": true,
}

func resolveMatrix(value string) (string, error) {
	matrix := strings.ToLower(strings.TrimSpace(value))
	if !matrixNames[matrix] {
		return "", fmt.Errorf("video color_space matrix is missing or unsupported (%q); copied for review", value)
	}
	return matrix, nil
}
