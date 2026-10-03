package webui

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

// Backend is the small application boundary used by the local browser UI.
// Payloads stay JSON here so the server does not depend on engine internals.
type Backend interface {
	Bootstrap() any
	Preview(context.Context, json.RawMessage) (any, error)
	Start(context.Context, json.RawMessage) (any, error)
	State() any
	Cancel()
	Wait()
	OpenOutput() error
}

type Server struct {
	listener net.Listener
	http     *http.Server
	backend  Backend
	token    string
	origin   string
	done     chan struct{}
}

// New binds only to IPv4 loopback on the requested port. Port zero asks the OS
// for an available port. The generated token is passed in the page fragment,
// which browsers do not send in HTTP requests or Referer headers.
func New(port int, backend Backend) (*Server, error) {
	if backend == nil {
		return nil, errors.New("webui: backend is required")
	}
	if port < 0 || port > 65535 {
		return nil, errors.New("webui: port must be between 0 and 65535")
	}
	listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", fmt.Sprint(port)))
	if err != nil {
		return nil, fmt.Errorf("webui: listen on 127.0.0.1:%d: %w", port, err)
	}
	addr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		_ = listener.Close()
		return nil, errors.New("webui: listener did not return a TCP address")
	}
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("webui: create access token: %w", err)
	}
	host := net.JoinHostPort("127.0.0.1", fmt.Sprint(addr.Port))
	s := &Server{
		listener: listener,
		backend:  backend,
		token:    hex.EncodeToString(random[:]),
		origin:   "http://" + host,
		done:     make(chan struct{}),
	}
	s.http = &http.Server{
		Handler:           s.handler(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	go func() {
		defer close(s.done)
		_ = s.http.Serve(listener)
	}()
	return s, nil
}

// URL returns the only URL that contains the access token. The token is in a
// fragment, so it is available to this app's script without being sent to the
// local HTTP server as part of the request target.
func (s *Server) URL() string {
	return s.origin + "/#token=" + url.QueryEscape(s.token)
}

// Origin returns the exact loopback origin used by this server.
func (s *Server) Origin() string { return s.origin }

// Done is closed when the HTTP server stops.
func (s *Server) Done() <-chan struct{} { return s.done }

// Shutdown closes the listener and waits for outstanding requests to finish.
func (s *Server) Shutdown(ctx context.Context) error {
	if err := s.http.Shutdown(ctx); err != nil {
		_ = s.listener.Close()
		return err
	}
	return nil
}

func (s *Server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.static)
	mux.HandleFunc("/api/bootstrap", s.api(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, s.backend.Bootstrap())
	}))
	mux.HandleFunc("/api/state", s.api(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, s.backend.State())
	}))
	mux.HandleFunc("/api/preview", s.api(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		payload, err := readPayload(r)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		result, err := s.backend.Preview(r.Context(), payload)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, result)
	}))
	mux.HandleFunc("/api/run", s.api(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		payload, err := readPayload(r)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		result, err := s.backend.Start(r.Context(), payload)
		if err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeJSON(w, http.StatusAccepted, result)
	}))
	mux.HandleFunc("/api/cancel", s.api(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		s.backend.Cancel()
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("/api/open-output", s.api(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		if err := s.backend.OpenOutput(); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("/api/shutdown", s.api(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		s.backend.Cancel()
		s.backend.Wait()
		writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = s.Shutdown(ctx)
		}()
	}))
	return securityHeaders(s.hostGuard(mux))
}

type apiHandler func(http.ResponseWriter, *http.Request)

func (s *Server) api(method string, handler apiHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != method {
			w.Header().Set("Allow", method)
			writeError(w, http.StatusMethodNotAllowed, "不支持此请求方法")
			return
		}
		if !s.authorized(r) {
			writeError(w, http.StatusUnauthorized, "本机访问令牌无效或页面来源不匹配")
			return
		}
		if method == http.MethodPost {
			if origin := r.Header.Get("Origin"); origin != s.origin {
				writeError(w, http.StatusForbidden, "拒绝跨站请求")
				return
			}
			if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
				writeError(w, http.StatusForbidden, "拒绝跨站请求")
				return
			}
		}
		handler(w, r)
	}
}

func (s *Server) authorized(r *http.Request) bool {
	const prefix = "Bearer "
	value := r.Header.Get("Authorization")
	if !strings.HasPrefix(value, prefix) {
		return false
	}
	provided := strings.TrimPrefix(value, prefix)
	if len(provided) != len(s.token) || subtle.ConstantTimeCompare([]byte(provided), []byte(s.token)) != 1 {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != s.origin {
		return false
	}
	return true
}

func (s *Server) hostGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != strings.TrimPrefix(s.origin, "http://") {
			writeError(w, http.StatusBadRequest, "仅允许通过本机地址访问")
			return
		}
		if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
			ip := net.ParseIP(host)
			if ip == nil || !ip.IsLoopback() {
				writeError(w, http.StatusForbidden, "仅允许本机访问")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeError(w, http.StatusMethodNotAllowed, "不支持此请求方法")
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "." || name == "" {
		name = "index.html"
	}
	if name != "index.html" && name != "app.js" && name != "app.css" {
		http.NotFound(w, r)
		return
	}
	data, err := assets.ReadFile("static/" + name)
	if err != nil {
		http.Error(w, "应用界面资源不可用", http.StatusInternalServerError)
		return
	}
	contentType := mime.TypeByExtension(path.Ext(name))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType+map[bool]string{true: "; charset=utf-8", false: ""}[strings.HasPrefix(contentType, "text/") || contentType == "application/javascript"])
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		_, _ = w.Write(data)
	}
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

func readPayload(r *http.Request) (json.RawMessage, error) {
	if mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mediaType != "application/json" {
		return nil, errors.New("请求必须使用 application/json")
	}
	r.Body = http.MaxBytesReader(nil, r.Body, 1<<20)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, fmt.Errorf("读取请求失败: %w", err)
	}
	if len(data) == 0 {
		return json.RawMessage("{}"), nil
	}
	if !json.Valid(data) {
		return nil, errors.New("请求内容不是有效 JSON")
	}
	return data, nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
