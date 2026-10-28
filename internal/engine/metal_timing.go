package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
)

type presentationPacket struct {
	PTS      string `json:"pts_time"`
	Duration string `json:"duration_time"`
}

func probePresentationTimes(ctx context.Context, ffprobe, path string) ([]presentationPacket, error) {
	return probePresentationTimesForStream(ctx, ffprobe, path, "v:0")
}

func probePresentationTimesForStream(ctx context.Context, ffprobe, path, selector string) ([]presentationPacket, error) {
	cmd := newCommandContext(ctx, ffprobe, "-v", "error", "-select_streams", selector, "-show_packets", "-show_entries", "packet=pts_time,duration_time", "-of", "json", path)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	data, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("cannot verify Metal frame timing: %w", err)
	}
	var result struct {
		Packets []presentationPacket `json:"packets"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("invalid frame timing: %w", err)
	}
	return result.Packets, nil
}

func comparePresentationTimes(source, output []presentationPacket, origin, tolerance float64) error {
	if len(source) == 0 || len(source) != len(output) {
		return fmt.Errorf("Metal frame count differs: %d versus %d", len(source), len(output))
	}
	type timing struct{ pts, duration float64 }
	parse := func(packets []presentationPacket) ([]timing, error) {
		times := make([]timing, len(packets))
		for i, p := range packets {
			pts, err := strconv.ParseFloat(p.PTS, 64)
			if err != nil || math.IsNaN(pts) || math.IsInf(pts, 0) {
				return nil, fmt.Errorf("Metal frame timestamp unavailable")
			}
			duration, _ := strconv.ParseFloat(p.Duration, 64)
			times[i] = timing{pts, duration}
		}
		sort.Slice(times, func(i, j int) bool { return times[i].pts < times[j].pts })
		return times, nil
	}
	a, err := parse(source)
	if err != nil {
		return err
	}
	b, err := parse(output)
	if err != nil {
		return err
	}
	for i := range a {
		if math.Abs(a[i].pts-origin-b[i].pts) > tolerance ||
			(a[i].duration > 0 && b[i].duration > 0 && math.Abs(a[i].duration-b[i].duration) > tolerance) {
			return fmt.Errorf("Metal presentation timing differs at frame %d", i)
		}
	}
	return nil
}

func validateMetalPresentationTimes(ctx context.Context, cfg normalizedConfig, file filePlan, path string) error {
	source, err := probePresentationTimesForStream(ctx, cfg.ffprobe, file.source, strconv.Itoa(file.video.Index))
	if err != nil {
		return err
	}
	output, err := probePresentationTimes(ctx, cfg.ffprobe, path)
	if err != nil {
		return err
	}
	origin, err := strconv.ParseFloat(file.probe.Format.StartTime, 64)
	if err != nil {
		return err
	}
	// Matroska time bases round packet timestamps to milliseconds.
	return comparePresentationTimes(source, output, origin, .0011)
}
