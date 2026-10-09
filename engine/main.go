// SROAD — AI music studio for macOS (vocal removal, stem separation, key/tempo change, editing)
// made by. Nevertheless_D
package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// build is the app version, set with -ldflags "-X main.build=1.2.3".
var build = "0.0.0-dev"

//go:embed web
var webFiles embed.FS

//go:embed worker.py
var workerPy []byte

type Settings struct {
	Appearance    string         `json:"appearance"`    // system | light | dark
	DefaultFolder string         `json:"defaultFolder"` // "" = ~/Music/SROAD
	AutoSave      bool           `json:"autoSave"`
	RevealAfter   bool           `json:"revealAfter"`
	AutoUpdate    bool           `json:"autoUpdate"`
	UI            map[string]any `json:"ui"`
}

type App struct {
	support string
	token   string
	port    int
	binDir  string
	workDir string

	mu       sync.Mutex
	settings Settings

	lib   *Library
	jobs  *JobManager
	setup *Setup
	upd   *Updater

	lastSeen atomic.Int64
}

var app *App

func main() {
	log.SetFlags(log.LstdFlags)
	home, _ := os.UserHomeDir()
	support := os.Getenv("SROAD_SUPPORT")
	if support == "" {
		switch runtime.GOOS {
		case "darwin":
			support = filepath.Join(home, "Library", "Application Support", "SROAD")
		case "windows":
			support = filepath.Join(os.Getenv("LOCALAPPDATA"), "SROAD")
		default:
			support = filepath.Join(home, ".sroad")
		}
	}
	token := os.Getenv("SROAD_TOKEN")
	if token == "" {
		token = randID(16)
	}
	restart := os.Getenv("SROAD_RESTART") != ""

	app = &App{
		support: support,
		token:   token,
		binDir:  filepath.Join(support, "bin"),
		workDir: filepath.Join(support, "work"),
	}
	os.MkdirAll(app.binDir, 0o755)
	if !restart {
		os.RemoveAll(app.workDir)
	}
	os.MkdirAll(app.workDir, 0o755)
	if f, err := os.OpenFile(filepath.Join(support, "engine.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644); err == nil {
		log.SetOutput(io.MultiWriter(os.Stderr, f))
	}
	os.WriteFile(filepath.Join(support, "worker.py"), workerPy, 0o644)
	app.loadSettings()
	app.lastSeen.Store(time.Now().Unix())

	app.lib = NewLibrary(app.workDir)
	if restart {
		app.lib.Load()
	}
	app.setup = NewSetup(support, app.binDir)
	app.jobs = NewJobManager()
	app.upd = NewUpdater(support)

	ln := listen(os.Getenv("SROAD_PORT"))
	app.port = ln.Addr().(*net.TCPAddr).Port
	writeFileAtomic(filepath.Join(support, "token"), []byte(token), 0o600)
	writeFileAtomic(filepath.Join(support, "port"), []byte(strconv.Itoa(app.port)), 0o644)
	log.Printf("SROAD %s listening on %d", build, app.port)

	go app.idleWatcher()
	go app.upd.autoLoop()
	go app.jobs.run()
	go app.jobs.runQuick()
	srv := &http.Server{Handler: hostGuard(app.routes())}
	log.Fatal(srv.Serve(ln))
}

func listen(pref string) net.Listener {
	if p, err := strconv.Atoi(pref); err == nil && p > 0 {
		for i := 0; i < 20; i++ {
			if ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p)); err == nil {
				return ln
			}
			time.Sleep(150 * time.Millisecond)
		}
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	return ln
}

// ---------------------------------------------------------------- lifecycle

// 창을 닫고 10분 동안 아무 요청이 없고 진행 중인 작업도 없으면 스스로 종료합니다.
func (a *App) idleWatcher() {
	for range time.Tick(15 * time.Second) {
		idle := time.Now().Unix() - a.lastSeen.Load()
		if idle > 600 && !a.jobs.Busy() && !a.setup.Running() && !a.upd.Busy() {
			a.shutdown(false)
		}
	}
}

func (a *App) shutdown(keepWork bool) {
	a.jobs.CancelAll()
	if keepWork {
		a.lib.Save()
	} else {
		os.RemoveAll(a.workDir)
	}
	if b, err := os.ReadFile(filepath.Join(a.support, "port")); err == nil && string(b) == strconv.Itoa(a.port) {
		os.Remove(filepath.Join(a.support, "port"))
	}
	os.Exit(0)
}

// ---------------------------------------------------------------- settings

func (a *App) settingsPath() string { return filepath.Join(a.support, "settings.json") }

func (a *App) loadSettings() {
	a.settings = Settings{Appearance: "system", AutoSave: true, AutoUpdate: true, UI: map[string]any{}}
	if b, err := os.ReadFile(a.settingsPath()); err == nil {
		_ = json.Unmarshal(b, &a.settings)
	}
	if a.settings.UI == nil {
		a.settings.UI = map[string]any{}
	}
}

func (a *App) saveSettings() {
	b, _ := json.MarshalIndent(a.settings, "", "  ")
	writeFileAtomic(a.settingsPath(), b, 0o644)
}

func (a *App) Settings() Settings {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.settings
}

func musicFolder() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Music", "SROAD")
}

func (a *App) resolvedDefaultFolder() string {
	if f := a.Settings().DefaultFolder; f != "" {
		if st, err := os.Stat(f); err == nil && st.IsDir() {
			return f
		}
	}
	return musicFolder()
}

// ---------------------------------------------------------------- routes

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(webFiles, "web")
	static := http.FileServer(http.FS(sub))

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			if r.URL.Query().Get("t") != a.token {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				w.WriteHeader(http.StatusForbidden)
				io.WriteString(w, "<meta charset=utf-8><body style='font:15px -apple-system;padding:40px'>SROAD 앱을 다시 실행해 주세요.</body>")
				return
			}
			b, _ := webFiles.ReadFile("web/index.html")
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Write(b)
			return
		}
		if strings.HasSuffix(r.URL.Path, ".js") || strings.HasSuffix(r.URL.Path, ".css") {
			w.Header().Set("Cache-Control", "no-cache")
		}
		static.ServeHTTP(w, r)
	})

	api := func(path string, h http.HandlerFunc) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			t := r.Header.Get("x-token")
			if t == "" {
				t = r.URL.Query().Get("t")
			}
			if t != a.token {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			a.lastSeen.Store(time.Now().Unix())
			h(w, r)
		})
	}

	api("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true, "build": build})
	})
	api("/api/quit", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true})
		go func() { time.Sleep(300 * time.Millisecond); a.shutdown(false) }()
	})
	api("/api/poll", a.handlePoll)
	api("/api/settings", a.handleSettings)
	api("/api/choose-folder", a.handleChooseFolder)
	api("/api/reveal", a.handleReveal)
	api("/api/open", a.handleOpen)

	api("/api/upload", a.handleUpload)
	api("/api/remove", a.handleRemove)
	api("/api/stream", a.handleStream)
	api("/api/pcm", a.handlePCM)

	api("/api/jobs", a.handleJobs)
	api("/api/job/cancel", a.handleJobCancel)
	api("/api/jobs/cancel-all", func(w http.ResponseWriter, r *http.Request) {
		a.jobs.CancelAll()
		writeJSON(w, map[string]any{"ok": true})
	})
	api("/api/jobs/clear", func(w http.ResponseWriter, r *http.Request) {
		a.jobs.ClearFinished()
		writeJSON(w, map[string]any{"ok": true})
	})
	api("/api/export", a.handleExport)
	api("/api/save-item", a.handleSaveItem)

	api("/api/setup/start", func(w http.ResponseWriter, r *http.Request) {
		a.setup.Start(false)
		writeJSON(w, map[string]any{"ok": true})
	})
	api("/api/setup/reinstall", func(w http.ResponseWriter, r *http.Request) {
		a.setup.Start(true)
		writeJSON(w, map[string]any{"ok": true})
	})

	api("/api/update/check", func(w http.ResponseWriter, r *http.Request) {
		a.upd.Check(true)
		writeJSON(w, a.upd.State())
	})
	api("/api/update/install", func(w http.ResponseWriter, r *http.Request) {
		go a.upd.Install()
		writeJSON(w, map[string]any{"ok": true})
	})
	api("/api/update/rollback", func(w http.ResponseWriter, r *http.Request) {
		if err := a.upd.Rollback(); err != nil {
			jsonError(w, 500, err.Error())
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	})
	api("/api/update/restart", func(w http.ResponseWriter, r *http.Request) {
		if err := a.upd.Restart(a.port, a.token); err != nil {
			jsonError(w, 500, err.Error())
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	})
	return mux
}

// Only answer requests addressed to 127.0.0.1 / localhost (DNS rebinding protection).
func hostGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		if host != "127.0.0.1" && host != "localhost" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) handlePoll(w http.ResponseWriter, r *http.Request) {
	since, _ := strconv.ParseInt(r.URL.Query().Get("rev"), 10, 64)
	out := map[string]any{
		"build":  build,
		"jobs":   a.jobs.Snapshot(),
		"setup":  a.setup.State(),
		"update": a.upd.State(),
	}
	rev, items := a.lib.SnapshotIfChanged(since)
	out["rev"] = rev
	if items != nil {
		out["items"] = items
	}
	writeJSON(w, out)
}

func (a *App) handleSettings(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	if r.Method == http.MethodPost {
		var in map[string]json.RawMessage
		if err := readJSON(r, &in); err != nil {
			a.mu.Unlock()
			jsonError(w, 400, "bad request")
			return
		}
		for k, v := range in {
			switch k {
			case "appearance":
				json.Unmarshal(v, &a.settings.Appearance)
			case "defaultFolder":
				json.Unmarshal(v, &a.settings.DefaultFolder)
			case "autoSave":
				json.Unmarshal(v, &a.settings.AutoSave)
			case "revealAfter":
				json.Unmarshal(v, &a.settings.RevealAfter)
			case "autoUpdate":
				json.Unmarshal(v, &a.settings.AutoUpdate)
			case "ui":
				var ui map[string]any
				if json.Unmarshal(v, &ui) == nil {
					for kk, vv := range ui {
						a.settings.UI[kk] = vv
					}
				}
			}
		}
		a.saveSettings()
	}
	s := a.settings
	a.mu.Unlock()
	home, _ := os.UserHomeDir()
	writeJSON(w, map[string]any{
		"appearance":            s.Appearance,
		"defaultFolder":         s.DefaultFolder,
		"resolvedDefaultFolder": a.resolvedDefaultFolder(),
		"musicFolder":           musicFolder(),
		"autoSave":              s.AutoSave,
		"revealAfter":           s.RevealAfter,
		"autoUpdate":            s.AutoUpdate,
		"ui":                    s.UI,
		"home":                  home,
		"build":                 build,
		"platform":              runtime.GOOS + "/" + runtime.GOARCH,
	})
}

// ---------------------------------------------------------------- OS helpers

func (a *App) handleChooseFolder(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Start  string `json:"start"`
		Prompt string `json:"prompt"`
	}
	readJSON(r, &in)
	if t := os.Getenv("SROAD_TEST_CHOOSE"); t != "" {
		writeJSON(w, map[string]any{"ok": true, "path": t})
		return
	}
	if runtime.GOOS != "darwin" {
		jsonError(w, 501, "macOS에서만 지원해요")
		return
	}
	start := in.Start
	if st, err := os.Stat(start); err != nil || !st.IsDir() {
		start, _ = os.UserHomeDir()
	}
	prompt := in.Prompt
	if prompt == "" {
		prompt = "결과 파일을 저장할 폴더를 선택하세요"
	}
	script := []string{
		"on run argv",
		"activate",
		"try",
		"set f to choose folder with prompt (item 2 of argv) default location (POSIX file (item 1 of argv))",
		"return POSIX path of f",
		"on error number -128",
		"return \"\"",
		"end try",
		"end run",
	}
	args := []string{}
	for _, l := range script {
		args = append(args, "-e", l)
	}
	args = append(args, start, prompt)
	out, err := exec.Command("/usr/bin/osascript", args...).Output()
	if err != nil {
		jsonError(w, 500, "폴더 선택 창을 열지 못했어요")
		return
	}
	p := strings.TrimSpace(string(out))
	if p != "/" {
		p = strings.TrimSuffix(p, "/")
	}
	writeJSON(w, map[string]any{"ok": true, "path": p})
}

func (a *App) handleReveal(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Paths []string `json:"paths"`
	}
	readJSON(r, &in)
	reveal(in.Paths)
	writeJSON(w, map[string]any{"ok": true})
}

func (a *App) handleOpen(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path string `json:"path"`
	}
	readJSON(r, &in)
	if in.Path != "" {
		os.MkdirAll(in.Path, 0o755)
		if runtime.GOOS == "darwin" {
			exec.Command("/usr/bin/open", in.Path).Start()
		}
	}
	writeJSON(w, map[string]any{"ok": true})
}

func reveal(paths []string) {
	if runtime.GOOS != "darwin" || len(paths) == 0 {
		return
	}
	if len(paths) == 1 {
		exec.Command("/usr/bin/open", "-R", paths[0]).Start()
		return
	}
	exec.Command("/usr/bin/open", commonDir(paths)).Start()
}

func commonDir(paths []string) string {
	dir := filepath.Dir(paths[0])
	for _, p := range paths[1:] {
		for !strings.HasPrefix(filepath.Dir(p)+"/", dir+"/") && dir != "/" {
			dir = filepath.Dir(dir)
		}
	}
	return dir
}

// ---------------------------------------------------------------- utils

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": msg})
}

func readJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	return json.NewDecoder(io.LimitReader(r.Body, 16<<20)).Decode(v)
}

func randID(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func sanitizeName(s string) string {
	s = strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '?', '*', '|', '"', '<', '>', 0:
			return '-'
		}
		if r < 32 {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(s), "."))
	if rs := []rune(s); len(rs) > 120 {
		s = string(rs[:120])
	}
	return s
}

func uniquePath(dir, base, ext string) string {
	p := filepath.Join(dir, base+ext)
	for n := 2; ; n++ {
		if _, err := os.Lstat(p); errors.Is(err, os.ErrNotExist) {
			return p
		}
		p = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, n, ext))
	}
}

func writeFileAtomic(path string, b []byte, perm os.FileMode) {
	tmp := path + ".tmp"
	if os.WriteFile(tmp, b, perm) == nil {
		os.Rename(tmp, path)
	}
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func init() {
	mime.AddExtensionType(".js", "text/javascript")
	mime.AddExtensionType(".mjs", "text/javascript")
	mime.AddExtensionType(".flac", "audio/flac")
	mime.AddExtensionType(".m4a", "audio/mp4")
}
