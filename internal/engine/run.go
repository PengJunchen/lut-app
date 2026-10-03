package engine

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const engineVersion = "1.0.0"

// Run plans and processes the configured folder. Per-file failures are
// recorded in the report and do not stop other files. Cancel by cancelling ctx.
func Run(ctx context.Context, config Config, onEvent func(Event)) (*Report, error) {
	ncfg, err := normalizeConfig(config)
	if err != nil {
		return nil, err
	}
	files, scanErr := scanFiles(ctx, ncfg)
	if scanErr != nil && !errors.Is(scanErr, context.Canceled) && !errors.Is(scanErr, context.DeadlineExceeded) {
		return nil, scanErr
	}
	report := &Report{
		GeneratedBy: "dji-lut-app/" + engineVersion,
		StartedAt:   time.Now().UTC(), InputRoot: ncfg.inputAbs,
		OutputRoot: ncfg.outputRoot, Config: ncfg.Config,
		Items: make([]ItemReport, len(files)),
	}
	if err := os.MkdirAll(ncfg.outputRoot, 0o755); err != nil {
		return nil, fmt.Errorf("create output directory: %w", err)
	}
	previous := loadPreviousReport(filepath.Join(ncfg.outputRoot, "report.json"))
	currentInputs := make(map[string]bool, len(files))
	for i, file := range files {
		report.Items[i] = reportFromPlan(file)
		currentInputs[file.relative] = true
	}
	historySeen := make(map[string]bool)
	for _, old := range previous.History {
		if !currentInputs[old.Input] {
			report.History = append(report.History, old)
			historySeen[old.Input] = true
		}
	}
	for _, old := range previous.Items {
		if !currentInputs[old.Input] && !historySeen[old.Input] {
			report.History = append(report.History, old)
			historySeen[old.Input] = true
		}
	}
	var callbackMu sync.Mutex
	var completed atomic.Int64
	total := len(files)
	if total == 0 {
		report.FinishedAt = time.Now().UTC()
		report.Summary = summarize(report.Items)
		if err := writeJSONAtomic(filepath.Join(ncfg.outputRoot, "report.json"), report); err != nil {
			return report, err
		}
		if onEvent != nil {
			if scanErr != nil {
				onEvent(Event{Type: "batch_cancelled", Message: "Scanning cancelled", Total: 0})
			} else {
				onEvent(Event{Type: "batch_completed", Message: "No videos found", OverallPercent: 100})
			}
		}
		return report, scanErr
	}
	emit := func(event Event) {
		if onEvent == nil {
			return
		}
		callbackMu.Lock()
		onEvent(event)
		callbackMu.Unlock()
	}
	emit(Event{Type: "batch_started", Message: "Scanning complete; processing files", Total: len(files)})
	type result struct {
		index int
		item  ItemReport
		err   error
	}
	jobs := make(chan int, len(files))
	results := make(chan result, len(files))
	for index, file := range files {
		if file.public.Action != ActionEncode {
			jobs <- index
		}
	}
	for index, file := range files {
		if file.public.Action == ActionEncode {
			jobs <- index
		}
	}
	close(jobs)
	encoderSet := map[string]bool{}
	var encoderErr error
	needsEncoder := false
	for _, file := range files {
		if file.public.Action == ActionEncode {
			needsEncoder = true
			break
		}
	}
	if needsEncoder {
		encoderSet, encoderErr = queryEncoders(ctx, ncfg.ffmpeg)
	}
	if ctx.Err() != nil {
		encoderErr = ctx.Err()
	}
	workerCount := ncfg.workers
	if workerCount > len(files) {
		workerCount = len(files)
	}
	var workers sync.WaitGroup
	encodeSlots := make(chan struct{}, 1)
	workers.Add(workerCount)
	for worker := 0; worker < workerCount; worker++ {
		go func() {
			defer workers.Done()
			for index := range jobs {
				file := files[index]
				if ctx.Err() != nil {
					results <- result{index: index, item: cancelledItem(file, ctx.Err())}
					continue
				}
				item := reportFromPlan(file)
				emit(Event{Type: "item_started", Path: file.relative, Total: total, Completed: int(completed.Load())})
				if file.public.Action == ActionEncode {
					select {
					case encodeSlots <- struct{}{}:
					case <-ctx.Done():
						results <- result{index: index, item: cancelledItem(file, ctx.Err())}
						continue
					}
				}
				if file.public.Action == ActionEncode && encoderErr != nil {
					item.Status = StatusFailed
					item.Error = "cannot query ffmpeg encoders: " + encoderErr.Error()
				} else {
					var processErr error
					item, processErr = processFile(ctx, ncfg, file, previous, encoderSet, emit, func(percent float64) {
						done := int(completed.Load())
						overall := (float64(done) + clamp(percent, 0, 100)/100) / float64(total) * 100
						emit(Event{Type: "item_progress", Path: file.relative, Percent: percent, OverallPercent: overall, Completed: done, Total: total})
					})
					if processErr != nil {
						item.Error = processErr.Error()
						if ctx.Err() != nil {
							item.Status = StatusCancelled
						} else {
							item.Status = StatusFailed
						}
					}
				}
				if file.public.Action == ActionEncode {
					<-encodeSlots
				}
				results <- result{index: index, item: item}
			}
		}()
	}
	go func() {
		workers.Wait()
		close(results)
	}()
	for result := range results {
		report.Items[result.index] = result.item
		done := int(completed.Add(1))
		if err := writeJSONAtomic(filepath.Join(ncfg.outputRoot, "report.json"), report); err != nil {
			// Retain the result and report a batch-level error after all workers clean up.
			report.Items[result.index].Error = strings.TrimSpace(report.Items[result.index].Error + " report write failed: " + err.Error())
		}
		emit(Event{Type: "item_completed", Path: files[result.index].relative, Message: report.Items[result.index].Status, Item: &report.Items[result.index], Completed: done, Total: total, OverallPercent: float64(done) / float64(total) * 100})
	}
	report.FinishedAt = time.Now().UTC()
	report.Summary = summarize(report.Items)
	if err := writeJSONAtomic(filepath.Join(ncfg.outputRoot, "report.json"), report); err != nil {
		return report, fmt.Errorf("write run report: %w", err)
	}
	if ctx.Err() != nil || errors.Is(scanErr, context.Canceled) {
		emit(Event{Type: "batch_cancelled", Message: "Processing cancelled", Completed: report.Summary.Encoded + report.Summary.Copied + report.Summary.Skipped + report.Summary.Failed + report.Summary.Cancelled, Total: total})
		return report, ctx.Err()
	}
	emit(Event{Type: "batch_completed", Message: "Processing complete", OverallPercent: 100, Completed: total, Total: total})
	return report, nil
}

func reportFromPlan(file filePlan) ItemReport {
	return ItemReport{
		Input: file.relative, Output: file.public.Output,
		Action: file.public.Action, Status: file.public.Status,
		Profile: file.public.Profile, Camera: file.public.Camera,
		LUTFile: file.public.LUTFile, LUTSHA256: file.public.LUTSHA256,
		SourceGamma: file.public.Gamma, Encoder: file.public.Encoder,
		Reason: file.public.Reason, InputBytes: file.public.Bytes,
		DurationSeconds: file.duration,
		NeedsReview:     file.public.Status == StatusNeedsReview,
	}
}

func cancelledItem(file filePlan, err error) ItemReport {
	item := reportFromPlan(file)
	item.Status = StatusCancelled
	if err != nil {
		item.Error = err.Error()
	}
	return item
}

func processFile(ctx context.Context, cfg normalizedConfig, file filePlan, previous Report, encoders map[string]bool, emit func(Event), progress func(float64)) (ItemReport, error) {
	item := reportFromPlan(file)
	item.ConfigKey = configKey(file, cfg.Look)
	if err := ctx.Err(); err != nil {
		return item, err
	}
	sourceInfo, err := os.Stat(file.source)
	if err != nil {
		return item, fmt.Errorf("stat input: %w", err)
	}
	if file.sourceSize != sourceInfo.Size() || (!file.sourceModTime.IsZero() && !file.sourceModTime.Equal(sourceInfo.ModTime())) {
		return item, errors.New("source changed after planning; re-scan before processing")
	}
	item.InputBytes = sourceInfo.Size()
	// Preserve the metadata belonging to an existing result when a filename
	// is reused for another source, or when the old result needs review.
	if _, err := os.Stat(file.output); err == nil {
		return skipExisting(ctx, item, file, previous)
	} else if !os.IsNotExist(err) {
		return item, fmt.Errorf("check output: %w", err)
	}
	if file.hasProbe {
		relMeta := filepath.Join("source_metadata", filepath.FromSlash(file.relative)+".ffprobe.json")
		metaPath := filepath.Join(cfg.outputRoot, relMeta)
		metadata := any(file.probe)
		if len(file.probe.Raw) > 0 {
			metadata = json.RawMessage(file.probe.Raw)
		}
		if err := writeJSONAtomic(metaPath, metadata); err != nil {
			item.Reason = strings.TrimSpace(item.Reason + "; could not save source metadata: " + err.Error())
		} else {
			item.SourceMetadata = filepath.ToSlash(relMeta)
		}
	}
	if file.public.Action == ActionEncode {
		encoder, err := defaultEncoder(cfg, encoders)
		if err != nil {
			return item, err
		}
		item.Encoder = string(encoder)
	}
	if file.public.Action == ActionEncode {
		return encodeFile(ctx, cfg, file, item, previous, encoders, emit, progress)
	}
	return copyFile(ctx, file, item, previous, progress)
}

func copyFile(ctx context.Context, file filePlan, item ItemReport, previous Report, progress func(float64)) (ItemReport, error) {
	before, err := os.Stat(file.source)
	if err != nil {
		return item, fmt.Errorf("stat input: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(file.output), 0o755); err != nil {
		return item, fmt.Errorf("create output folder: %w", err)
	}
	temp, err := os.CreateTemp(filepath.Dir(file.output), "."+filepath.Base(file.output)+".*.partial")
	if err != nil {
		return item, fmt.Errorf("create temporary output: %w", err)
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	source, err := os.Open(file.source)
	if err != nil {
		temp.Close()
		return item, fmt.Errorf("open input: %w", err)
	}
	hash := sha256.New()
	buffer := make([]byte, 1024*1024)
	var copied int64
	for {
		if err := ctx.Err(); err != nil {
			source.Close()
			temp.Close()
			return item, err
		}
		n, readErr := source.Read(buffer)
		if n > 0 {
			if _, err := temp.Write(buffer[:n]); err != nil {
				source.Close()
				temp.Close()
				return item, fmt.Errorf("write temporary copy: %w", err)
			}
			_, _ = hash.Write(buffer[:n])
			copied += int64(n)
			if before.Size() > 0 && progress != nil {
				progress(float64(copied) / float64(before.Size()) * 100)
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				source.Close()
				temp.Close()
				return item, fmt.Errorf("read input: %w", readErr)
			}
			break
		}
	}
	if err := source.Close(); err != nil {
		temp.Close()
		return item, fmt.Errorf("close input: %w", err)
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return item, fmt.Errorf("sync temporary copy: %w", err)
	}
	if err := temp.Close(); err != nil {
		return item, fmt.Errorf("close temporary copy: %w", err)
	}
	after, err := os.Stat(file.source)
	if err != nil || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) || copied != before.Size() {
		return item, errors.New("source changed or was truncated during copy; discarded temporary output")
	}
	item.InputSHA256 = hex.EncodeToString(hash.Sum(nil))
	tempHash, err := hashFile(tempName)
	if err != nil {
		return item, fmt.Errorf("hash temporary copy: %w", err)
	}
	if tempHash != item.InputSHA256 {
		return item, errors.New("temporary copy SHA256 differs from source; discarded temporary output")
	}
	item.OutputSHA256 = tempHash
	item.OutputBytes = copied
	item.BytesCopied = copied
	if err := linkNoReplace(ctx, tempName, file.output, item.OutputSHA256); err != nil {
		if os.IsExist(err) {
			return item, errors.New("output appeared during processing; preserved existing file")
		}
		return item, fmt.Errorf("publish copy: %w", err)
	}
	item.Status = file.public.Status
	item.NeedsReview = item.Status == StatusNeedsReview
	item.OutputVerified = true
	item.Output = slashRelOutput(item.Output)
	if progress != nil {
		progress(100)
	}
	return item, nil
}

func skipExisting(ctx context.Context, item ItemReport, file filePlan, previous Report) (ItemReport, error) {
	if err := ctx.Err(); err != nil {
		return item, err
	}
	inputHash, err := hashFile(file.source)
	if err != nil {
		return item, fmt.Errorf("hash input for existing-output check: %w", err)
	}
	item.InputSHA256 = inputHash
	outputHash, hashErr := hashFile(file.output)
	if hashErr == nil {
		item.OutputBytes = fileSize(file.output)
		item.OutputSHA256 = outputHash
	}
	item.Status = StatusSkippedExisting
	item.NeedsReview = file.public.Status == StatusNeedsReview
	if hashErr != nil {
		item.NeedsReview = true
	}
	old, ok := previousItem(previous, item.Input)
	if !ok {
		item.NeedsReview = true
		item.Reason = "output exists; preserved because no matching prior report record is available"
		return item, nil
	}
	if old.ConfigKey != item.ConfigKey || old.InputSHA256 != inputHash {
		item.NeedsReview = true
		item.Reason = "output exists; preserved because source or LUT/look configuration differs from the prior report"
		return item, nil
	}
	if hashErr != nil {
		item.NeedsReview = true
		item.Reason = "output exists; preserved because it could not be verified against the prior report"
		return item, nil
	}
	if !old.OutputVerified || old.OutputSHA256 == "" || old.OutputSHA256 != outputHash {
		item.NeedsReview = true
		item.Reason = "output exists; preserved because its contents differ from a previously verified result"
		return item, nil
	}
	item.OutputVerified = true
	item.SourceMetadata = old.SourceMetadata
	item.LogFile = old.LogFile
	item.Encoder = old.Encoder
	item.Reason = "output exists; source and LUT/look match the previously verified result"
	return item, nil
}

func previousItem(previous Report, input string) (ItemReport, bool) {
	for _, item := range previous.Items {
		if item.Input == input {
			return item, true
		}
	}
	for _, item := range previous.History {
		if item.Input == input {
			return item, true
		}
	}
	return ItemReport{}, false
}

func loadPreviousReport(path string) Report {
	data, err := os.ReadFile(path)
	if err != nil {
		return Report{}
	}
	var report Report
	if json.Unmarshal(data, &report) != nil || !strings.HasPrefix(report.GeneratedBy, "dji-lut-app/") {
		return Report{}
	}
	return report
}

func configKey(file filePlan, look Look) string {
	return strings.Join([]string{file.profile, file.camera, string(look), file.public.LUTSHA256, file.inputRange, file.inputMatrix}, "|")
}

func queryEncoders(ctx context.Context, ffmpeg string) (map[string]bool, error) {
	cmd := newCommandContext(ctx, ffmpeg, "-hide_banner", "-nostdin", "-encoders")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("%w %s", err, strings.TrimSpace(stderr.String()))
	}
	available := make(map[string]bool)
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && len(fields[0]) == 6 {
			available[fields[1]] = true
		}
	}
	return available, nil
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func linkNoReplace(ctx context.Context, temp, target, expectedHash string) error {
	if err := os.Link(temp, target); err == nil {
		return nil
	} else if os.IsExist(err) {
		return err
	}
	// Some removable filesystems do not support hard links. O_EXCL keeps the
	// fallback from ever opening or truncating an existing destination.
	destination, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	complete := false
	defer func() {
		_ = destination.Close()
		if !complete {
			_ = os.Remove(target)
		}
	}()
	source, err := os.Open(temp)
	if err != nil {
		return err
	}
	defer source.Close()
	digest := sha256.New()
	buffer := make([]byte, 1024*1024)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, readErr := source.Read(buffer)
		if n > 0 {
			written, err := destination.Write(buffer[:n])
			if err != nil {
				return err
			}
			if written != n {
				return io.ErrShortWrite
			}
			_, _ = digest.Write(buffer[:written])
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return readErr
		}
	}
	if got := hex.EncodeToString(digest.Sum(nil)); expectedHash != "" && got != expectedHash {
		return fmt.Errorf("fallback output SHA256 %s differs from expected %s", got, expectedHash)
	}
	if err := destination.Sync(); err != nil {
		return err
	}
	if err := destination.Close(); err != nil {
		return err
	}
	complete = true
	return nil
}

func writeJSONAtomic(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	encoder := json.NewEncoder(temp)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempName, path); err == nil {
		return nil
	} else if _, statErr := os.Stat(path); statErr == nil {
		if removeErr := os.Remove(path); removeErr != nil {
			return fmt.Errorf("replace %s: %w", path, err)
		}
		if retryErr := os.Rename(tempName, path); retryErr == nil {
			return nil
		} else {
			return fmt.Errorf("replace %s: %w", path, retryErr)
		}
	} else {
		return err
	}
}

func summarize(items []ItemReport) Summary {
	s := Summary{Total: len(items)}
	for _, item := range items {
		switch item.Status {
		case StatusEncoded:
			s.Encoded++
		case StatusCopiedNonLog, StatusCopiedHDR, StatusNeedsReview:
			s.Copied++
		case StatusSkippedExisting:
			s.Skipped++
		case StatusFailed:
			s.Failed++
		case StatusCancelled:
			s.Cancelled++
		}
		if item.NeedsReview {
			s.NeedsReview++
		}
	}
	return s
}

func slashRelOutput(value string) string { return filepath.ToSlash(value) }

func clamp(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func runFFmpeg(ctx context.Context, command []string, duration float64, progress func(float64), logPath string) (string, error) {
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return "", err
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return "", err
	}
	defer logFile.Close()
	cmd := newCommandContext(ctx, command[0], command[1:]...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return "", err
	}
	if err := cmd.Start(); err != nil {
		return "", err
	}
	var stderrTail []string
	var stderrMu sync.Mutex
	var readers sync.WaitGroup
	readers.Add(2)
	go func() {
		defer readers.Done()
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 4096), 1024*1024)
		var elapsed float64
		for scanner.Scan() {
			line := scanner.Text()
			parts := strings.SplitN(line, "=", 2)
			if len(parts) != 2 {
				continue
			}
			if parts[0] == "out_time_ms" {
				if value, parseErr := strconv.ParseFloat(parts[1], 64); parseErr == nil {
					elapsed = value / 1e6
				}
			} else if parts[0] == "out_time" {
				elapsed = parseClock(parts[1])
			}
			if parts[0] == "progress" && duration > 0 && progress != nil {
				progress(clamp(elapsed/duration*100, 0, 99.9))
			}
		}
	}()
	go func() {
		defer readers.Done()
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 4096), 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			_, _ = io.WriteString(logFile, line+"\n")
			stderrMu.Lock()
			stderrTail = append(stderrTail, line)
			if len(stderrTail) > 30 {
				stderrTail = stderrTail[len(stderrTail)-30:]
			}
			stderrMu.Unlock()
		}
	}()
	waitErr := cmd.Wait()
	readers.Wait()
	if ctx.Err() != nil {
		return strings.Join(lastN(stderrTail, 8), " | "), ctx.Err()
	}
	if waitErr != nil {
		return strings.Join(lastN(stderrTail, 8), " | "), fmt.Errorf("ffmpeg exited: %w", waitErr)
	}
	if progress != nil {
		progress(100)
	}
	return strings.Join(lastN(stderrTail, 8), " | "), nil
}

func parseClock(value string) float64 {
	parts := strings.Split(value, ":")
	if len(parts) != 3 {
		return 0
	}
	h, e1 := strconv.ParseFloat(parts[0], 64)
	m, e2 := strconv.ParseFloat(parts[1], 64)
	s, e3 := strconv.ParseFloat(parts[2], 64)
	if e1 != nil || e2 != nil || e3 != nil {
		return 0
	}
	return h*3600 + m*60 + s
}

func lastN(lines []string, n int) []string {
	if len(lines) > n {
		return lines[len(lines)-n:]
	}
	return lines
}

func buildFFmpegCommand(cfg normalizedConfig, file filePlan, temp string, encoder EncoderMode) []string {
	filter := fmt.Sprintf("scale=in_color_matrix=%s:out_color_matrix=bt709:in_range=%s:out_range=pc:flags=accurate_rnd+full_chroma_int,format=gbrpf32le,lut3d=file=%s:interp=tetrahedral,scale=in_color_matrix=bt709:out_color_matrix=bt709:in_range=pc:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p10le", file.inputMatrix, file.inputRange, escapeFilterPath(file.lut.File))
	command := []string{
		cfg.ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-loglevel", "warning", "-progress", "pipe:1", "-y",
		"-i", file.source, "-map", fmt.Sprintf("0:%d", file.video.Index), "-map", "0:a?",
		"-map_metadata", "0", "-map_chapters", "0", "-filter_threads", strconv.Itoa(cfg.filterThreads),
		"-vf", filter, "-fps_mode", "passthrough", "-c:a", "copy",
	}
	command = append(command, "-map_metadata:s:v:0", fmt.Sprintf("0:s:%d", file.video.Index))
	for ordinal, audio := range audioStreams(file.probe) {
		command = append(command, fmt.Sprintf("-map_metadata:s:a:%d", ordinal), fmt.Sprintf("0:s:%d", audio.Index))
	}
	if encoder == EncoderVideoToolbox {
		bitrate := sourceBitrate(file.video)
		if bitrate == "" {
			pixels := float64(file.video.Width * file.video.Height)
			fps := frameRate(file.video)
			if fps <= 0 {
				fps = 30
			}
			value := int64(clamp(pixels*fps*.1, 8e6, 160e6))
			bitrate = strconv.FormatInt(value, 10)
		}
		command = append(command, "-c:v", "hevc_videotoolbox", "-pix_fmt", "p010le", "-profile:v", "main10", "-b:v", bitrate, "-tag:v", "hvc1")
	} else {
		command = append(command, "-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-profile:v", "main10", "-crf", strconv.Itoa(cfg.crf), "-preset", cfg.preset, "-tag:v", "hvc1")
	}
	command = append(command,
		"-metadata", gammaTag+"=Rec.709", "-metadata", "source_gamma="+file.gamma,
		"-metadata:s:v:0", gammaTag+"=Rec.709", "-metadata:s:v:0", "source_gamma="+file.gamma,
		"-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
		"-metadata:s:v:0", "rotate=", "-movflags", "+faststart+use_metadata_tags", temp,
	)
	return command
}

func sourceBitrate(stream Stream) string {
	value, err := strconv.ParseInt(stream.BitRate, 10, 64)
	if err == nil && value > 0 {
		return strconv.FormatInt(value, 10)
	}
	return ""
}

func escapeFilterPath(value string) string {
	value = filepath.ToSlash(value)
	optionSpecial := map[rune]bool{'\\': true, '\'': true, ':': true}
	graphSpecial := map[rune]bool{'\\': true, '\'': true, '[': true, ']': true, ',': true, ';': true}
	var first strings.Builder
	for _, char := range value {
		if optionSpecial[char] {
			first.WriteRune('\\')
		}
		first.WriteRune(char)
	}
	var second strings.Builder
	for _, char := range first.String() {
		if graphSpecial[char] {
			second.WriteRune('\\')
		}
		second.WriteRune(char)
	}
	return second.String()
}

func encodeFile(ctx context.Context, cfg normalizedConfig, file filePlan, item ItemReport, previous Report, encoders map[string]bool, emit func(Event), progress func(float64)) (ItemReport, error) {
	before, err := os.Stat(file.source)
	if err != nil {
		return item, fmt.Errorf("stat input: %w", err)
	}
	inputHash, err := hashFile(file.source)
	if err != nil {
		return item, fmt.Errorf("hash input: %w", err)
	}
	item.InputSHA256 = inputHash
	if err := os.MkdirAll(filepath.Dir(file.output), 0o755); err != nil {
		return item, fmt.Errorf("create output folder: %w", err)
	}
	encoder, err := defaultEncoder(cfg, encoders)
	if err != nil {
		return item, err
	}
	initialEncoder := encoder
	var fallbackReason string
	var outputProbe Probe
	var tempName string
	var outputHash string
	for attempt := 0; attempt < 2; attempt++ {
		temp, tempErr := os.CreateTemp(filepath.Dir(file.output), "."+filepath.Base(file.output)+".*.partial.mp4")
		if tempErr != nil {
			return item, fmt.Errorf("create temporary output: %w", tempErr)
		}
		tempName = temp.Name()
		if closeErr := temp.Close(); closeErr != nil {
			os.Remove(tempName)
			return item, closeErr
		}
		command := buildFFmpegCommand(cfg, file, tempName, encoder)
		logRel := filepath.Join("logs", filepath.FromSlash(file.relative)+".ffmpeg.log")
		logPath := filepath.Join(cfg.outputRoot, logRel)
		item.LogFile = filepath.ToSlash(logRel)
		stderrTail, encodeErr := runFFmpeg(ctx, command, file.duration, progress, logPath)
		if encodeErr == nil {
			outputProbe, encodeErr = probeFile(ctx, tempName, cfg.ffprobe)
		}
		if encodeErr == nil {
			if problems := validateEncoded(file, outputProbe, encoder); len(problems) > 0 {
				encodeErr = fmt.Errorf("output validation failed: %s", strings.Join(problems, "; "))
			}
		}
		if encodeErr == nil {
			outputHash, encodeErr = hashFile(tempName)
		}
		if encodeErr != nil && stderrTail != "" {
			encodeErr = fmt.Errorf("%w: %s", encodeErr, stderrTail)
		}
		if encodeErr == nil {
			break
		}
		os.Remove(tempName)
		if attempt == 0 && cfg.Encoder == EncoderAuto && initialEncoder == EncoderVideoToolbox && encoder == EncoderVideoToolbox && encoders["libx265"] && ctx.Err() == nil {
			fallbackReason = encodeErr.Error()
			encoder = EncoderX265
			continue
		}
		if item.LogFile != "" {
			encodeErr = fmt.Errorf("%w (log: %s)", encodeErr, item.LogFile)
		}
		return item, encodeErr
	}
	defer os.Remove(tempName)
	after, err := os.Stat(file.source)
	if err != nil || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		return item, errors.New("source changed during encoding; discarded temporary output")
	}
	if _, err := os.Stat(file.output); err == nil {
		return item, errors.New("output appeared during encoding; preserved existing file")
	}
	if err := linkNoReplace(ctx, tempName, file.output, outputHash); err != nil {
		if os.IsExist(err) {
			return item, errors.New("output appeared during encoding; preserved existing file")
		}
		return item, fmt.Errorf("publish encoded video: %w", err)
	}
	item.Status = StatusEncoded
	item.Encoder = string(encoder)
	item.OutputBytes = fileSize(file.output)
	item.OutputSHA256 = outputHash
	item.OutputVerified = true
	if fallbackReason != "" {
		item.Reason = "VideoToolbox failed; x265 fallback succeeded: " + fallbackReason
	}
	if emit != nil {
		emit(Event{Type: "item_progress", Path: file.relative, Percent: 100, Message: "Encoding and validation complete"})
	}
	if progress != nil {
		progress(100)
	}
	return item, nil
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}

func validateEncoded(plan filePlan, output Probe, encoder EncoderMode) []string {
	var problems []string
	video, err := mainVideo(output)
	if err != nil {
		return []string{err.Error()}
	}
	expectedWidth, expectedHeight := plan.video.Width, plan.video.Height
	if plan.rotation == 90 || plan.rotation == 270 {
		expectedWidth, expectedHeight = expectedHeight, expectedWidth
	}
	if video.Width != expectedWidth {
		problems = append(problems, fmt.Sprintf("output width %d; expected %d after rotation", video.Width, expectedWidth))
	}
	if video.Height != expectedHeight {
		problems = append(problems, fmt.Sprintf("output height %d; expected %d after rotation", video.Height, expectedHeight))
	}
	if video.PixelFormat != "yuv420p10le" {
		problems = append(problems, fmt.Sprintf("output pixel format %q; expected yuv420p10le", video.PixelFormat))
	}
	for field, actual := range map[string]string{
		"color_range": video.ColorRange, "color_space": video.ColorSpace,
		"color_primaries": video.ColorPrimaries, "color_transfer": video.ColorTransfer,
	} {
		want := "bt709"
		if field == "color_range" {
			want = "tv"
		}
		if !strings.EqualFold(actual, want) {
			problems = append(problems, fmt.Sprintf("output %s %q; expected %s", field, actual, want))
		}
	}
	if expected, err := strconv.ParseInt(plan.video.NbFrames, 10, 64); err == nil && expected > 0 {
		actual, parseErr := strconv.ParseInt(video.NbFrames, 10, 64)
		if parseErr != nil || actual != expected {
			problems = append(problems, fmt.Sprintf("output frame count %q; expected %d", video.NbFrames, expected))
		}
	}
	sourceFPS, outputFPS := frameRate(plan.video), frameRate(video)
	if sourceFPS > 0 && outputFPS > 0 && absFloat(sourceFPS-outputFPS) > .01 {
		problems = append(problems, fmt.Sprintf("output frame rate %.6f; expected %.6f", outputFPS, sourceFPS))
	}
	sourceDuration, outputDuration := streamDuration(plan.video, plan.probe), streamDuration(video, output)
	if sourceDuration > 0 {
		tolerance := .05
		if sourceFPS > 0 {
			tolerance = 1/sourceFPS + .001
		}
		if outputDuration <= 0 || absFloat(outputDuration-sourceDuration) > tolerance {
			problems = append(problems, fmt.Sprintf("output video duration %.6fs; expected %.6fs (tolerance %.6fs)", outputDuration, sourceDuration, tolerance))
		}
	}
	sourceAudio, outputAudio := audioStreams(plan.probe), audioStreams(output)
	if len(sourceAudio) != len(outputAudio) {
		problems = append(problems, fmt.Sprintf("audio stream count changed from %d to %d", len(sourceAudio), len(outputAudio)))
	}
	for i := 0; i < len(sourceAudio) && i < len(outputAudio); i++ {
		sourceStream, outputStream := sourceAudio[i], outputAudio[i]
		if sourceStream.CodecName != outputStream.CodecName || sourceStream.SampleRate != outputStream.SampleRate || sourceStream.Channels != outputStream.Channels {
			problems = append(problems, fmt.Sprintf("audio stream %d codec/rate/channels changed", i))
		}
		if sourceStream.ChannelLayout != "" && !strings.EqualFold(sourceStream.ChannelLayout, outputStream.ChannelLayout) {
			problems = append(problems, fmt.Sprintf("audio stream %d channel layout changed", i))
		}
		sourceAudioDuration := streamDuration(sourceStream, plan.probe)
		outputAudioDuration := streamDuration(outputStream, output)
		if sourceAudioDuration > 0 {
			tolerance := .1
			if sampleRate, parseErr := strconv.Atoi(sourceStream.SampleRate); parseErr == nil && sampleRate > 0 {
				tolerance = max(tolerance, 2*1024/float64(sampleRate))
			}
			if outputAudioDuration <= 0 || absFloat(sourceAudioDuration-outputAudioDuration) > tolerance {
				problems = append(problems, fmt.Sprintf("audio stream %d duration changed from %.6fs to %.6fs", i, sourceAudioDuration, outputAudioDuration))
			}
		}
	}
	if values := metadataValues(output, gammaTag); len(values) == 0 {
		problems = append(problems, "output DJI gamma tag is missing")
	} else {
		for _, value := range values {
			if value != "Rec.709" {
				problems = append(problems, "output DJI gamma tag is not Rec.709")
				break
			}
		}
	}
	_ = encoder
	return problems
}

func audioStreams(probe Probe) []Stream {
	var audio []Stream
	for _, stream := range probe.Streams {
		if strings.EqualFold(stream.CodecType, "audio") {
			audio = append(audio, stream)
		}
	}
	return audio
}
