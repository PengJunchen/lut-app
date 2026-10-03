package engine

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestReusedFilenamePreservesExistingResultMetadata(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "clip.mp4")
	outputRoot := filepath.Join(root, "Output", "Standard")
	output := filepath.Join(outputRoot, "clip.mp4")
	if err := os.MkdirAll(filepath.Join(outputRoot, "source_metadata"), 0755); err != nil {
		t.Fatal(err)
	}
	for path, data := range map[string]string{source: "new source", output: "old result", filepath.Join(outputRoot, "source_metadata", "clip.mp4.ffprobe.json"): "old source metadata"} {
		if err := os.WriteFile(path, []byte(data), 0644); err != nil {
			t.Fatal(err)
		}
	}
	st, err := os.Stat(source)
	if err != nil {
		t.Fatal(err)
	}
	file := filePlan{source: source, output: output, relative: "clip.mp4", sourceSize: st.Size(), sourceModTime: st.ModTime(), hasProbe: true, probe: Probe{Format: ProbeFormat{Tags: map[string]string{gammaTag: "Normal"}}}, public: ItemPlan{Input: "clip.mp4", Output: "clip.mp4", Action: ActionCopy, Status: StatusCopiedNonLog}}
	item, err := processFile(context.Background(), normalizedConfig{outputRoot: outputRoot, Config: Config{Look: LookStandard}}, file, Report{}, nil, nil, nil)
	if err != nil || item.Status != StatusSkippedExisting || !item.NeedsReview {
		t.Fatalf("unverified old output: %#v %v", item, err)
	}
	b, err := os.ReadFile(filepath.Join(outputRoot, "source_metadata", "clip.mp4.ffprobe.json"))
	if err != nil || string(b) != "old source metadata" {
		t.Fatalf("existing source metadata overwritten: %q %v", b, err)
	}
}
