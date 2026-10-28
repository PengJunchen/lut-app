package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func readbackFixture(hash string) (string, string) {
	return "0,v,SHA256=" + hash + "\n", "#format: frame checksums\n#version: 2\n#hash: SHA256\n#tb 0: 1/2\n#media_type 0: video\n" +
		"0, 0, 0, 1, 12288, " + hash + "\n0, 1, 1, 1, 12288, " + hash + "\n"
}

func TestExportReadbackCommandUsesOneVideoDecodeAndExactTimeBase(t *testing.T) {
	command := strings.Join(readbackCommand("ffmpeg", "result.mp4", "videotoolbox", true), " ")
	for _, want := range []string{"-xerror -err_detect explode", "-hwaccel videotoolbox -i result.mp4", "format=yuv420p10le,split=2", "-copyts", "-enc_time_base:v demux", "-f streamhash -hash sha256 pipe:1", "-f framehash -hash sha256 pipe:2", "-c:a pcm_f64le"} {
		if !strings.Contains(command, want) {
			t.Errorf("missing %q in %s", want, command)
		}
	}
	if strings.Count(command, " -i ") != 1 || strings.Count(command, "pipe:1") != 1 || strings.Contains(command, "rawvideo.yuv") {
		t.Fatal("readback must decode the output once without a raw disk intermediate")
	}
	software := strings.Join(readbackCommand("ffmpeg", "result.mp4", "software", false), " ")
	if !strings.Contains(software, "-hwaccel none") || strings.Contains(software, "videotoolbox") {
		t.Fatal("software revalidation must explicitly disable hardware decoding")
	}
	pcm64 := strings.Join(readbackAudioFormats(readbackCommand("ffmpeg", "result.mkv", "software", true), []Stream{{CodecName: "pcm_s64le"}}), " ")
	if strings.Count(pcm64, "-c:a:0 pcm_s64le") != 2 {
		t.Fatal("64-bit integer PCM must not be rounded through Float64")
	}
}

func TestExportReadbackParsesExactVideoAndAudioFacts(t *testing.T) {
	hash := strings.Repeat("a", 64)
	stdout, stderr := readbackFixture(hash)
	stdout += "1,a,SHA256=" + hash + "\n"
	stderr += "#tb 1: 1/48000\n#media_type 1: audio\n1, 0, 0, 48000, 384000, " + hash + "\n"
	pixel, hashes, err := parseReadbackHashes(stdout, true)
	if err != nil || pixel != hash {
		t.Fatalf("parse hashes: %s, %v", pixel, err)
	}
	facts, err := parseReadbackFrames(stderr, hashes, true)
	if err != nil || facts.Frames != 2 || facts.AudioStreams != 1 || facts.video[1].PTS != "0.5" || facts.audio[0].Bytes != 384000 || facts.audio[0].End != 1 {
		t.Fatalf("parsed facts: %#v, %v", facts, err)
	}
	for _, bad := range []string{strings.Replace(stderr, "#hash: SHA256", "#hash: MD5", 1), strings.Replace(stderr, "#tb 0: 1/2", "#tb 0: 0/1", 1), strings.Replace(stderr, "0, 1, 1, 1", "0, 0, 0, 1", 1), strings.Replace(stderr, "12288", "N/A", 1), stderr + "[hevc] corrupt frame\n", "#hash: SHA256\n"} {
		if _, err := parseReadbackFrames(bad, hashes, true); err == nil {
			t.Fatalf("malformed readback was accepted: %q", bad)
		}
	}
	for _, bad := range []string{"", stdout + "SHA256=" + hash, "SHA256=not-a-hash", "0,a,SHA256=" + hash} {
		if _, _, err := parseReadbackHashes(bad, true); err == nil {
			t.Fatalf("malformed hashes were accepted: %q", bad)
		}
	}
}

func readbackExecutable(t *testing.T, root, name, script string) string {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

func readbackProbe(t *testing.T, root, inputAudio, outputAudio string) string {
	t.Helper()
	if inputAudio == "" {
		inputAudio, outputAudio = `{"packets":[]}`, `{"packets":[]}`
	}
	return readbackExecutable(t, root, "ffprobe", fmt.Sprintf("printf '%%s\\n' \"$*\" >>\"$0.calls\"\nfor last; do :; done\ncase \" $* \" in\n*' -select_streams a '*) case \"$last\" in *source.mp4) printf '%%s' '%s';; *) printf '%%s' '%s';; esac;;\n*) printf '%%s' '{\"packets\":[{\"pts_time\":\"0\",\"duration_time\":\"0.5\"},{\"pts_time\":\"0.5\",\"duration_time\":\"0.5\"}]}' ;;\nesac\n", inputAudio, outputAudio))
}

func TestExportReadbackRequiresPreserveReferenceAndSelectsMainVideo(t *testing.T) {
	if _, err := verifyExportReadbackForPlatform(context.Background(), normalizedConfig{Config: Config{Quality: QualityPreserve}}, filePlan{}, "output.mp4", "", "darwin"); err == nil {
		t.Fatal("lossless export without an encoder reference was accepted")
	}
	if runtime.GOOS == "windows" {
		t.Skip("POSIX subprocess fixture")
	}
	root := t.TempDir()
	hash := strings.Repeat("a", 64)
	stdout, stderr := readbackFixture(hash)
	ffmpeg := readbackExecutable(t, root, "ffmpeg", fmt.Sprintf("printf '%%s\\n' \"$*\" >>\"$0.calls\"\nprintf '%%s' '%s'\nprintf '%%s' '%s' >&2\n", stdout, stderr))
	probe := readbackProbe(t, root, "", "")
	cfg := normalizedConfig{ffmpeg: ffmpeg, ffprobe: probe}
	file := filePlan{source: filepath.Join(root, "source.mp4"), video: Stream{Index: 2}}
	facts, err := verifyExportReadbackForPlatform(context.Background(), cfg, file, "out.mp4", "", "darwin")
	if err != nil || facts.RequestedDecoder != "software" || facts.RetriedSoftware {
		t.Fatalf("readback without a pixel reference: %#v, %v", facts, err)
	}
	probes, _ := os.ReadFile(probe + ".calls")
	decodes, _ := os.ReadFile(ffmpeg + ".calls")
	if !strings.Contains(string(probes), "-select_streams 2") || strings.Contains(string(decodes), "-hwaccel videotoolbox") {
		t.Fatalf("wrong source selection or unverified decoder: %s; %s", probes, decodes)
	}
}

func TestExportReadbackRetriesOnlyFailedHardwareCandidate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX subprocess fixtures")
	}
	good, bad := strings.Repeat("a", 64), strings.Repeat("b", 64)
	for _, mode := range []string{"success", "hardware-error", "hardware-mismatch", "software-mismatch", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			stdout, stderr := readbackFixture(good)
			script := "printf '%s\\n' \"$*\" >>\"$0.calls\"\n"
			if mode == "cancel" {
				script += "exec /bin/sleep 30\n"
			} else {
				if mode == "hardware-error" {
					script += "case \" $* \" in *' -hwaccel videotoolbox '*) exit 7;; esac\n"
				}
				if mode == "hardware-mismatch" {
					script += fmt.Sprintf("case \" $* \" in *' -hwaccel videotoolbox '*) printf '%%s' '%s'; printf '%%s' '%s' >&2; exit 0;; esac\n", strings.Replace(stdout, good, bad, 1), stderr)
				}
				if mode == "software-mismatch" {
					stdout = strings.Replace(stdout, good, bad, 1)
				}
				script += fmt.Sprintf("printf '%%s' '%s'\nprintf '%%s' '%s' >&2\n", stdout, stderr)
			}
			ffmpeg := readbackExecutable(t, root, "ffmpeg", script)
			cfg := normalizedConfig{ffmpeg: ffmpeg, ffprobe: readbackProbe(t, root, "", "")}
			file := filePlan{source: filepath.Join(root, "source.mp4"), probe: Probe{Format: ProbeFormat{StartTime: "0"}}}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if mode == "cancel" {
				stop := make(chan struct{})
				defer close(stop)
				go func() {
					ticker := time.NewTicker(5 * time.Millisecond)
					defer ticker.Stop()
					for {
						select {
						case <-stop:
							return
						case <-ticker.C:
							if _, err := os.Stat(ffmpeg + ".calls"); err == nil {
								cancel()
								return
							}
						}
					}
				}()
			}
			result, err := verifyExportReadbackForPlatform(ctx, cfg, file, filepath.Join(root, "output.mp4"), good, "darwin")
			if mode == "software-mismatch" || mode == "cancel" {
				if err == nil {
					t.Fatal("failed readback was accepted")
				}
				if mode == "cancel" && !errors.Is(err, context.Canceled) {
					t.Fatalf("cancellation did not propagate: %v", err)
				}
			} else if err != nil || result.PixelSHA256 != good || result.Frames != 2 {
				t.Fatalf("successful readback: %#v, %v", result, err)
			}
			calls, _ := os.ReadFile(ffmpeg + ".calls")
			lines := strings.Split(strings.TrimSpace(string(calls)), "\n")
			want := 1
			if mode == "hardware-error" || mode == "hardware-mismatch" || mode == "software-mismatch" {
				want = 2
				if !result.RetriedSoftware || result.RequestedDecoder != "software" || !strings.Contains(lines[1], "-hwaccel none") {
					t.Fatalf("wrong software retry: %#v, %s", result, calls)
				}
			}
			if len(lines) != want {
				t.Fatalf("decode calls: %d; want %d", len(lines), want)
			}
		})
	}
}

func TestExportReadbackCompressedAudioRejectsChangedPacketFacts(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX subprocess fixtures")
	}
	hash := "SHA256:" + strings.Repeat("c", 64)
	packet := readbackPacket{Stream: 3, Hash: hash, PTS: "0", DTS: "0", Duration: "1", Side: json.RawMessage(`[{"side_data_type":"Skip Samples","skip_samples":2,"discard_padding":0}]`)}
	encode := func(p readbackPacket) string {
		data, _ := json.Marshal(map[string]any{"packets": []readbackPacket{p}})
		return string(data)
	}
	for _, kind := range []string{"same", "hash", "timestamp", "padding", "count"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			changed := packet
			changed.Stream = 1
			if kind == "hash" {
				changed.Hash = "SHA256:" + strings.Repeat("d", 64)
			}
			if kind == "timestamp" {
				changed.PTS = "0.01"
			}
			if kind == "padding" {
				changed.Side = nil
			}
			output := encode(changed)
			if kind == "count" {
				output = `{"packets":[]}`
			}
			cfg := normalizedConfig{ffprobe: readbackProbe(t, root, encode(packet), output)}
			file := filePlan{source: filepath.Join(root, "source.mp4"), probe: Probe{Streams: []Stream{{CodecType: "audio", CodecName: "aac", SampleRate: "48000"}}}}
			result := readbackResult{}
			err := verifyReadbackAudio(context.Background(), cfg, file, filepath.Join(root, "out.mp4"), &result, 0)
			if (err == nil) != (kind == "same") || kind == "same" && !result.AudioPacketIdentityVerified {
				t.Fatalf("audio %s: %#v, %v", kind, result, err)
			}
		})
	}
}

func TestExportReadbackPCMAllowsRepacketizationOnlyWithIdenticalSamples(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX subprocess fixtures")
	}
	hash := strings.Repeat("d", 64)
	for _, changed := range []bool{false, true} {
		root := t.TempDir()
		input := `{"packets":[{"stream_index":1,"data_hash":"SHA256:` + hash + `","pts_time":"0","dts_time":"0"}]}`
		output := `{"packets":[{"stream_index":1,"data_hash":"SHA256:` + hash + `","pts_time":"0","dts_time":"0"},{"stream_index":1,"data_hash":"SHA256:` + hash + `","pts_time":"0.5","dts_time":"0.5"}]}`
		stdout := "0,a,SHA256=" + hash + "\n"
		stderr := "#hash: SHA256\n#tb 0: 1/48000\n#media_type 0: audio\n0, 0, 0, 48000, 384000, " + hash + "\n"
		ffmpeg := readbackExecutable(t, root, "ffmpeg", fmt.Sprintf("printf '%%s' '%s'\nprintf '%%s' '%s' >&2\n", stdout, stderr))
		cfg := normalizedConfig{ffmpeg: ffmpeg, ffprobe: readbackProbe(t, root, input, output)}
		file := filePlan{source: filepath.Join(root, "source.mp4"), probe: Probe{Streams: []Stream{{CodecType: "audio", CodecName: "pcm_s24le"}}}}
		result := readbackResult{audio: []readbackAudio{{Hash: hash, Bytes: 384000, Packets: 2, First: 0, End: 1}}}
		if changed {
			result.audio[0].Hash = strings.Repeat("e", 64)
		}
		err := verifyReadbackAudio(context.Background(), cfg, file, filepath.Join(root, "out.mkv"), &result, 0)
		if (err == nil) != !changed || !changed && (!result.AudioPCMIdentityVerified || result.AudioPacketIdentityVerified) {
			t.Fatalf("PCM changed=%v: %#v, %v", changed, result, err)
		}
	}
}

func TestExportReadbackRealAudioTransfers(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("FFmpeg is not installed")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("FFprobe is not installed")
	}
	encoders, err := queryEncoders(context.Background(), ffmpeg)
	if err != nil || !encoders["libx265"] {
		t.Skip("FFmpeg does not provide libx265")
	}
	for _, pcm := range []bool{false, true} {
		t.Run(fmt.Sprintf("pcm=%v", pcm), func(t *testing.T) {
			root := t.TempDir()
			codec, inputExtension, outputExtension := "aac", ".mp4", ".mp4"
			if pcm {
				codec, inputExtension, outputExtension = "pcm_s24le", ".mov", ".mkv"
			}
			source, output := filepath.Join(root, "source"+inputExtension), filepath.Join(root, "output"+outputExtension)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			generate := newCommandContext(ctx, ffmpeg, "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=30:duration=0.2", "-f", "lavfi", "-i", "sine=sample_rate=48000:duration=0.2", "-map", "0:v", "-map", "1:a", "-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-x265-params", "lossless=1:bframes=0:pools=1:frame-threads=1:log-level=error", "-c:a", codec, source)
			if data, err := generate.CombinedOutput(); err != nil {
				t.Fatalf("generate fixture: %v: %s", err, data)
			}
			remux := newCommandContext(ctx, ffmpeg, "-v", "error", "-nostdin", "-y", "-i", source, "-map", "0:v", "-map", "0:a", "-c", "copy", output)
			if data, err := remux.CombinedOutput(); err != nil {
				t.Fatalf("remux fixture: %v: %s", err, data)
			}
			probe, err := probeFile(ctx, source, ffprobe)
			if err != nil {
				t.Fatal(err)
			}
			command := newCommandContext(ctx, ffmpeg, "-v", "error", "-nostdin", "-hwaccel", "none", "-i", source, "-map", "0:v:0", "-an", "-c:v", "rawvideo", "-pix_fmt", "yuv420p10le", "-f", "hash", "-hash", "sha256", "pipe:1")
			data, err := command.Output()
			if err != nil {
				t.Fatal(err)
			}
			expected := strings.TrimSpace(strings.TrimPrefix(string(data), "SHA256="))
			cfg := normalizedConfig{ffmpeg: ffmpeg, ffprobe: ffprobe}
			facts, err := verifyExportReadbackForPlatform(ctx, cfg, filePlan{source: source, probe: probe}, output, expected, "linux")
			if err != nil || facts.Frames != 6 || facts.AudioStreams != 1 || facts.PixelSHA256 != expected || (pcm && !facts.AudioPCMIdentityVerified) || (!pcm && !facts.AudioPacketIdentityVerified) {
				t.Fatalf("actual audio transfer: %#v, %v", facts, err)
			}
		})
	}
}
