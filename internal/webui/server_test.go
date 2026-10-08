package webui

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

type testBackend struct {
	previews    int
	folderPicks int
}

func (b *testBackend) Bootstrap() any { return map[string]any{"ready": true} }
func (b *testBackend) Preview(_ context.Context, raw json.RawMessage) (any, error) {
	b.previews++
	return map[string]any{"accepted": json.Valid(raw)}, nil
}
func (b *testBackend) Start(context.Context, json.RawMessage) (any, error) {
	return map[string]any{"running": true}, nil
}
func (b *testBackend) SelectFolder(_ context.Context, raw json.RawMessage) (any, error) {
	b.folderPicks++
	var request struct {
		Target string `json:"target"`
	}
	_ = json.Unmarshal(raw, &request)
	return map[string]any{"path": "/selected", "cancelled": false, "target": request.Target}, nil
}
func (*testBackend) State() any        { return map[string]any{"running": false} }
func (*testBackend) Cancel()           {}
func (*testBackend) Wait()             {}
func (*testBackend) Close()            {}
func (*testBackend) OpenOutput() error { return nil }

func TestLocalUIRequiresTokenAndSameOriginForCommands(t *testing.T) {
	backend := &testBackend{}
	server, err := New(0, backend)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()

	launch, err := url.Parse(server.URL())
	if err != nil {
		t.Fatal(err)
	}
	fragment, err := url.ParseQuery(launch.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	token := fragment.Get("token")
	if len(token) != 64 {
		t.Fatalf("launch token length = %d, want 64 hex characters", len(token))
	}
	origin := "http://" + launch.Host
	client := &http.Client{Timeout: time.Second}

	page, err := client.Get(origin + "/")
	if err != nil {
		t.Fatal(err)
	}
	pageBody, _ := io.ReadAll(page.Body)
	_ = page.Body.Close()
	if page.StatusCode != http.StatusOK || !strings.Contains(string(pageBody), "DJI 视频色彩还原") {
		t.Fatalf("embedded page status/body did not load: %d", page.StatusCode)
	}
	for _, requiredText := range []string{"扫描并预览", "开始还原", "包含子文件夹", "标记“待确认”", "关闭应用", "计划使用 / 候选 LUT", "实际使用 / 候选 LUT"} {
		if !strings.Contains(string(pageBody), requiredText) {
			t.Errorf("embedded Chinese UI is missing %q", requiredText)
		}
	}
	if strings.Contains(string(pageBody), token) {
		t.Fatal("access token was embedded in page response")
	}
	translations, err := client.Get(origin + "/i18n.js")
	if err != nil {
		t.Fatal(err)
	}
	translationBody, _ := io.ReadAll(translations.Body)
	_ = translations.Body.Close()
	if translations.StatusCode != http.StatusOK || len(translationBody) == 0 || !strings.Contains(translations.Header.Get("Content-Type"), "javascript") {
		t.Fatal("embedded translation module was not served as JavaScript")
	}
	if translations.Header.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(translations.Header.Get("Content-Security-Policy"), "script-src 'self'") || strings.Contains(string(translationBody), token) {
		t.Fatal("translation module did not preserve static-resource security boundaries")
	}
	blockedResource, err := client.Get(origin + "/unlisted-translation.js")
	if err != nil {
		t.Fatal(err)
	}
	_ = blockedResource.Body.Close()
	if blockedResource.StatusCode != http.StatusNotFound {
		t.Fatal("static resource allowlist accepted an unlisted JavaScript file")
	}

	unauthorized, err := client.Get(origin + "/api/bootstrap")
	if err != nil {
		t.Fatal(err)
	}
	_ = unauthorized.Body.Close()
	if unauthorized.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthorized bootstrap status = %d, want 401", unauthorized.StatusCode)
	}

	unauthorizedPick, _ := http.NewRequest(http.MethodPost, origin+"/api/select-folder", strings.NewReader(`{"target":"input","path":"/tmp"}`))
	unauthorizedPick.Header.Set("Content-Type", "application/json")
	unauthorizedPick.Header.Set("Origin", origin)
	deniedPick, err := client.Do(unauthorizedPick)
	if err != nil {
		t.Fatal(err)
	}
	_ = deniedPick.Body.Close()
	if deniedPick.StatusCode != http.StatusUnauthorized || backend.folderPicks != 0 {
		t.Fatalf("unauthorized picker status/count = %d/%d, want 401/0", deniedPick.StatusCode, backend.folderPicks)
	}

	request, _ := http.NewRequest(http.MethodGet, origin+"/api/bootstrap", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Origin", origin)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("authorized bootstrap status = %d, want 200", response.StatusCode)
	}

	pickRequest, _ := http.NewRequest(http.MethodPost, origin+"/api/select-folder", strings.NewReader(`{"target":"output","path":"/tmp"}`))
	pickRequest.Header.Set("Authorization", "Bearer "+token)
	pickRequest.Header.Set("Content-Type", "application/json")
	pickRequest.Header.Set("Origin", origin)
	pickRequest.Header.Set("Sec-Fetch-Site", "same-origin")
	pickResponse, err := client.Do(pickRequest)
	if err != nil {
		t.Fatal(err)
	}
	pickBody, _ := io.ReadAll(pickResponse.Body)
	_ = pickResponse.Body.Close()
	if pickResponse.StatusCode != http.StatusOK || backend.folderPicks != 1 || !strings.Contains(string(pickBody), `"cancelled":false`) {
		t.Fatalf("authorized picker status/count/body = %d/%d/%s", pickResponse.StatusCode, backend.folderPicks, pickBody)
	}

	body := strings.NewReader(`{"input":"/tmp/videos","look":"standard"}`)
	command, _ := http.NewRequest(http.MethodPost, origin+"/api/preview", body)
	command.Header.Set("Authorization", "Bearer "+token)
	command.Header.Set("Content-Type", "application/json")
	command.Header.Set("Origin", "https://attacker.example")
	denied, err := client.Do(command)
	if err != nil {
		t.Fatal(err)
	}
	_ = denied.Body.Close()
	if denied.StatusCode != http.StatusUnauthorized && denied.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin preview status = %d, want 401 or 403", denied.StatusCode)
	}
	if backend.previews != 0 {
		t.Fatal("cross-origin request reached the backend")
	}

	command, _ = http.NewRequest(http.MethodPost, origin+"/api/preview", strings.NewReader(`{"input":"/tmp/videos"}`))
	command.Header.Set("Authorization", "Bearer "+token)
	command.Header.Set("Content-Type", "application/json")
	command.Header.Set("Origin", origin)
	command.Header.Set("Sec-Fetch-Site", "same-origin")
	accepted, err := client.Do(command)
	if err != nil {
		t.Fatal(err)
	}
	_ = accepted.Body.Close()
	if accepted.StatusCode != http.StatusOK || backend.previews != 1 {
		t.Fatalf("same-origin preview status/count = %d/%d, want 200/1", accepted.StatusCode, backend.previews)
	}

	spoofed, _ := http.NewRequest(http.MethodGet, origin+"/", nil)
	spoofed.Host = "localhost:" + launch.Port()
	blocked, err := client.Do(spoofed)
	if err != nil {
		t.Fatal(err)
	}
	_ = blocked.Body.Close()
	if blocked.StatusCode != http.StatusBadRequest {
		t.Fatalf("spoofed Host status = %d, want 400", blocked.StatusCode)
	}
}
