package engine

import (
	"context"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

func metalSupported(goos, goarch string) bool {
	return goos == "darwin" && goarch == "arm64"
}

func logMetalFallback(path, reason string) {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return
	}
	log, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err == nil {
		defer log.Close()
		_, _ = fmt.Fprintln(log, "Metal LUT fallback:", reason)
	}
}

func metalHelper(cfg normalizedConfig) (string, error) {
	if !metalSupported(runtime.GOOS, runtime.GOARCH) {
		return "", fmt.Errorf("Metal LUT requires Apple Silicon")
	}
	// The helper is extracted with the verified runtime, alongside FFmpeg.
	path := filepath.Join(filepath.Dir(cfg.ffmpeg), "metal-lut")
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&0111 == 0 {
		return "", fmt.Errorf("Metal LUT helper is unavailable")
	}
	return path, nil
}

func inputColorFilter(file filePlan) string {
	return fmt.Sprintf("scale=in_color_matrix=%s:out_color_matrix=bt709:in_range=%s:out_range=pc:flags=accurate_rnd+full_chroma_int,format=gbrpf32le", file.inputMatrix, file.inputRange)
}

const outputColorFilter = "scale=in_color_matrix=bt709:out_color_matrix=bt709:in_range=pc:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p10le"

const metalOutputFilter = outputColorFilter + ",setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709"

func buildMetalCommands(cfg normalizedConfig, file filePlan, temp string, encoder EncoderMode) ([]string, []string) {
	decode := []string{cfg.ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-loglevel", "warning", "-copyts", "-hwaccel", "auto", "-i", file.source,
		"-map", fmt.Sprintf("0:%d", file.video.Index), "-an", "-map_metadata", "-1", "-map_chapters", "-1",
		"-filter_threads", strconv.Itoa(cfg.filterThreads), "-vf", strings.Replace(inputColorFilter(file), "gbrpf32le", "gbrp16le", 1), "-fps_mode", "passthrough",
		"-c:v", "rawvideo", "-f", "nut", "-write_index", "0", "pipe:1"}
	// Use the normal output policy, including the original quality setting and
	// audio stream copies. Read audio directly from the source: an intermediate
	// container can lose AAC trailing-packet duration/skip-samples information.
	// copyts and the common source-origin offset retain video/audio offsets even
	// for VFR inputs, delayed video and nonzero container start times.
	base := buildFFmpegCommand(cfg, file, temp, encoder)
	origin, _ := strconv.ParseFloat(file.probe.Format.StartTime, 64)
	offset := strconv.FormatFloat(-origin, 'f', 9, 64)
	var encode []string
	for i := 0; i < len(base); i++ {
		arg := base[i]
		if arg == "-hwaccel" {
			i++
			continue
		}
		if i+1 < len(base) {
			value := base[i+1]
			switch {
			case arg == "-i":
				encode = append(encode, "-itsoffset", offset, "-f", "nut", "-i", "pipe:0", "-itsoffset", offset, "-i", value)
				i++
				continue
			case arg == "-vf":
				encode = append(encode, arg, metalOutputFilter)
				i++
				continue
			case arg == "-map" && value == fmt.Sprintf("0:%d", file.video.Index):
				encode = append(encode, arg, "0:v:0")
				i++
				continue
			case arg == "-map" && value == "0:a?":
				encode = append(encode, arg, "1:a?")
				i++
				continue
			case arg == "-map_metadata" || arg == "-map_chapters":
				encode = append(encode, arg, "1")
				i++
				continue
			case strings.HasPrefix(arg, "-map_metadata:s:"):
				encode = append(encode, arg, "1:"+strings.TrimPrefix(value, "0:"))
				i++
				continue
			}
		}
		encode = append(encode, arg)
	}
	// Apply the origin before encoder-time-base rounding, just as the normal
	// single-input path does. A final mux offset would introduce a second
	// rounding step for fractional/nonzero source start times.
	encode = append([]string{cfg.ffmpeg, "-copyts"}, encode[1:]...)
	return decode, encode
}

func runMetalFFmpeg(ctx context.Context, cfg normalizedConfig, file filePlan, temp string, encoder EncoderMode, progress func(float64), logPath string) (string, error) {
	helper, err := metalHelper(cfg)
	if err != nil {
		return "", err
	}
	origin, err := strconv.ParseFloat(file.probe.Format.StartTime, 64)
	if err != nil || math.IsNaN(origin) || math.IsInf(origin, 0) {
		return "", fmt.Errorf("Metal LUT requires a known source timeline origin")
	}
	if err := os.MkdirAll(filepath.Dir(logPath), 0755); err != nil {
		return "", err
	}
	log, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return "", err
	}
	defer log.Close()
	_, _ = io.WriteString(log, "Using experimental Metal LUT; FFmpeg chroma resampling retained\n")
	childCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	decodeCommand, encodeCommand := buildMetalCommands(cfg, file, temp, encoder)
	decoder := newCommandContext(childCtx, decodeCommand[0], decodeCommand[1:]...)
	width, height := file.video.Width, file.video.Height
	if file.rotation == 90 || file.rotation == 270 {
		width, height = height, width
	}
	gpu := newCommandContext(childCtx, helper, file.lut.File, strconv.Itoa(width), strconv.Itoa(height))
	toGPU, fromDecoder, err := metalFramePipe()
	if err != nil {
		return "", err
	}
	defer toGPU.Close()
	defer fromDecoder.Close()
	toEncoder, fromGPU, err := metalFramePipe()
	if err != nil {
		return "", err
	}
	defer toEncoder.Close()
	defer fromGPU.Close()
	decoder.Stdout, decoder.Stderr = fromDecoder, log
	gpu.Stdin, gpu.Stdout, gpu.Stderr = toGPU, fromGPU, log
	if err := gpu.Start(); err != nil {
		return "", fmt.Errorf("start Metal LUT: %w", err)
	}
	// The children own their pipe ends once started. Closing parent duplicates
	// ensures every failure/cancellation propagates EOF instead of hanging.
	_ = toGPU.Close()
	_ = fromGPU.Close()
	if err := decoder.Start(); err != nil {
		cancel()
		_ = fromDecoder.Close()
		_ = toEncoder.Close()
		_ = gpu.Wait()
		return "", fmt.Errorf("start Metal decoder: %w", err)
	}
	_ = fromDecoder.Close()
	tail, encodeErr := runFFmpegInput(childCtx, encodeCommand, file.duration, progress, logPath, toEncoder)
	_ = toEncoder.Close()
	// Successful consumers have already read EOF. Allow producer shutdown to
	// finish naturally instead of racing a kill against a successful exit.
	cleanup := time.AfterFunc(5*time.Second, cancel)
	defer cleanup.Stop()
	if encodeErr != nil {
		cancel()
	}
	gpuErr, decodeErr := gpu.Wait(), decoder.Wait()
	if ctx.Err() != nil {
		return tail, ctx.Err()
	}
	if gpuErr != nil || decodeErr != nil {
		return tail, fmt.Errorf("Metal pipeline failed (decoder: %v, LUT: %v, encoder: %v)", decodeErr, gpuErr, encodeErr)
	}
	return tail, encodeErr
}
