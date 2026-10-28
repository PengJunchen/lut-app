package engine

import (
	"encoding/hex"
	"fmt"
	"os"
	"strings"
)

// withPixelReference hashes the actual encoder input after color conversion.
// Both outputs share the same graph; no second LUT evaluation or raw frame
// file is needed. The private hash file is not a public output artifact.
func withPixelReference(command []string, path string) ([]string, error) {
	filterIndex, mapIndex := -1, -1
	for i := 1; i+1 < len(command); i++ {
		if command[i] == "-vf" {
			filterIndex = i
		}
		if command[i] == "-map" && mapIndex < 0 {
			mapIndex = i
		}
	}
	if filterIndex < 0 || mapIndex < 0 || path == "" {
		return nil, fmt.Errorf("cannot attach encoder pixel reference")
	}
	result := append([]string(nil), command...)
	input := result[mapIndex+1]
	if !strings.HasPrefix(input, "0:") {
		return nil, fmt.Errorf("unexpected video input for pixel reference")
	}
	result[mapIndex+1] = "[encoded]"
	result[filterIndex] = "-filter_complex"
	result[filterIndex+1] = "[" + input + "]" + result[filterIndex+1] + ",split=2[encoded][reference]"
	for i := range result {
		if result[i] == "-filter_threads" {
			result[i] = "-filter_complex_threads"
		}
	}
	return append(result, "-map", "[reference]", "-an", "-sn", "-dn", "-c:v", "rawvideo", "-pix_fmt", "yuv420p10le", "-threads:v", "1", "-fps_mode", "passthrough", "-enc_time_base:v", "demux", "-f", "hash", "-hash", "sha256", path), nil
}

func readPixelReference(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read encoder pixel reference: %w", err)
	}
	prefix, digest, ok := strings.Cut(strings.TrimSpace(string(data)), "=")
	if !ok || prefix != "SHA256" || len(digest) != 64 {
		return "", fmt.Errorf("invalid encoder pixel reference")
	}
	if _, err := hex.DecodeString(digest); err != nil {
		return "", fmt.Errorf("invalid encoder pixel reference: %w", err)
	}
	return strings.ToLower(digest), nil
}
