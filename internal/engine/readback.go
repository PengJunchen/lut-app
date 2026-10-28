package engine

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

type readbackResult struct {
	PixelSHA256                 string
	Frames                      int
	RequestedDecoder            string
	RetriedSoftware             bool
	AudioStreams                int
	AudioPackets                int
	AudioPacketIdentityVerified bool
	AudioPCMIdentityVerified    bool
	video                       []presentationPacket
	audio                       []readbackAudio
}

type readbackAudio struct {
	Hash       string
	Bytes      int64
	Packets    int
	First, End float64
}

func sha256Text(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, c := range value {
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func readbackCommand(ffmpeg, path, decoder string, hasAudio bool) []string {
	args := []string{ffmpeg, "-hide_banner", "-v", "error", "-xerror", "-err_detect", "explode", "-nostdin", "-copyts"}
	if decoder == "videotoolbox" {
		args = append(args, "-hwaccel", "videotoolbox")
	} else {
		args = append(args, "-hwaccel", "none")
	}
	args = append(args, "-i", path, "-filter_complex", "[0:v:0]format=yuv420p10le,split=2[bytes][pts]")
	for _, output := range []struct{ label, muxer, pipe string }{{"[bytes]", "streamhash", "pipe:1"}, {"[pts]", "framehash", "pipe:2"}} {
		args = append(args, "-map", output.label)
		if hasAudio {
			args = append(args, "-map", "0:a?")
		}
		// Streamhash's video digest is the concatenated raw YUV byte hash used
		// by the encoder reference. Audio hashes ignore packet boundaries.
		// Float64 represents the supported integer PCM widths and float PCM
		// exactly, so cross-container PCM re-packetization remains verifiable.
		args = append(args, "-fps_mode:v", "passthrough", "-enc_time_base:v", "demux", "-c:v", "rawvideo", "-threads:v", "1", "-pix_fmt", "yuv420p10le", "-c:a", "pcm_f64le", "-f", output.muxer, "-hash", "sha256", output.pipe)
	}
	return args
}

func readbackAudioFormats(command []string, tracks []Stream) []string {
	var result []string
	for i := 0; i < len(command); i++ {
		result = append(result, command[i])
		if command[i] != "-c:a" || i+1 >= len(command) {
			continue
		}
		i++
		result = append(result, command[i])
		for ordinal, track := range tracks {
			// Integer PCM64 exceeds Float64's exact integer precision. Keep its
			// full native sample width instead of rounding it through a float.
			if strings.HasPrefix(track.CodecName, "pcm_s64") || strings.HasPrefix(track.CodecName, "pcm_u64") {
				result = append(result, fmt.Sprintf("-c:a:%d", ordinal), "pcm_s64le")
			}
		}
	}
	return result
}

func parseReadbackHashes(stdout string, video bool) (string, map[int]string, error) {
	var pixel string
	audio := map[int]string{}
	for _, line := range strings.Split(strings.TrimSpace(stdout), "\n") {
		line = strings.TrimSpace(line)
		parts := strings.Split(line, ",")
		if len(parts) != 3 || !strings.HasPrefix(parts[2], "SHA256=") {
			return "", nil, fmt.Errorf("invalid decoded stream hash")
		}
		index, err := strconv.Atoi(parts[0])
		value := strings.TrimPrefix(parts[2], "SHA256=")
		if err != nil || index < 0 || index >= 256 || !sha256Text(value) {
			return "", nil, fmt.Errorf("invalid decoded audio hash")
		}
		if parts[1] == "v" {
			if !video || index != 0 || pixel != "" {
				return "", nil, fmt.Errorf("invalid export pixel hash")
			}
			pixel = value
			continue
		}
		if parts[1] != "a" || audio[index] != "" || (video && index == 0) {
			return "", nil, fmt.Errorf("invalid decoded audio hash")
		}
		audio[index] = value
	}
	if video && pixel == "" {
		return "", nil, fmt.Errorf("export pixel hash is missing")
	}
	return pixel, audio, nil
}

func parseReadbackFrames(stderr string, hashes map[int]string, expectVideo bool) (readbackResult, error) {
	type stream struct {
		base    *big.Rat
		kind    string
		facts   readbackAudio
		lastPTS float64
	}
	streams := map[int]*stream{}
	get := func(index int) *stream {
		if streams[index] == nil {
			streams[index] = &stream{}
		}
		return streams[index]
	}
	var result readbackResult
	sawHash := false
	scanner := bufio.NewScanner(strings.NewReader(stderr))
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") {
			if line == "#hash: SHA256" {
				sawHash = true
			}
			for prefix, field := range map[string]string{"#tb ": "base", "#media_type ": "kind"} {
				if strings.HasPrefix(line, prefix) {
					parts := strings.SplitN(strings.TrimPrefix(line, prefix), ":", 2)
					if len(parts) != 2 {
						return result, fmt.Errorf("malformed framehash stream header")
					}
					index, err := strconv.Atoi(strings.TrimSpace(parts[0]))
					if err != nil || index < 0 || index >= 256 {
						return result, fmt.Errorf("invalid framehash stream index")
					}
					value := strings.TrimSpace(parts[1])
					s := get(index)
					if field == "kind" {
						if s.kind != "" || (value != "video" && value != "audio") {
							return result, fmt.Errorf("invalid framehash media type")
						}
						s.kind = value
					} else {
						base, ok := new(big.Rat).SetString(value)
						if !ok || base.Sign() <= 0 || s.base != nil {
							return result, fmt.Errorf("invalid framehash time base")
						}
						s.base = base
					}
				}
			}
			continue
		}
		fields := strings.Split(line, ",")
		if len(fields) != 6 {
			return result, fmt.Errorf("unexpected export decode diagnostics")
		}
		for i := range fields {
			fields[i] = strings.TrimSpace(fields[i])
		}
		index, err := strconv.Atoi(fields[0])
		s := streams[index]
		if err != nil || s == nil || s.base == nil || s.kind == "" || !sha256Text(fields[5]) {
			return result, fmt.Errorf("invalid framehash row")
		}
		ticks, ok := new(big.Int).SetString(fields[2], 10)
		if !ok || ticks.BitLen() > 64 {
			return result, fmt.Errorf("decoded frame lacks a valid timestamp")
		}
		pts, _ := new(big.Rat).Mul(new(big.Rat).SetInt(ticks), s.base).Float64()
		durationTicks, err := strconv.ParseInt(fields[3], 10, 64)
		if err != nil || durationTicks < 0 {
			return result, fmt.Errorf("decoded frame lacks a valid duration")
		}
		duration, _ := new(big.Rat).Mul(new(big.Rat).SetInt64(durationTicks), s.base).Float64()
		size, err := strconv.ParseInt(fields[4], 10, 64)
		if err != nil || size <= 0 || math.IsNaN(pts) || math.IsInf(pts, 0) || math.IsInf(duration, 0) || math.IsInf(pts+duration, 0) ||
			(s.facts.Packets > 0 && pts <= s.lastPTS) || s.facts.Bytes > math.MaxInt64-size {
			return result, fmt.Errorf("invalid decoded frame order or size")
		}
		if s.facts.Packets == 0 {
			s.facts.First = pts
		}
		s.facts.End = pts + duration
		s.facts.Bytes += size
		s.facts.Packets++
		s.lastPTS = pts
		if s.kind == "video" {
			if !expectVideo || index != 0 {
				return result, fmt.Errorf("unexpected decoded video stream")
			}
			result.video = append(result.video, presentationPacket{PTS: strconv.FormatFloat(pts, 'g', 17, 64), Duration: strconv.FormatFloat(duration, 'g', 17, 64)})
		}
	}
	if err := scanner.Err(); err != nil {
		return result, fmt.Errorf("cannot parse framehash: %w", err)
	}
	if !sawHash || (expectVideo && len(result.video) == 0) {
		return result, fmt.Errorf("export decode returned no complete video facts")
	}
	var indices []int
	for index, s := range streams {
		if s.kind == "audio" {
			if s.base == nil || s.facts.Packets == 0 {
				return result, fmt.Errorf("audio stream did not decode completely")
			}
			indices = append(indices, index)
		}
	}
	sort.Ints(indices)
	if len(indices) != len(hashes) {
		return result, fmt.Errorf("decoded audio hash count differs")
	}
	for ordinal, index := range indices {
		hashIndex := ordinal
		if expectVideo {
			hashIndex++
		}
		hash := hashes[hashIndex]
		if hash == "" {
			return result, fmt.Errorf("decoded audio hash index differs")
		}
		facts := streams[index].facts
		facts.Hash = hash
		result.audio = append(result.audio, facts)
	}
	result.Frames, result.AudioStreams = len(result.video), len(result.audio)
	return result, nil
}

func runReadbackDecode(ctx context.Context, command []string, video bool) (readbackResult, error) {
	cmd := newCommandContext(ctx, command[0], command[1:]...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return readbackResult{}, ctx.Err()
		}
		diagnostic := stderr.String()
		if len(diagnostic) > 1800 {
			diagnostic = diagnostic[len(diagnostic)-1800:]
		}
		return readbackResult{}, fmt.Errorf("export decode failed: %w: %s", err, strings.TrimSpace(diagnostic))
	}
	pixel, audio, err := parseReadbackHashes(stdout.String(), video)
	if err != nil {
		return readbackResult{}, err
	}
	result, err := parseReadbackFrames(stderr.String(), audio, video)
	result.PixelSHA256 = pixel
	return result, err
}

func verifyExportReadback(ctx context.Context, cfg normalizedConfig, file filePlan, path string, expectedHash string) (readbackResult, error) {
	return verifyExportReadbackForPlatform(ctx, cfg, file, path, expectedHash, runtime.GOOS)
}

func verifyExportReadbackForPlatform(ctx context.Context, cfg normalizedConfig, file filePlan, path string, expectedHash, goos string) (readbackResult, error) {
	if cfg.Quality == QualityPreserve && expectedHash == "" {
		return readbackResult{}, fmt.Errorf("lossless export requires a processed reference hash")
	}
	if expectedHash != "" && !sha256Text(expectedHash) {
		return readbackResult{}, fmt.Errorf("invalid processed reference hash")
	}
	sourceTimes, err := probePresentationTimesForStream(ctx, cfg.ffprobe, file.source, strconv.Itoa(file.video.Index))
	if err != nil {
		if ctx.Err() != nil {
			return readbackResult{}, ctx.Err()
		}
		return readbackResult{}, err
	}
	origin := 0.0
	if file.probe.Format.StartTime != "" {
		origin, err = strconv.ParseFloat(file.probe.Format.StartTime, 64)
		if err != nil || math.IsNaN(origin) || math.IsInf(origin, 0) {
			return readbackResult{}, fmt.Errorf("source timeline origin is unavailable")
		}
	}
	decoder := "software"
	if goos == "darwin" && expectedHash != "" {
		decoder = "videotoolbox"
	}
	result := readbackResult{}
	for attempt := 0; attempt < 2; attempt++ {
		command := readbackCommand(cfg.ffmpeg, path, decoder, len(audioStreams(file.probe)) > 0)
		result, err = runReadbackDecode(ctx, readbackAudioFormats(command, audioStreams(file.probe)), true)
		result.RequestedDecoder = decoder
		result.RetriedSoftware = attempt > 0
		if err == nil && expectedHash != "" && result.PixelSHA256 != expectedHash {
			err = fmt.Errorf("encoded video differs from the processed YUV420p10 reference")
		}
		if err == nil {
			err = comparePresentationTimes(sourceTimes, result.video, origin, .0011)
		}
		if err == nil && result.AudioStreams != len(audioStreams(file.probe)) {
			err = fmt.Errorf("decoded audio stream count changed")
		}
		if err == nil || decoder != "videotoolbox" || ctx.Err() != nil {
			break
		}
		decoder = "software"
	}
	if err != nil {
		return result, err
	}
	if err := verifyReadbackAudio(ctx, cfg, file, path, &result, origin); err != nil {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		return result, err
	}
	return result, nil
}

type readbackPacket struct {
	Stream   int             `json:"stream_index"`
	Hash     string          `json:"data_hash"`
	PTS      string          `json:"pts_time"`
	DTS      string          `json:"dts_time"`
	Duration string          `json:"duration_time"`
	Side     json.RawMessage `json:"side_data_list"`
}

func readbackAudioPackets(ctx context.Context, ffprobe, path string) (map[int][]readbackPacket, error) {
	cmd := newCommandContext(ctx, ffprobe, "-v", "error", "-select_streams", "a", "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=stream_index,data_hash,pts_time,dts_time,duration_time:packet_side_data", "-of", "json", path)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	data, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("cannot verify copied audio packets: %w", err)
	}
	var parsed struct {
		Packets []readbackPacket `json:"packets"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, fmt.Errorf("invalid audio packet facts: %w", err)
	}
	streams := map[int][]readbackPacket{}
	for _, p := range parsed.Packets {
		if p.Stream < 0 || !strings.HasPrefix(p.Hash, "SHA256:") || !sha256Text(strings.TrimPrefix(p.Hash, "SHA256:")) {
			return nil, fmt.Errorf("audio packet payload is unverifiable")
		}
		streams[p.Stream] = append(streams[p.Stream], p)
	}
	return streams, nil
}

func readbackAudioKeys(streams map[int][]readbackPacket) []int {
	keys := make([]int, 0, len(streams))
	for key := range streams {
		keys = append(keys, key)
	}
	sort.Ints(keys)
	return keys
}

func readbackTimestampEqual(a, b string, offset, tolerance float64) bool {
	x, err := strconv.ParseFloat(a, 64)
	if err != nil || math.IsNaN(x) || math.IsInf(x, 0) {
		return false
	}
	y, err := strconv.ParseFloat(b, 64)
	return err == nil && !math.IsNaN(y) && !math.IsInf(y, 0) && math.Abs(x-offset-y) <= tolerance
}

func sameReadbackSideData(a, b json.RawMessage) bool {
	var x, y any
	if len(a) > 0 && json.Unmarshal(a, &x) != nil || len(b) > 0 && json.Unmarshal(b, &y) != nil {
		return false
	}
	return reflect.DeepEqual(x, y)
}

func verifyReadbackAudio(ctx context.Context, cfg normalizedConfig, file filePlan, path string, result *readbackResult, origin float64) error {
	tracks := audioStreams(file.probe)
	if len(tracks) == 0 {
		return nil
	}
	source, err := readbackAudioPackets(ctx, cfg.ffprobe, file.source)
	if err != nil {
		return err
	}
	output, err := readbackAudioPackets(ctx, cfg.ffprobe, path)
	if err != nil {
		return err
	}
	inputKeys, outputKeys := readbackAudioKeys(source), readbackAudioKeys(output)
	if len(inputKeys) != len(tracks) || len(outputKeys) != len(tracks) {
		return fmt.Errorf("audio packet stream count changed")
	}
	pcm := false
	for ordinal, track := range tracks {
		a, b := source[inputKeys[ordinal]], output[outputKeys[ordinal]]
		result.AudioPackets += len(b)
		if strings.HasPrefix(track.CodecName, "pcm_") {
			pcm = true
			continue
		}
		if len(a) != len(b) {
			return fmt.Errorf("copied audio packet count changed")
		}
		tolerance := .000002
		if rate, e := strconv.ParseFloat(track.SampleRate, 64); e == nil && rate > 0 {
			tolerance += 1 / rate
		}
		if strings.EqualFold(filepath.Ext(path), ".mkv") {
			tolerance = math.Max(tolerance, .0011)
		}
		for i := range a {
			if a[i].Hash != b[i].Hash || !readbackTimestampEqual(a[i].PTS, b[i].PTS, origin, tolerance) ||
				!readbackTimestampEqual(a[i].DTS, b[i].DTS, origin, tolerance) || !sameReadbackSideData(a[i].Side, b[i].Side) ||
				(a[i].Duration != "" && b[i].Duration != "" && !readbackTimestampEqual(a[i].Duration, b[i].Duration, 0, tolerance)) {
				return fmt.Errorf("copied audio packet contents or timing changed")
			}
		}
	}
	result.AudioPacketIdentityVerified = !pcm
	if !pcm {
		return nil
	}
	// PCM may be legally re-packetized across MOV/MKV. This extra source-only
	// audio decode compares complete canonical samples, byte counts and time
	// boundaries; it does not claim a single I/O pass for both input and output.
	command := []string{cfg.ffmpeg, "-hide_banner", "-v", "error", "-xerror", "-err_detect", "explode", "-nostdin", "-copyts", "-i", file.source,
		"-map", "0:a", "-c:a", "pcm_f64le", "-f", "streamhash", "-hash", "sha256", "pipe:1",
		"-map", "0:a", "-c:a", "pcm_f64le", "-f", "framehash", "-hash", "sha256", "pipe:2"}
	decoded, err := runReadbackDecode(ctx, readbackAudioFormats(command, tracks), false)
	if err != nil || len(decoded.audio) != len(result.audio) {
		return fmt.Errorf("source PCM samples could not be verified: %v", err)
	}
	for i, a := range decoded.audio {
		b := result.audio[i]
		if a.Hash != b.Hash || a.Bytes != b.Bytes || math.Abs(a.First-origin-b.First) > .0011 || math.Abs(a.End-origin-b.End) > .0011 {
			return fmt.Errorf("copied PCM samples or timing changed")
		}
	}
	result.AudioPCMIdentityVerified = true
	return nil
}
