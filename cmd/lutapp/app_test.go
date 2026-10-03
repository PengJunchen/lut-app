package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dji-lut-app/internal/engine"
)

func TestFolderForExecutableUsesParentOfMacAppBundle(t *testing.T) {
	got := folderForExecutable(filepath.Join(string(filepath.Separator), "Applications", "DJI LUT.app", "Contents", "MacOS", "lutapp"))
	want := filepath.Join(string(filepath.Separator), "Applications")
	if got != want {
		t.Fatalf("folderForExecutable() = %q, want .app parent %q", got, want)
	}
}

func TestFolderForExecutableUsesExecutableDirectoryOutsideAppBundle(t *testing.T) {
	got := folderForExecutable(filepath.Join(string(filepath.Separator), "Users", "tester", "Videos", "lutapp"))
	want := filepath.Join(string(filepath.Separator), "Users", "tester", "Videos")
	if got != want {
		t.Fatalf("folderForExecutable() = %q, want %q", got, want)
	}
}

func TestPerFileProgressUpdatesWithoutItemSnapshot(t *testing.T) {
	app := &application{state: appState{Items: []stateItem{{ItemReport: engine.ItemReport{Input: "clip.mp4", Status: engine.StatusPlannedEncode}}}}}
	app.onEvent(engine.Event{Type: "item_started", Path: "clip.mp4", Total: 1})
	app.onEvent(engine.Event{Type: "item_progress", Path: "clip.mp4", Percent: 43, OverallPercent: 43, Total: 1})
	state := app.State().(appState)
	if len(state.Items) != 1 {
		t.Fatalf("progress item count = %d, want 1", len(state.Items))
	}
	if state.Items[0].Status != "running" || state.Items[0].Percent != 43 {
		t.Fatalf("file progress = status:%q percent:%v, want running/43", state.Items[0].Status, state.Items[0].Percent)
	}
	completed := engine.ItemReport{Input: "clip.mp4", Action: engine.ActionCopy, Status: engine.StatusNeedsReview, NeedsReview: true}
	app.onEvent(engine.Event{Type: "item_completed", Path: "clip.mp4", Item: &completed, Completed: 1, Total: 1})
	state = app.State().(appState)
	if state.Summary.Copied != 1 || state.Summary.NeedsReview != 1 {
		t.Fatalf("live summary after item completion = %#v, want copied=1 needs_review=1", state.Summary)
	}
}

func TestPreviewUsesSelectedLookAndRunWaitsForCompletion(t *testing.T) {
	input := t.TempDir()
	app := newApplication(engine.Config{Manifest: testManifest()}, nil, input)
	request := json.RawMessage(`{"input":` + quoteJSON(t, input) + `,"output":"","look":"vivid","recursive":false}`)

	value, err := app.Preview(t.Context(), request)
	if err != nil {
		t.Fatal(err)
	}
	plan, ok := value.(*engine.Plan)
	if !ok {
		t.Fatalf("Preview result type = %T, want *engine.Plan", value)
	}
	wantOutput := filepath.Join(input, "Output", "Vivid")
	if plan.OutputRoot != wantOutput {
		t.Fatalf("preview output = %q, want %q", plan.OutputRoot, wantOutput)
	}

	if _, err := app.Start(t.Context(), request); err != nil {
		t.Fatal(err)
	}
	app.Wait()
	stateValue := app.State()
	state, ok := stateValue.(appState)
	if !ok {
		t.Fatalf("State result type = %T, want appState", stateValue)
	}
	if !state.Finished || state.Running {
		t.Fatalf("run state after Wait = finished:%v running:%v", state.Finished, state.Running)
	}
	if state.Report == nil || state.Report.OutputRoot != wantOutput {
		t.Fatalf("final report = %#v, want output %q", state.Report, wantOutput)
	}
	if _, err := os.Stat(filepath.Join(wantOutput, "report.json")); err != nil {
		t.Fatalf("engine report was not written: %v", err)
	}
}

func testManifest() []engine.LUTSpec {
	return []engine.LUTSpec{{Camera: "test-camera", Profile: "dlog", Look: engine.LookStandard, File: "unused.cube", SHA256: strings.Repeat("0", 64), Grid: 2}}
}

func TestBootstrapKeepsDefaultOutputRelativeToChosenInput(t *testing.T) {
	input := t.TempDir()
	app := newApplication(engine.Config{Look: engine.LookVivid, Recursive: true}, nil, input)
	bootstrap := app.Bootstrap().(map[string]any)
	defaults := bootstrap["defaults"].(map[string]any)
	if defaults["output"] != "" {
		t.Fatalf("default output = %#v, want blank to follow the selected input folder", defaults["output"])
	}
	if defaults["look"] != engine.LookVivid || defaults["recursive"] != true {
		t.Fatalf("bootstrap did not preserve CLI look/recursive: %#v", defaults)
	}
}

func quoteJSON(t *testing.T, value string) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
