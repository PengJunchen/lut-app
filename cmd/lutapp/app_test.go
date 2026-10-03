package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
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

func TestSelectFolderCancellationPreservesPathAndApplicationState(t *testing.T) {
	input := t.TempDir()
	app := newApplication(engine.Config{}, nil, input)
	app.state = appState{
		InputRoot:  input,
		OutputRoot: filepath.Join(input, "Output"),
		Logs:       []string{"before picker"},
		Items:      []stateItem{{ItemReport: engine.ItemReport{Input: "clip.mp4", Status: engine.StatusPlannedEncode}}},
	}
	before := cloneState(app.state)
	picker := &testFolderPicker{cancelled: true}
	app.folderPicker = picker

	value, err := app.SelectFolder(t.Context(), folderPickerRequestJSON(t, "output", input))
	if err != nil {
		t.Fatal(err)
	}
	result := value.(folderPickerResult)
	if !result.Cancelled || result.Path != input {
		t.Fatalf("cancel result = %#v, want original path and cancelled=true", result)
	}
	if !reflect.DeepEqual(before, app.State()) {
		t.Fatalf("application state changed after picker cancellation: before=%#v after=%#v", before, app.State())
	}
	if picker.initial != input {
		t.Fatalf("picker initial directory = %q, want %q", picker.initial, input)
	}
}

func TestSelectFolderValidatesTargetAndSelectedDirectory(t *testing.T) {
	input := t.TempDir()
	selected := filepath.Join(t.TempDir(), "选中的目录 ")
	if err := os.Mkdir(selected, 0o755); err != nil {
		t.Fatal(err)
	}
	picker := &testFolderPicker{path: selected}
	app := newApplication(engine.Config{}, nil, input)
	app.folderPicker = picker

	if _, err := app.SelectFolder(t.Context(), folderPickerRequestJSON(t, "sideways", input)); err == nil {
		t.Fatal("invalid target was accepted")
	}
	if picker.calls != 0 {
		t.Fatalf("picker calls after invalid target = %d, want 0", picker.calls)
	}

	value, err := app.SelectFolder(t.Context(), folderPickerRequestJSON(t, "input", input))
	if err != nil {
		t.Fatal(err)
	}
	result := value.(folderPickerResult)
	if result.Cancelled || result.Path != selected {
		t.Fatalf("successful selection = %#v, want %q", result, selected)
	}

	file := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(file, []byte("test"), 0o600); err != nil {
		t.Fatal(err)
	}
	picker.path = file
	if _, err := app.SelectFolder(t.Context(), folderPickerRequestJSON(t, "output", input)); err == nil {
		t.Fatal("selected file path was accepted as a folder")
	}
}

func TestSelectFolderUsesExistingParentForMissingStartingPath(t *testing.T) {
	input := t.TempDir()
	missing := filepath.Join(input, "gone", "nested")
	picker := &testFolderPicker{cancelled: true}
	app := newApplication(engine.Config{}, nil, input)
	app.folderPicker = picker

	if _, err := app.SelectFolder(t.Context(), folderPickerRequestJSON(t, "input", missing)); err != nil {
		t.Fatal(err)
	}
	if picker.initial != input {
		t.Fatalf("fallback starting directory = %q, want existing parent %q", picker.initial, input)
	}
}

func TestSelectFolderRejectsRunningScanAndAnotherPicker(t *testing.T) {
	input := t.TempDir()
	request := folderPickerRequestJSON(t, "input", input)
	for _, test := range []struct {
		name  string
		state appState
		scan  bool
	}{
		{name: "running", state: appState{Running: true}},
		{name: "scanning", scan: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			picker := &testFolderPicker{}
			app := newApplication(engine.Config{}, nil, input)
			app.folderPicker = picker
			app.state = test.state
			app.previewing = test.scan
			if _, err := app.SelectFolder(t.Context(), request); err == nil {
				t.Fatal("folder selection was accepted while scan/run was active")
			}
			if picker.calls != 0 {
				t.Fatalf("picker calls = %d, want 0", picker.calls)
			}
		})
	}

	started := make(chan struct{})
	picker := &testFolderPicker{selectFunc: func(ctx context.Context, _ string) (string, bool, error) {
		close(started)
		<-ctx.Done()
		return "", false, ctx.Err()
	}}
	app := newApplication(engine.Config{}, nil, input)
	app.folderPicker = picker
	first := make(chan error, 1)
	go func() {
		_, err := app.SelectFolder(context.Background(), request)
		first <- err
	}()
	<-started
	if _, err := app.SelectFolder(t.Context(), request); err == nil {
		t.Fatal("concurrent folder selection was accepted")
	}
	app.Close()
	if err := <-first; err != nil {
		t.Fatalf("cancelled picker returned an error: %v", err)
	}
	if _, err := app.SelectFolder(t.Context(), request); err == nil {
		t.Fatal("folder selection was accepted after Close")
	}
}

type testFolderPicker struct {
	mu         sync.Mutex
	calls      int
	initial    string
	path       string
	cancelled  bool
	err        error
	selectFunc func(context.Context, string) (string, bool, error)
}

func (p *testFolderPicker) Select(ctx context.Context, initial string) (string, bool, error) {
	p.mu.Lock()
	p.calls++
	p.initial = initial
	selectFunc := p.selectFunc
	path, cancelled, err := p.path, p.cancelled, p.err
	p.mu.Unlock()
	if selectFunc != nil {
		return selectFunc(ctx, initial)
	}
	return path, cancelled, err
}

func folderPickerRequestJSON(t *testing.T, target, path string) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(folderPickerRequest{Target: target, Path: path})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func quoteJSON(t *testing.T, value string) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
