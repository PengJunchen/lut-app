package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestParseCLIDesktopModeAndBatchIncompatibility(t *testing.T) {
	options, err := parseCLI([]string{"--desktop", "--input", "/videos"}, "/default")
	if err != nil {
		t.Fatal(err)
	}
	if !options.desktop || options.batch || options.input != "/videos" || options.port != 0 {
		t.Fatalf("desktop options = %#v", options)
	}

	if _, err := parseCLI([]string{"--desktop", "--batch"}, "/default"); err == nil || !strings.Contains(err.Error(), "--batch") {
		t.Fatalf("desktop+batch error = %v, want incompatibility error", err)
	}
}

func TestParseCLIHelpRetainsVisibleUsage(t *testing.T) {
	if _, err := parseCLI([]string{"--help"}, "/default"); !errors.Is(err, flag.ErrHelp) {
		t.Fatalf("help parse error = %v, want flag.ErrHelp", err)
	}
	var output bytes.Buffer
	writeCLIUsage(&output)
	for _, expected := range []string{"Usage of lutapp:", "-desktop", "-batch", "-input"} {
		if !strings.Contains(output.String(), expected) {
			t.Errorf("help output is missing %q: %s", expected, output.String())
		}
	}
}

func TestWriteDesktopReadyEmitsOneCompactNDJSONRecord(t *testing.T) {
	var output bytes.Buffer
	location := "http://127.0.0.1:43210/#token=012345"
	if err := writeDesktopReady(&output, location); err != nil {
		t.Fatal(err)
	}
	want := `{"type":"ready","protocol":1,"url":"http://127.0.0.1:43210/#token=012345"}` + "\n"
	if output.String() != want {
		t.Fatalf("ready output = %q, want exactly %q", output.String(), want)
	}
}

func TestDesktopLifecycleParentEOFClosesApplicationThenServer(t *testing.T) {
	operationDone := make(chan struct{})
	app := &testDesktopApplication{closed: operationDone}
	server := &testDesktopHTTPServer{done: make(chan struct{}), requireClosed: operationDone}
	code := runDesktopLifecycle(strings.NewReader("parent data"), make(chan os.Signal), app, server)

	if code != 0 {
		t.Fatalf("lifecycle exit code = %d, want 0", code)
	}
	if app.closeCalls != 1 {
		t.Fatalf("application Close calls = %d, want 1", app.closeCalls)
	}
	if server.shutdownCalls != 1 || !server.sawDeadline || !server.applicationClosed {
		t.Fatalf("server shutdown state = calls:%d deadline:%v app-closed:%v", server.shutdownCalls, server.sawDeadline, server.applicationClosed)
	}
}

func TestDesktopLifecycleInterruptReturns130AfterCleanup(t *testing.T) {
	reader := &blockedDesktopReader{entered: make(chan struct{}), release: make(chan struct{}), finished: make(chan struct{})}
	app := &testDesktopApplication{closed: make(chan struct{})}
	server := &testDesktopHTTPServer{done: make(chan struct{}), requireClosed: app.closed}
	signals := make(chan os.Signal, 1)
	result := make(chan int, 1)
	go func() {
		result <- runDesktopLifecycle(reader, signals, app, server)
	}()

	select {
	case <-reader.entered:
	case <-time.After(time.Second):
		t.Fatal("parent stdin reader did not start")
	}
	signals <- os.Interrupt

	select {
	case code := <-result:
		if code != 130 {
			t.Fatalf("interrupt exit code = %d, want 130", code)
		}
	case <-time.After(time.Second):
		t.Fatal("interrupt did not complete lifecycle")
	}
	close(reader.release)
	select {
	case <-reader.finished:
	case <-time.After(time.Second):
		t.Fatal("parent stdin reader did not stop after release")
	}
	if app.closeCalls != 1 || server.shutdownCalls != 1 || !server.applicationClosed {
		t.Fatalf("cleanup state = app:%d server:%d app-closed:%v", app.closeCalls, server.shutdownCalls, server.applicationClosed)
	}
}

type testDesktopApplication struct {
	closeCalls int
	closed     chan struct{}
}

func (a *testDesktopApplication) Close() {
	a.closeCalls++
	if a.closed != nil {
		select {
		case <-a.closed:
		default:
			close(a.closed)
		}
	}
}

type testDesktopHTTPServer struct {
	done              chan struct{}
	shutdownCalls     int
	sawDeadline       bool
	applicationClosed bool
	requireClosed     <-chan struct{}
}

func (s *testDesktopHTTPServer) Done() <-chan struct{} { return s.done }

func (s *testDesktopHTTPServer) Shutdown(ctx context.Context) error {
	s.shutdownCalls++
	_, s.sawDeadline = ctx.Deadline()
	if s.requireClosed != nil {
		select {
		case <-s.requireClosed:
			s.applicationClosed = true
		default:
		}
	}
	return nil
}

type blockedDesktopReader struct {
	entered  chan struct{}
	release  chan struct{}
	finished chan struct{}
	once     sync.Once
}

func (r *blockedDesktopReader) Read([]byte) (int, error) {
	r.once.Do(func() { close(r.entered) })
	<-r.release
	close(r.finished)
	return 0, io.EOF
}
