package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

const (
	gammaTag       = "com.dji.camera.ColorGammaSxS"
	cameraModelTag = "com.dji.camera.CameraModel"
)

type Probe struct {
	Format  ProbeFormat     `json:"format"`
	Streams []Stream        `json:"streams"`
	Raw     json.RawMessage `json:"-"`
}

type ProbeFormat struct {
	Duration string            `json:"duration"`
	BitRate  string            `json:"bit_rate"`
	Tags     map[string]string `json:"tags"`
}

type Stream struct {
	Index          int               `json:"index"`
	CodecType      string            `json:"codec_type"`
	CodecName      string            `json:"codec_name"`
	Width          int               `json:"width"`
	Height         int               `json:"height"`
	PixelFormat    string            `json:"pix_fmt"`
	ColorRange     string            `json:"color_range"`
	ColorSpace     string            `json:"color_space"`
	ColorPrimaries string            `json:"color_primaries"`
	ColorTransfer  string            `json:"color_transfer"`
	AvgFrameRate   string            `json:"avg_frame_rate"`
	RealFrameRate  string            `json:"r_frame_rate"`
	Duration       string            `json:"duration"`
	BitRate        string            `json:"bit_rate"`
	NbFrames       string            `json:"nb_frames"`
	SampleRate     string            `json:"sample_rate"`
	Channels       int               `json:"channels"`
	ChannelLayout  string            `json:"channel_layout"`
	Tags           map[string]string `json:"tags"`
	Disposition    map[string]int    `json:"disposition"`
	SideDataList   []SideData        `json:"side_data_list"`
}

type SideData struct {
	Type     string  `json:"side_data_type"`
	Rotation float64 `json:"rotation"`
}

func probeFile(ctx context.Context, path, ffprobe string) (Probe, error) {
	cmd := newCommandContext(ctx, ffprobe, "-v", "error", "-show_format", "-show_streams", "-of", "json", path)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return Probe{}, ctx.Err()
		}
		detail := strings.TrimSpace(stderr.String())
		if len(detail) > 1200 {
			detail = detail[len(detail)-1200:]
		}
		if detail != "" {
			return Probe{}, fmt.Errorf("ffprobe failed: %w: %s", err, detail)
		}
		return Probe{}, fmt.Errorf("ffprobe failed: %w", err)
	}
	var result Probe
	if err := json.Unmarshal(output, &result); err != nil {
		return Probe{}, fmt.Errorf("parse ffprobe JSON: %w", err)
	}
	result.Raw = append(json.RawMessage(nil), output...)
	return result, nil
}

func mainVideo(probe Probe) (Stream, error) {
	for _, stream := range probe.Streams {
		if strings.EqualFold(stream.CodecType, "video") && stream.Disposition["attached_pic"] == 0 {
			return stream, nil
		}
	}
	return Stream{}, fmt.Errorf("no non-attached video stream found")
}

func metadataValues(probe Probe, key string) []string {
	wanted := strings.ToLower(key)
	values := make([]string, 0, 2)
	appendTags := func(tags map[string]string) {
		for name, value := range tags {
			if strings.EqualFold(name, wanted) && strings.TrimSpace(value) != "" {
				values = append(values, strings.TrimSpace(value))
			}
		}
	}
	appendTags(probe.Format.Tags)
	for _, stream := range probe.Streams {
		appendTags(stream.Tags)
	}
	return distinctStrings(values)
}

func distinctStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	return out
}

func streamDuration(stream Stream, probe Probe) float64 {
	if seconds, err := strconv.ParseFloat(stream.Duration, 64); err == nil && seconds > 0 {
		return seconds
	}
	if seconds, err := strconv.ParseFloat(probe.Format.Duration, 64); err == nil && seconds > 0 {
		return seconds
	}
	return 0
}

func frameRate(stream Stream) float64 {
	for _, text := range []string{stream.AvgFrameRate, stream.RealFrameRate} {
		parts := strings.SplitN(text, "/", 2)
		if len(parts) == 2 {
			n, e1 := strconv.ParseFloat(parts[0], 64)
			d, e2 := strconv.ParseFloat(parts[1], 64)
			if e1 == nil && e2 == nil && d != 0 && n/d > 0 {
				return n / d
			}
		}
	}
	return 0
}

func rotationDegrees(stream Stream) (int, error) {
	var rotation float64
	found := false
	for _, side := range stream.SideDataList {
		if strings.EqualFold(side.Type, "Display Matrix") {
			rotation, found = side.Rotation, true
			break
		}
	}
	if !found {
		if value := tagValue(stream.Tags, "rotate"); value != "" {
			parsed, err := strconv.ParseFloat(value, 64)
			if err != nil {
				return 0, fmt.Errorf("invalid display rotation %q", value)
			}
			rotation = parsed
		}
	}
	angle := mathMod(rotation, 360)
	nearest := 0
	best := 361.0
	for _, candidate := range []int{0, 90, 180, 270} {
		delta := absFloat(angle - float64(candidate))
		if delta > 180 {
			delta = 360 - delta
		}
		if delta < best {
			best, nearest = delta, candidate
		}
	}
	if best > .5 {
		return 0, fmt.Errorf("unsupported non-right-angle display rotation %g degrees", rotation)
	}
	return nearest, nil
}

func tagValue(tags map[string]string, wanted string) string {
	for key, value := range tags {
		if strings.EqualFold(key, wanted) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func mathMod(v, mod float64) float64 {
	v = v - float64(int(v/mod))*mod
	if v < 0 {
		v += mod
	}
	return v
}

func absFloat(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}
