package engine

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestFFmpegCompletionLeavesRoomForVerification(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a small POSIX progress producer")
	}
	var last float64
	_, err := runFFmpeg(context.Background(), []string{"/bin/sh", "-c", "printf 'out_time_ms=1000000\\nprogress=end\\n'"}, 1, func(value float64) { last = value }, filepath.Join(t.TempDir(), "log"))
	if err != nil || last != 99.9 {
		t.Fatalf("encoding must await validation and publication: %v, %.1f", err, last)
	}
}

func TestPreserveCommandAndReferenceUseOneTransform(t *testing.T) {
	file := filePlan{source: "source.mov", output: "result.mp4", video: Stream{Index: 2}, inputMatrix: "bt709", inputRange: "tv", lut: &LUTSpec{File: "restore.cube"}}
	cfg := normalizedConfig{Config: Config{Quality: QualityPreserve}, ffmpeg: "ffmpeg", preset: "ultrafast", filterThreads: 6}
	base := buildFFmpegCommand(cfg, file, "temp.mp4", EncoderX265)
	command, err := withPixelReference(base, "reference.sha256")
	if err != nil {
		t.Fatal(err)
	}
	text := strings.Join(command, " ")
	for _, want := range []string{"lossless=1", "-preset ultrafast", "[0:2]", "split=2[encoded][reference]", "-map [encoded]", "-map [reference]", "-f hash -hash sha256 reference.sha256", "format=yuv420p10le,setparams=range=limited"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q: %s", want, text)
		}
	}
	if strings.Count(text, "lut3d=") != 1 || strings.Contains(text, "-crf") || strings.Contains(text, "-q:v") {
		t.Fatalf("lossless must share one transform and avoid lossy quality controls: %s", text)
	}
	if runtime.GOOS == "darwin" && !strings.Contains(text, "-hwaccel auto") {
		t.Fatal("lossless software encoding should retain automatic macOS input decoding")
	}
	_, metal := buildMetalCommands(cfg, file, "temp.mp4", EncoderX265)
	metal, err = withPixelReference(metal, "metal.sha256")
	if err != nil {
		t.Fatal(err)
	}
	text = strings.Join(metal, " ")
	if strings.Contains(text, "lut3d=") || !strings.Contains(text, "[0:v:0]") {
		t.Fatalf("Metal reference must hash the post-GPU transform without applying another LUT: %s", text)
	}
}

func TestLosslessWorkersRespectCPUBudget(t *testing.T) {
	for _, test := range []struct{ available, want int }{{0, 1}, {1, 1}, {2, 2}, {4, 4}, {8, 8}, {64, 8}} {
		if got := losslessWorkers(test.available); got != test.want {
			t.Fatalf("%d CPUs produced %d workers; want %d", test.available, got, test.want)
		}
	}
}

func TestPixelReferenceMustBeACompleteSHA256(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pixels.sha256")
	for _, data := range []string{"", "SHA256=123", "SHA256=" + strings.Repeat("z", 64), "SHA256=" + strings.Repeat("a", 64) + "\ntrailing"} {
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readPixelReference(path); err == nil {
			t.Fatalf("accepted invalid reference %q", data)
		}
	}
	if err := os.WriteFile(path, []byte("SHA256="+strings.Repeat("A", 64)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if digest, err := readPixelReference(path); err != nil || digest != strings.Repeat("a", 64) {
		t.Fatalf("reference parse: %q, %v", digest, err)
	}
}

func TestPreserveIdentityDoesNotReuseLossyResults(t *testing.T) {
	file := filePlan{public: ItemPlan{Action: ActionEncode}}
	for _, quality := range []QualityMode{QualityBalanced, QualityDetail} {
		if configKey(file, LookStandard, quality, false) == configKey(file, LookStandard, QualityPreserve, false) {
			t.Fatal("lossy output shares a lossless resume identity")
		}
	}
	file.public.Action = ActionCopy
	if configKey(file, LookStandard, QualityBalanced, false) != configKey(file, LookStandard, QualityPreserve, false) {
		t.Fatal("encoding quality invalidated byte copies")
	}
}

func TestVideoToolboxBudgetDoesNotReuseTinyInputBitrates(t *testing.T) {
	for _, test := range []struct {
		stream Stream
		want   string
	}{
		{Stream{Width: 1920, Height: 1080, AvgFrameRate: "30/1", BitRate: "8500"}, "8000000"},
		{Stream{Width: 3840, Height: 2160, AvgFrameRate: "30/1", BitRate: "8500"}, "24883200"},
		{Stream{Width: 3840, Height: 2160, AvgFrameRate: "30/1", BitRate: "80000000"}, "80000000"},
	} {
		if got := videoToolboxBitrate(test.stream); got != test.want {
			t.Fatalf("bitrate budget %s; want %s", got, test.want)
		}
	}
	file := filePlan{public: ItemPlan{Action: ActionEncode}, video: Stream{Width: 1920, Height: 1080, BitRate: "8500"}}
	if !strings.Contains(configKey(file, LookStandard, QualityBalanced, false), "vt-budget=v2") {
		t.Fatal("the changed bitrate policy must not silently reuse prior low-budget results")
	}
	file.public.Action = ActionCopy
	if strings.Contains(configKey(file, LookStandard, QualityBalanced, false), "vt-budget=v2") {
		t.Fatal("the bitrate policy must not invalidate byte copies")
	}
}

func TestPreservePublicationRequiresMatchingPixelReference(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a POSIX reference corruption wrapper")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is not installed")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe is not installed")
	}
	available, err := queryEncoders(context.Background(), ffmpeg)
	if err != nil || !available["libx265"] {
		t.Skip("libx265 is not installed")
	}
	root := t.TempDir()
	source := filepath.Join(root, "source.mp4")
	generate := exec.Command(ffmpeg, "-v", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=30", "-frames:v", "6", "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le", "-x265-params", "pools=1:frame-threads=1:log-level=error", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", source)
	if data, err := generate.CombinedOutput(); err != nil {
		t.Fatalf("generate reference source: %v\n%s", err, data)
	}
	probe, err := probeFile(context.Background(), source, ffprobe)
	if err != nil {
		t.Fatal(err)
	}
	video, err := mainVideo(probe)
	if err != nil {
		t.Fatal(err)
	}
	cube := filepath.Join(root, "restore.cube")
	if err := os.WriteFile(cube, []byte("LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, corrupt := range []bool{false, true} {
		name := "valid"
		if corrupt {
			name = "corrupt"
		}
		t.Run(name, func(t *testing.T) {
			output := filepath.Join(root, name+".mp4")
			tool := ffmpeg
			if corrupt {
				quoted := "'" + strings.ReplaceAll(ffmpeg, "'", "'\\''") + "'"
				script := "#!/bin/sh\n" + quoted + " \"$@\"\nresult=$?\nif [ \"$result\" -eq 0 ]; then\ncase \" $* \" in\n*' -f hash -hash sha256 '*) for last; do :; done; printf 'SHA256=" + strings.Repeat("0", 64) + "\\n' >\"$last\";;\nesac\nfi\nexit \"$result\"\n"
				tool = readbackExecutable(t, root, "corrupt-reference", script)
			}
			cfg := normalizedConfig{Config: Config{Quality: QualityPreserve, Encoder: EncoderX265}, ffmpeg: tool, ffprobe: ffprobe, outputRoot: root, filterThreads: 2, preset: "ultrafast"}
			file := filePlan{source: source, output: output, relative: name, video: video, probe: probe, duration: streamDuration(video, probe), inputMatrix: "bt709", inputRange: "tv", gamma: "D-Log M", lut: &LUTSpec{File: cube, Grid: 2}}
			item, err := encodeFile(context.Background(), cfg, file, ItemReport{}, Report{}, available, nil, nil)
			if corrupt {
				if err == nil || item.OutputVerified {
					t.Fatalf("mismatched pixels were accepted: %#v, %v", item, err)
				}
				if _, err := os.Stat(output); !os.IsNotExist(err) {
					t.Fatalf("mismatched candidate was published: %v", err)
				}
			} else if err != nil || !item.OutputVerified || !item.EncodingLossless || len(item.PixelSHA256) != 64 {
				t.Fatalf("valid lossless output was not published: %#v, %v", item, err)
			}
		})
	}
}
