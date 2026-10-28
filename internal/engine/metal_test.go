package engine

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestMetalPipePreservesColorAndOutputPolicy(t *testing.T) {
	file := filePlan{source: "source.mov", output: "result.mp4", video: Stream{Index: 2, Width: 3840, Height: 2160}, inputMatrix: "bt2020", inputRange: "tv", lut: &LUTSpec{File: "restore.cube"}, probe: Probe{Streams: []Stream{{Index: 4, CodecType: "audio"}}}}
	cfg := normalizedConfig{Config: Config{Metal: true, Quality: QualityDetail}, ffmpeg: "ffmpeg", filterThreads: 6}
	decode, encode := buildMetalCommands(cfg, file, "temp.mp4", EncoderVideoToolbox)
	d, e := strings.Join(decode, " "), strings.Join(encode, " ")
	for _, want := range []string{"-copyts", "-map 0:2 -an", "in_color_matrix=bt2020", "in_range=tv:out_range=pc", "format=gbrp16le", "-fps_mode passthrough", "-f nut -write_index 0 pipe:1"} {
		if !strings.Contains(d, want) {
			t.Errorf("decode missing %q: %s", want, d)
		}
	}
	for _, want := range []string{"-itsoffset -0.000000000 -f nut -i pipe:0 -itsoffset -0.000000000 -i source.mov", "-copyts", "-map 0:v:0 -map 1:a?", "-map_metadata 1 -map_chapters 1", "-map_metadata:s:v:0 1:s:2", "-map_metadata:s:a:0 1:s:4", "-q:v 90", "-c:a copy", "-fps_mode passthrough", "-vf " + metalOutputFilter} {
		if !strings.Contains(e, want) {
			t.Errorf("encode missing %q: %s", want, e)
		}
	}
	if strings.Contains(d+e, "lut3d=") || strings.Contains(e, "-b:v") || strings.Contains(e, "-hwaccel") {
		t.Fatalf("split pipeline must not apply a second LUT, change quality or decode source video again: %s", e)
	}
}

func TestMetalRequestSeparatesEncodedResultsOnly(t *testing.T) {
	file := filePlan{public: ItemPlan{Action: ActionEncode}}
	if configKey(file, LookStandard, QualityBalanced, false) == configKey(file, LookStandard, QualityBalanced, true) {
		t.Fatal("Metal results must have their own resume identity")
	}
	file.public.Action = ActionCopy
	if configKey(file, LookStandard, QualityBalanced, false) != configKey(file, LookStandard, QualityBalanced, true) {
		t.Fatal("Metal must not invalidate unchanged copies")
	}
	for _, pair := range [][2]string{{"darwin", "amd64"}, {"windows", "amd64"}, {"linux", "arm64"}} {
		if metalSupported(pair[0], pair[1]) {
			t.Fatalf("unexpected Metal platform support: %v", pair)
		}
	}
}

func TestMetalTimingRetainsVFRAndSourceOrigin(t *testing.T) {
	source := []presentationPacket{{PTS: "5.20", Duration: "0.04"}, {PTS: "5.00", Duration: "0.08"}, {PTS: "5.08", Duration: "0.12"}}
	output := []presentationPacket{{PTS: "0.00", Duration: "0.08"}, {PTS: "0.20", Duration: "0.04"}, {PTS: "0.08", Duration: "0.12"}}
	if err := comparePresentationTimes(source, output, 5, .0011); err != nil {
		t.Fatal(err)
	}
	output[2].PTS = "0.10"
	if err := comparePresentationTimes(source, output, 5, .0011); err == nil {
		t.Fatal("retimed VFR frame was accepted")
	}
	output[2].PTS = "0.08"
	output[1].Duration = "0.02"
	if err := comparePresentationTimes(source, output, 5, .0011); err == nil {
		t.Fatal("shortened final frame was accepted")
	}
}

func TestMetalFailureAndInvalidOutputRetrySameCPUQuality(t *testing.T) {
	if !metalSupported(runtime.GOOS, runtime.GOARCH) {
		t.Skip("native Metal fallback lifecycle is tested on Apple Silicon")
	}
	for _, kind := range []string{"process-failure", "invalid-output"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			source, output := filepath.Join(root, "source.mov"), filepath.Join(root, "result.mp4")
			cube := filepath.Join(root, "restore.cube")
			ffmpeg, probe := filepath.Join(root, "ffmpeg"), filepath.Join(root, "ffprobe")
			good := `{"format":{"duration":"1","tags":{"com.dji.camera.ColorGammaSxS":"Rec.709"}},"streams":[{"index":0,"codec_type":"video","codec_name":"hevc","width":64,"height":64,"pix_fmt":"yuv420p10le","nb_frames":"30","avg_frame_rate":"30/1","duration":"1","color_range":"tv","color_space":"bt709","color_primaries":"bt709","color_transfer":"bt709"}]}`
			bad := strings.Replace(good, `"width":64`, `"width":32`, 1)
			probeScript := fmt.Sprintf("#!/bin/sh\nfor last; do :; done\nif [ \"$(cat \"$last\")\" = metal ]; then printf '%%s' '%s'; else printf '%%s' '%s'; fi\n", bad, good)
			ffmpegScript := "#!/bin/sh\nprintf '%s\\n' \"$*\" >>\"$0.args\"\nfor last; do :; done\ncase \" $* \" in\n*' -write_index '*) printf stream;;\n*' -f nut '*) /bin/cat >/dev/null; printf metal >\"$last\";;\n*) printf cpu >\"$last\";;\nesac\nprintf 'progress=end\\n' >&2\n"
			helperScript := "#!/bin/sh\nexec /bin/cat\n"
			if kind == "process-failure" {
				helperScript = "#!/bin/sh\nexit 9\n"
			}
			for path, data := range map[string]string{
				source: "source", cube: "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n",
				ffmpeg: ffmpegScript, probe: probeScript, filepath.Join(root, "metal-lut"): helperScript,
			} {
				if err := os.WriteFile(path, []byte(data), 0700); err != nil {
					t.Fatal(err)
				}
			}
			cfg := normalizedConfig{Config: Config{Metal: true, Quality: QualityDetail, Encoder: EncoderVideoToolbox}, ffmpeg: ffmpeg, ffprobe: probe, outputRoot: root, filterThreads: 1}
			file := filePlan{source: source, output: output, relative: "source.mov", duration: 1, probe: Probe{Format: ProbeFormat{StartTime: "0", Duration: "1"}}, video: Stream{Width: 64, Height: 64, NbFrames: "30", AvgFrameRate: "30/1", Duration: "1"}, lut: &LUTSpec{File: cube, Grid: 2}}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			item, err := encodeFile(ctx, cfg, file, ItemReport{}, Report{}, map[string]bool{"hevc_videotoolbox": true}, nil, nil)
			if err != nil || item.LUTBackend != "cpu" || !item.OutputVerified || !strings.Contains(item.Reason, "Metal LUT fallback:") {
				t.Fatalf("fallback failed: %#v, %v", item, err)
			}
			data, _ := os.ReadFile(output)
			if string(data) != "cpu" {
				t.Fatal("failed Metal candidate was published")
			}
			commands, _ := os.ReadFile(ffmpeg + ".args")
			var cpuCommand string
			for _, line := range strings.Split(string(commands), "\n") {
				if strings.Contains(line, "lut3d=") {
					cpuCommand = line
				}
			}
			if !strings.Contains(cpuCommand, "-q:v 90") || !strings.Contains(cpuCommand, "lut3d=file="+cube) {
				t.Fatalf("fallback changed quality or LUT: %s", cpuCommand)
			}
		})
	}
}

func TestMetalPipelineFailureAndCancellation(t *testing.T) {
	if !metalSupported(runtime.GOOS, runtime.GOARCH) {
		t.Skip("native pipe lifecycle is tested on Apple Silicon")
	}
	for _, kind := range []string{"complete", "gpu-failure", "decode-failure", "encode-failure", "cancel"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			ffmpeg := filepath.Join(root, "ffmpeg")
			// exec keeps the timeout test's waiting process in the child PID.
			helper := "#!/bin/sh\nexec /bin/cat\n"
			if kind == "gpu-failure" {
				helper = "#!/bin/sh\nexit 9\n"
			}
			if kind == "cancel" {
				helper = "#!/bin/sh\nexec /bin/sleep 30\n"
			}
			script := "#!/bin/sh\ncase \" $* \" in\n*' -write_index '*) "
			if kind == "decode-failure" {
				script += "exit 7"
			} else {
				script += "printf stream"
			}
			script += ";;\n*) "
			if kind == "encode-failure" {
				script += "exit 8"
			} else {
				script += "/bin/cat >/dev/null; printf 'out_time_ms=1000000\\nprogress=end\\n'"
			}
			script += ";;\nesac\n"
			for path, content := range map[string]string{ffmpeg: script, filepath.Join(root, "metal-lut"): helper} {
				if err := os.WriteFile(path, []byte(content), 0700); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if kind == "cancel" {
				timer := time.AfterFunc(100*time.Millisecond, cancel)
				defer timer.Stop()
			}
			cfg := normalizedConfig{ffmpeg: ffmpeg, filterThreads: 1}
			file := filePlan{source: "source.mov", output: "result.mp4", duration: 1, probe: Probe{Format: ProbeFormat{StartTime: "0"}}, video: Stream{Width: 64, Height: 64}, lut: &LUTSpec{File: "lut.cube"}}
			_, err := runMetalFFmpeg(ctx, cfg, file, filepath.Join(root, "temp.mp4"), EncoderVideoToolbox, nil, filepath.Join(root, "log"))
			if (err == nil) != (kind == "complete") {
				t.Fatalf("pipeline %s: %v", kind, err)
			}
			if kind == "cancel" && ctx.Err() == nil {
				t.Fatal("cancellation did not propagate")
			}
		})
	}
}
