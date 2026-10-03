package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"dji-lut-app/internal/bundle"
	"dji-lut-app/internal/engine"
	"dji-lut-app/internal/webui"
)

func main() { os.Exit(run()) }

func run() int {
	defaultInput := executableFolder()
	input := flag.String("input", defaultInput, "原片文件夹")
	output := flag.String("output", "", "结果基础目录（默认：原片目录/Output）")
	lookText := flag.String("look", "standard", "LUT 风格：standard 或 vivid")
	recursive := flag.Bool("recursive", false, "包含子目录")
	dryRun := flag.Bool("dry-run", false, "只扫描并输出计划，不处理视频（需配合 --batch）")
	batch := flag.Bool("batch", false, "使用无界面批处理模式")
	noOpen := flag.Bool("no-open", false, "启动本机界面但不自动打开浏览器")
	port := flag.Int("port", 0, "本机界面端口（0 表示随机端口）")
	flag.Parse()
	suppressStartupAlerts = *batch

	look := engine.Look(strings.ToLower(strings.TrimSpace(*lookText)))
	if look != engine.LookStandard && look != engine.LookVivid {
		reportStartupError("配置无效", errors.New("--look 只能是 standard 或 vivid"))
		return 2
	}
	if *dryRun && !*batch {
		reportStartupError("配置无效", errors.New("--dry-run 只支持无界面批处理，请同时指定 --batch"))
		return 2
	}

	paths, err := bundle.Prepare()
	if err != nil {
		reportStartupError("应用资源准备失败", err)
		return 1
	}
	catalog, err := engine.LoadCatalog(paths.ManifestPath, paths.LUTDir)
	if err != nil {
		reportStartupError("读取 LUT 清单失败", err)
		return 1
	}
	cfg := engine.Config{
		Input:        *input,
		Output:       *output,
		Look:         look,
		Recursive:    *recursive,
		FFmpeg:       paths.FFmpeg,
		FFprobe:      paths.FFprobe,
		LUTDir:       paths.LUTDir,
		ManifestPath: paths.ManifestPath,
		Manifest:     catalog,
	}
	if err := cfg.Validate(); err != nil {
		reportStartupError("配置无效", err)
		return 2
	}
	if *batch {
		return runBatch(cfg, *dryRun)
	}

	app := newApplication(cfg, catalog, *input)
	server, err := webui.New(*port, app)
	if err != nil {
		reportStartupError("启动本机界面失败", err)
		return 1
	}
	launchURL := server.URL()
	if *noOpen {
		fmt.Printf("本机界面：%s\n", launchURL)
	} else if err := openDefaultBrowser(launchURL); err != nil {
		reportStartupError("无法自动打开浏览器", fmt.Errorf("请手动访问 %s：%w", launchURL, err))
	} else {
		fmt.Println("已在默认浏览器打开 DJI 视频色彩还原界面。")
	}

	interrupt, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	select {
	case <-server.Done():
		app.Cancel()
		app.Wait()
		return 0
	case <-interrupt.Done():
		app.Cancel()
		app.Wait()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
		return 130
	}
}

func runBatch(cfg engine.Config, dryRun bool) int {
	ctx := context.Background()
	if dryRun {
		plan, err := engine.Scan(ctx, cfg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "扫描失败：%v\n", err)
			return 1
		}
		if err := writeJSON(os.Stdout, plan); err != nil {
			fmt.Fprintf(os.Stderr, "输出扫描计划失败：%v\n", err)
			return 1
		}
		return 0
	}
	report, err := engine.Run(ctx, cfg, func(event engine.Event) {
		if event.Type == "item_started" || event.Type == "item_completed" || event.Type == "item_progress" || event.Type == "batch_cancelled" {
			fmt.Fprintf(os.Stderr, "[%5.1f%%] %-16s %s\n", event.OverallPercent, event.Type, event.Path)
		}
	})
	if report != nil {
		if jsonErr := writeJSON(os.Stdout, report); jsonErr != nil {
			fmt.Fprintf(os.Stderr, "输出处理报告失败：%v\n", jsonErr)
			return 1
		}
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "批处理失败：%v\n", err)
		if errors.Is(err, context.Canceled) {
			return 130
		}
		return 1
	}
	if report != nil && report.Summary.Failed > 0 {
		return 1
	}
	if report != nil && report.Summary.NeedsReview > 0 {
		return 2
	}
	return 0
}

func writeJSON(file *os.File, value any) error {
	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func openDefaultBrowser(location string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("/usr/bin/open", location)
	case "windows":
		command = exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", location)
	default:
		command = exec.Command("xdg-open", location)
	}
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}

func executableFolder() string {
	executable, err := os.Executable()
	if err != nil {
		if cwd, cwdErr := os.Getwd(); cwdErr == nil {
			return cwd
		}
		return "."
	}
	if resolved, resolveErr := filepath.EvalSymlinks(executable); resolveErr == nil {
		executable = resolved
	}
	return folderForExecutable(executable)
}

func folderForExecutable(executable string) string {
	folder := filepath.Dir(executable)
	for current := folder; current != filepath.Dir(current); current = filepath.Dir(current) {
		if strings.EqualFold(filepath.Ext(current), ".app") {
			return filepath.Dir(current)
		}
	}
	return folder
}
