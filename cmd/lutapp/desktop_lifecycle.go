package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"
)

const desktopShutdownTimeout = 5 * time.Second

type desktopApplication interface {
	Close()
}

type desktopHTTPServer interface {
	Done() <-chan struct{}
	Shutdown(context.Context) error
}

type desktopReadyMessage struct {
	Type     string `json:"type"`
	Protocol int    `json:"protocol"`
	URL      string `json:"url"`
}

func writeDesktopReady(output io.Writer, location string) error {
	return json.NewEncoder(output).Encode(desktopReadyMessage{
		Type:     "ready",
		Protocol: 1,
		URL:      location,
	})
}

// runDesktopLifecycle waits for the parent process, a termination signal, or
// the HTTP server to stop. Closing the application first cancels and joins any
// active scan, picker, or encode before HTTP shutdown is allowed to finish.
func runDesktopLifecycle(stdin io.Reader, signals <-chan os.Signal, app desktopApplication, server desktopHTTPServer) int {
	stopSignal := waitDesktopStop(stdin, signals, server.Done())
	app.Close()

	ctx, cancel := context.WithTimeout(context.Background(), desktopShutdownTimeout)
	err := server.Shutdown(ctx)
	cancel()
	if err != nil {
		fmt.Fprintf(os.Stderr, "关闭本机界面服务失败：%v\n", err)
	}

	if stopSignal == nil {
		return 0
	}
	return desktopSignalExitCode(stopSignal)
}

func waitDesktopStop(stdin io.Reader, signals <-chan os.Signal, serverDone <-chan struct{}) os.Signal {
	var parentClosed <-chan struct{}
	if stdin != nil {
		closed := make(chan struct{})
		parentClosed = closed
		go func() {
			_, _ = io.Copy(io.Discard, stdin)
			close(closed)
		}()
	}

	for {
		select {
		case <-parentClosed:
			return nil
		case sig, ok := <-signals:
			if !ok {
				signals = nil
				continue
			}
			if sig != nil {
				return sig
			}
		case <-serverDone:
			return nil
		}
	}
}

func desktopSignalExitCode(sig os.Signal) int {
	if sig == os.Interrupt {
		return 130
	}
	// The desktop signal subscription includes SIGTERM on Unix. Returning the
	// conventional 128+15 status also gives parent processes a clear result.
	return 143
}
