package main

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
	"sync"

	"dji-lut-app/internal/engine"
)

type frontendRequest struct {
	Input     string      `json:"input"`
	Output    string      `json:"output"`
	Look      engine.Look `json:"look"`
	Recursive bool        `json:"recursive"`
}

type stateItem struct {
	engine.ItemReport
	Percent float64 `json:"percent,omitempty"`
}

type appState struct {
	Running     bool           `json:"running"`
	Finished    bool           `json:"finished"`
	Cancelled   bool           `json:"cancelled"`
	CurrentFile string         `json:"current_file,omitempty"`
	Percent     float64        `json:"percent"`
	Completed   int            `json:"completed"`
	Total       int            `json:"total"`
	InputRoot   string         `json:"input_root,omitempty"`
	OutputRoot  string         `json:"output_root,omitempty"`
	Look        engine.Look    `json:"look,omitempty"`
	Recursive   bool           `json:"recursive"`
	Items       []stateItem    `json:"items"`
	Summary     engine.Summary `json:"summary"`
	Logs        []string       `json:"logs"`
	Error       string         `json:"error,omitempty"`
	Report      *engine.Report `json:"report,omitempty"`
}

type application struct {
	mu               sync.Mutex
	base             engine.Config
	catalog          []engine.LUTSpec
	defaultInput     string
	defaultOutput    string
	defaultLook      engine.Look
	defaultRecursive bool
	previewing       bool
	currentPlan      *engine.Plan
	planConfig       engine.Config
	state            appState
	cancel           context.CancelFunc
	runDone          chan struct{}
	outputRoot       string
}

func newApplication(base engine.Config, catalog []engine.LUTSpec, defaultInput string) *application {
	defaultInput, _ = filepath.Abs(defaultInput)
	defaultOutput := strings.TrimSpace(base.Output)
	defaultLook := base.Look
	if defaultLook == "" {
		defaultLook = engine.LookStandard
	}
	return &application{
		base:             base,
		catalog:          append([]engine.LUTSpec(nil), catalog...),
		defaultInput:     defaultInput,
		defaultOutput:    defaultOutput,
		defaultLook:      defaultLook,
		defaultRecursive: base.Recursive,
		state:            appState{Items: []stateItem{}, Logs: []string{}},
	}
}

func (a *application) Bootstrap() any {
	a.mu.Lock()
	defer a.mu.Unlock()
	return map[string]any{
		"defaults": map[string]any{
			"input":     a.defaultInput,
			"output":    a.defaultOutput,
			"look":      a.defaultLook,
			"recursive": a.defaultRecursive,
		},
		"catalog": a.catalog,
	}
}

func (a *application) Preview(ctx context.Context, raw json.RawMessage) (any, error) {
	request, err := decodeFrontendRequest(raw)
	if err != nil {
		return nil, err
	}
	cfg, err := a.configFor(request)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	if a.state.Running || a.previewing {
		a.mu.Unlock()
		return nil, errors.New("已有扫描或批次正在处理")
	}
	a.previewing = true
	a.currentPlan = nil
	a.mu.Unlock()
	plan, err := engine.Scan(ctx, cfg)
	if err != nil {
		a.mu.Lock()
		a.previewing = false
		a.mu.Unlock()
		return nil, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.previewing = false
	if a.state.Running {
		return nil, errors.New("扫描期间另一个批次已经开始")
	}
	a.currentPlan = plan
	a.planConfig = cfg
	a.outputRoot = plan.OutputRoot
	a.state = appState{
		InputRoot:  plan.InputRoot,
		OutputRoot: plan.OutputRoot,
		Look:       plan.Look,
		Recursive:  request.Recursive,
		Items:      makeStateItems(plan.Items, false),
		Summary:    engine.Summary{Total: len(plan.Items)},
		Logs:       []string{fmt.Sprintf("扫描完成：%s，共发现 %d 个视频。", plan.InputRoot, len(plan.Items))},
	}
	return plan, nil
}

func (a *application) Start(ctx context.Context, raw json.RawMessage) (any, error) {
	request, err := decodeFrontendRequest(raw)
	if err != nil {
		return nil, err
	}
	cfg, err := a.configFor(request)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	if a.state.Running {
		a.mu.Unlock()
		return nil, errors.New("当前批次正在处理")
	}
	if a.previewing {
		a.mu.Unlock()
		return nil, errors.New("正在扫描，请稍后再开始")
	}
	if a.currentPlan == nil || !sameRequestConfig(a.planConfig, cfg) {
		a.mu.Unlock()
		return nil, errors.New("设置已改变，请重新扫描并预览后再开始")
	}
	plan := a.currentPlan
	jobCtx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	a.runDone = make(chan struct{})
	runDone := a.runDone
	a.outputRoot = plan.OutputRoot
	a.state = appState{
		Running:    true,
		InputRoot:  plan.InputRoot,
		OutputRoot: plan.OutputRoot,
		Look:       plan.Look,
		Recursive:  request.Recursive,
		Items:      makeStateItems(plan.Items, true),
		Total:      len(plan.Items),
		Summary:    engine.Summary{Total: len(plan.Items)},
		Logs:       []string{fmt.Sprintf("开始处理 %d 个视频，输出到 %s。", len(plan.Items), plan.OutputRoot)},
	}
	initial := cloneState(a.state)
	a.mu.Unlock()
	go func() {
		defer close(runDone)
		a.run(jobCtx, cancel, cfg)
	}()
	return initial, nil
}

func (a *application) run(ctx context.Context, cancel context.CancelFunc, cfg engine.Config) {
	report, err := engine.Run(ctx, cfg, a.onEvent)
	cancel()
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cancel = nil
	a.state.Running = false
	a.state.Finished = true
	if report != nil {
		a.state.Report = report
		a.state.Summary = report.Summary
		a.state.Total = report.Summary.Total
	}
	if errors.Is(err, context.Canceled) || a.state.Summary.Cancelled > 0 {
		a.state.Cancelled = true
		a.appendLogLocked("已取消批量处理。")
	} else if err != nil {
		a.state.Error = err.Error()
		a.appendLogLocked("批量处理失败：" + err.Error())
	} else {
		a.appendLogLocked("处理完成。")
	}
	if report != nil {
		progressByInput := make(map[string]float64, len(a.state.Items))
		for _, item := range a.state.Items {
			progressByInput[inputKey(item.Input)] = item.Percent
		}
		finalItems := make([]stateItem, 0, len(report.Items))
		for _, item := range report.Items {
			percent := progressByInput[inputKey(item.Input)]
			if item.Status != engine.StatusCancelled {
				percent = 100
			}
			finalItems = append(finalItems, stateItem{ItemReport: item, Percent: percent})
		}
		a.state.Items = finalItems
	}
}

func (a *application) onEvent(event engine.Event) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if event.Path != "" {
		a.state.CurrentFile = event.Path
	}
	if event.OverallPercent > a.state.Percent {
		a.state.Percent = event.OverallPercent
	}
	if event.Type == "batch_started" {
		a.state.Completed = 0
		a.state.Percent = 0
		a.state.Total = event.Total
	} else if event.Completed > a.state.Completed {
		a.state.Completed = event.Completed
	}
	if event.Type != "batch_started" && event.Total > a.state.Total {
		a.state.Total = event.Total
	}
	if event.Item != nil || event.Path != "" {
		matched := false
		for i := range a.state.Items {
			matchesEventItem := event.Item != nil && sameInput(a.state.Items[i].Input, event.Item.Input)
			matchesEventPath := event.Path != "" && sameInput(a.state.Items[i].Input, event.Path)
			if matchesEventItem || matchesEventPath {
				matched = true
				if event.Item != nil {
					a.state.Items[i].ItemReport = *event.Item
				}
				switch event.Type {
				case "item_started":
					a.state.Items[i].Status = "running"
				case "item_progress":
					if event.Item == nil {
						a.state.Items[i].Status = "running"
					}
					a.state.Items[i].Percent = event.Percent
				case "item_completed":
					a.state.Items[i].Percent = 100
				}
				break
			}
		}
		if !matched && event.Type == "item_started" {
			a.state.Items = append(a.state.Items, stateItem{ItemReport: engine.ItemReport{Input: event.Path, Status: "running"}})
		}
		if !matched && event.Item != nil && event.Type == "item_completed" {
			a.state.Items = append(a.state.Items, stateItem{ItemReport: *event.Item, Percent: 100})
		}
		if event.Type == "item_completed" {
			a.recountSummaryLocked()
		}
	}
	switch event.Type {
	case "batch_started":
		a.appendLogLocked("开始批量处理。")
	case "item_started":
		a.appendLogLocked("正在处理：" + event.Path)
	case "item_completed":
		if event.Item != nil {
			a.appendLogLocked(fmt.Sprintf("%s：%s（%s）", statusText(event.Item.Status), event.Path, selectedLUT(event.Item.LUTFile)))
		} else {
			a.appendLogLocked("文件处理结束：" + event.Path)
		}
	case "batch_cancelled":
		a.appendLogLocked("正在停止批量处理。")
	case "batch_completed":
		a.appendLogLocked("批量处理完成。")
	default:
		if event.Message != "" {
			a.appendLogLocked(event.Message)
		}
	}
	if event.Type == "batch_cancelled" {
		a.state.Cancelled = true
	}
}

func (a *application) State() any {
	a.mu.Lock()
	defer a.mu.Unlock()
	return cloneState(a.state)
}

func (a *application) Cancel() {
	a.mu.Lock()
	cancel := a.cancel
	a.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Wait blocks until the active engine run has returned and its subprocesses
// have been reaped. It is used when the server closes or the app is interrupted.
func (a *application) Wait() {
	a.mu.Lock()
	if !a.state.Running || a.runDone == nil {
		a.mu.Unlock()
		return
	}
	done := a.runDone
	a.mu.Unlock()
	<-done
}

func (a *application) OpenOutput() error {
	a.mu.Lock()
	output := a.outputRoot
	finished := a.state.Finished
	a.mu.Unlock()
	if !finished {
		return errors.New("处理尚未结束，结果文件夹还不可用")
	}
	if output == "" {
		return errors.New("没有可打开的结果文件夹")
	}
	absolute, err := filepath.Abs(filepath.Clean(output))
	if err != nil {
		return fmt.Errorf("解析结果路径失败：%w", err)
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return fmt.Errorf("结果文件夹不可用：%w", err)
	}
	if !info.IsDir() {
		return errors.New("结果路径不是文件夹")
	}
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("/usr/bin/open", absolute)
	case "windows":
		command = exec.Command("explorer.exe", absolute)
	default:
		command = exec.Command("xdg-open", absolute)
	}
	if err := command.Start(); err != nil {
		return fmt.Errorf("打开结果文件夹失败：%w", err)
	}
	_ = command.Process.Release()
	return nil
}

func (a *application) configFor(request frontendRequest) (engine.Config, error) {
	request.Input = stripWrappingQuotes(strings.TrimSpace(request.Input))
	request.Output = stripWrappingQuotes(strings.TrimSpace(request.Output))
	if request.Look == "" {
		request.Look = engine.LookStandard
	}
	cfg := a.base
	cfg.Input = request.Input
	cfg.Output = request.Output
	cfg.Look = request.Look
	cfg.Recursive = request.Recursive
	if err := cfg.Validate(); err != nil {
		return engine.Config{}, err
	}
	return cfg, nil
}

func decodeFrontendRequest(raw json.RawMessage) (frontendRequest, error) {
	var request frontendRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return request, fmt.Errorf("读取扫描选项失败：%w", err)
	}
	return request, nil
}

func makeStateItems(items []engine.ItemPlan, pending bool) []stateItem {
	result := make([]stateItem, 0, len(items))
	for _, item := range items {
		status := item.Status
		if pending {
			status = "pending"
		}
		result = append(result, stateItem{ItemReport: engine.ItemReport{
			Input: item.Input, Output: item.Output, Action: item.Action, Status: status,
			Profile: item.Profile, Camera: item.Camera, LUTFile: item.LUTFile,
			LUTSHA256: item.LUTSHA256, SourceGamma: item.Gamma, Encoder: item.Encoder,
			Reason: item.Reason, InputBytes: item.Bytes,
		}})
	}
	return result
}

func sameRequestConfig(left, right engine.Config) bool {
	return sameInput(left.Input, right.Input) && sameInput(left.Output, right.Output) && left.Look == right.Look && left.Recursive == right.Recursive
}

func sameInput(left, right string) bool {
	left = filepath.Clean(left)
	right = filepath.Clean(right)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func inputKey(value string) string {
	clean := filepath.Clean(value)
	if runtime.GOOS == "windows" {
		return strings.ToLower(clean)
	}
	return clean
}

func stripWrappingQuotes(value string) string {
	if len(value) >= 2 && ((value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'')) {
		return strings.TrimSpace(value[1 : len(value)-1])
	}
	return value
}

func cloneState(state appState) appState {
	state.Items = append([]stateItem(nil), state.Items...)
	state.Logs = append([]string(nil), state.Logs...)
	if state.Report != nil {
		report := *state.Report
		report.Items = append([]engine.ItemReport(nil), state.Report.Items...)
		report.Config.Manifest = append([]engine.LUTSpec(nil), state.Report.Config.Manifest...)
		state.Report = &report
	}
	return state
}

func (a *application) appendLogLocked(line string) {
	a.state.Logs = append(a.state.Logs, line)
	if len(a.state.Logs) > 500 {
		a.state.Logs = append([]string(nil), a.state.Logs[len(a.state.Logs)-500:]...)
	}
}

func (a *application) recountSummaryLocked() {
	summary := engine.Summary{Total: a.state.Total}
	for _, item := range a.state.Items {
		switch item.Status {
		case engine.StatusEncoded:
			summary.Encoded++
		case engine.StatusCopiedNonLog, engine.StatusCopiedHDR, engine.StatusNeedsReview:
			summary.Copied++
		case engine.StatusSkippedExisting:
			summary.Skipped++
		case engine.StatusFailed:
			summary.Failed++
		case engine.StatusCancelled:
			summary.Cancelled++
		}
		if item.NeedsReview {
			summary.NeedsReview++
		}
	}
	a.state.Summary = summary
}

func statusText(status string) string {
	switch status {
	case engine.StatusEncoded:
		return "还原完成"
	case engine.StatusCopiedNonLog, engine.StatusCopiedHDR:
		return "复制完成"
	case engine.StatusNeedsReview:
		return "待确认素材已复制"
	case engine.StatusSkippedExisting:
		return "跳过已有文件"
	case engine.StatusFailed:
		return "处理失败"
	default:
		return status
	}
}

func selectedLUT(path string) string {
	if path == "" {
		return "未使用 LUT"
	}
	return filepath.Base(path)
}
