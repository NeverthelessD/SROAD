package main

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// envVersion goes up whenever the Python packages below change; the app then reinstalls them.
const envVersion = 1

const (
	uvVersion     = "0.8.22"
	pythonVersion = "3.11"
	modelBaseURL  = "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/"
)

var torchPkgs = []string{"torch==2.5.1", "torchaudio==2.5.1"}
var basePkgs = []string{"numpy>=1.26,<2.3", "soundfile>=0.12", "pedalboard>=0.9.16,<0.10", "julius>=0.2.7",
	"einops", "pyyaml", "tqdm", "dora-search==0.1.13"}
var noDepPkgs = []string{"demucs==4.0.1", "openunmix==1.3.0"}

var modelFiles = map[string][]string{
	"htdemucs":    {"955717e8-8726e21a.th"},
	"htdemucs_ft": {"f7e0c4bc-ba3fe64a.th", "d12395a8-e57c48e6.th", "92cfc3b6-ef3bcb9c.th", "04573f0d-f3cf25b2.th"},
	"htdemucs_6s": {"5c90dfd2-34c22ccb.th"},
}

type SetupStep struct {
	Key    string  `json:"key"`
	Label  string  `json:"label"`
	Emoji  string  `json:"emoji"`
	Hint   string  `json:"hint"`
	State  string  `json:"state"` // wait | run | done | error
	Done   int64   `json:"done"`
	Total  int64   `json:"total"`
	Detail string  `json:"detail"`
	Weight float64 `json:"weight"`
	Start  int64   `json:"start,omitempty"`
}

type Setup struct {
	mu      sync.Mutex
	support string
	bin     string
	running bool
	err     string
	steps   []*SetupStep
	info    map[string]any
	ready   bool
	modelMu sync.Mutex
}

type setupStamp struct {
	EnvVersion int            `json:"envVersion"`
	OK         bool           `json:"ok"`
	Info       map[string]any `json:"info"`
	Date       string         `json:"date"`
}

func NewSetup(support, bin string) *Setup {
	s := &Setup{support: support, bin: bin}
	s.ready = s.checkReady()
	return s
}

func (s *Setup) stampPath() string { return filepath.Join(s.support, "setup.json") }
func (s *Setup) envDir() string    { return filepath.Join(s.support, "env") }
func (s *Setup) modelDir() string  { return filepath.Join(s.support, "models", "hub", "checkpoints") }

func (s *Setup) Python() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(s.envDir(), "Scripts", "python.exe")
	}
	return filepath.Join(s.envDir(), "bin", "python")
}

func (s *Setup) uvPath() string {
	if p := os.Getenv("SROAD_UV"); p != "" {
		return p
	}
	if runtime.GOOS == "windows" {
		return filepath.Join(s.bin, "uv.exe")
	}
	return filepath.Join(s.bin, "uv")
}

func (s *Setup) WorkerEnv() []string {
	env := os.Environ()
	env = append(env,
		"TORCH_HOME="+filepath.Join(s.support, "models"),
		"PYTORCH_ENABLE_MPS_FALLBACK=1",
		"PYTHONUNBUFFERED=1",
		"PYTHONIOENCODING=utf-8",
		"KMP_DUPLICATE_LIB_OK=TRUE",
	)
	return env
}

func (s *Setup) readStamp() setupStamp {
	var st setupStamp
	if b, err := os.ReadFile(s.stampPath()); err == nil {
		json.Unmarshal(b, &st)
	}
	return st
}

func (s *Setup) ToolsReady() bool {
	return fileExists(tool("ffmpeg")) && fileExists(tool("ffprobe"))
}

func (s *Setup) modelReady(name string) bool {
	for _, f := range modelFiles[name] {
		if !fileExists(filepath.Join(s.modelDir(), f)) {
			return false
		}
	}
	return true
}

func (s *Setup) checkReady() bool {
	st := s.readStamp()
	return st.OK && st.EnvVersion >= envVersion && s.ToolsReady() && fileExists(s.Python()) && s.modelReady("htdemucs")
}

func (s *Setup) Ready() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ready
}

func (s *Setup) Running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

func (s *Setup) State() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.readStamp()
	steps := make([]SetupStep, 0, len(s.steps))
	for _, x := range s.steps {
		steps = append(steps, *x)
	}
	info := s.info
	if info == nil {
		info = st.Info
	}
	return map[string]any{
		"ready":       s.ready,
		"running":     s.running,
		"error":       s.err,
		"steps":       steps,
		"info":        info,
		"needUpgrade": st.OK && st.EnvVersion < envVersion,
		"installed":   st.OK,
		"models": map[string]bool{
			"htdemucs": s.modelReady("htdemucs"), "htdemucs_ft": s.modelReady("htdemucs_ft"), "htdemucs_6s": s.modelReady("htdemucs_6s"),
		},
	}
}

func (s *Setup) Start(force bool) {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	s.running = true
	s.err = ""
	s.steps = []*SetupStep{
		{Key: "ffmpeg", Label: "오디오 변환 도구", Emoji: "🎛️", Hint: "MP3·M4A·FLAC·WAV 읽기와 저장", Weight: 0.12},
		{Key: "uv", Label: "설치 도우미", Emoji: "🧰", Hint: "AI 엔진을 앱 전용 폴더에 설치", Weight: 0.04},
		{Key: "python", Label: "AI 실행 환경", Emoji: "🐍", Hint: "Python 3.11 (이 앱 전용)", Weight: 0.08},
		{Key: "packages", Label: "AI 엔진", Emoji: "🧠", Hint: "PyTorch · Demucs · Rubber Band", Weight: 0.46},
		{Key: "model", Label: "음원 분리 AI 모델", Emoji: "🎧", Hint: "Hybrid Transformer Demucs", Weight: 0.25},
		{Key: "check", Label: "마무리 점검", Emoji: "✅", Hint: "모든 구성요소가 잘 동작하는지 확인", Weight: 0.05},
	}
	for _, st := range s.steps {
		st.State = "wait"
	}
	s.mu.Unlock()
	go s.run(force)
}

func (s *Setup) step(key string) *SetupStep {
	for _, st := range s.steps {
		if st.Key == key {
			return st
		}
	}
	return nil
}

func (s *Setup) update(key string, fn func(*SetupStep)) {
	s.mu.Lock()
	if st := s.step(key); st != nil {
		fn(st)
	}
	s.mu.Unlock()
}

func (s *Setup) run(force bool) {
	ctx := context.Background()
	err := s.runSteps(ctx, force)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.running = false
	if err != nil {
		s.err = err.Error()
		for _, st := range s.steps {
			if st.State == "run" {
				st.State = "error"
			}
		}
		log.Printf("setup failed: %v", err)
		return
	}
	s.ready = true
}

func (s *Setup) runSteps(ctx context.Context, force bool) error {
	if free := freeSpace(s.support); free > 0 && free < 2500<<20 {
		return fmt.Errorf("저장 공간이 부족해요. 최소 2.5GB의 여유 공간이 필요해요 (현재 %.1fGB)", float64(free)/(1<<30))
	}
	old := s.readStamp()
	do := func(key string, skip bool, fn func(st *SetupStep) error) error {
		if skip {
			s.update(key, func(st *SetupStep) { st.State = "done"; st.Detail = "이미 설치되어 있어요" })
			return nil
		}
		s.update(key, func(st *SetupStep) { st.State = "run"; st.Start = time.Now().UnixMilli() })
		var cur *SetupStep
		s.mu.Lock()
		cur = s.step(key)
		s.mu.Unlock()
		if err := fn(cur); err != nil {
			return err
		}
		s.update(key, func(st *SetupStep) { st.State = "done"; st.Detail = "" })
		return nil
	}

	if err := do("ffmpeg", s.ToolsReady(), func(st *SetupStep) error { return s.installFFmpeg(ctx) }); err != nil {
		return err
	}
	if err := do("uv", fileExists(s.uvPath()), func(st *SetupStep) error { return s.installUV(ctx) }); err != nil {
		return err
	}
	pyOK := fileExists(s.Python()) && !force
	if err := do("python", pyOK, func(st *SetupStep) error {
		os.RemoveAll(s.envDir())
		if err := s.uv(ctx, "python", "install", pythonVersion); err != nil {
			return fmt.Errorf("Python을 설치하지 못했어요: %v", err)
		}
		if err := s.uv(ctx, "venv", "--python", pythonVersion, s.envDir()); err != nil {
			return fmt.Errorf("실행 환경을 만들지 못했어요: %v", err)
		}
		return nil
	}); err != nil {
		return err
	}
	pkgOK := old.OK && old.EnvVersion >= envVersion && pyOK
	if err := do("packages", pkgOK, func(st *SetupStep) error {
		py := s.Python()
		args := []string{"pip", "install", "--python", py}
		if idx := os.Getenv("SROAD_TORCH_INDEX"); idx != "" {
			args = append(args, "--index-url", idx)
		}
		if err := s.uv(ctx, append(args, torchPkgs...)...); err != nil {
			return fmt.Errorf("PyTorch를 설치하지 못했어요: %v", err)
		}
		s.update("packages", func(st *SetupStep) { st.Done, st.Total = 1, 3 })
		if err := s.uv(ctx, append([]string{"pip", "install", "--python", py}, basePkgs...)...); err != nil {
			return fmt.Errorf("AI 구성요소를 설치하지 못했어요: %v", err)
		}
		s.update("packages", func(st *SetupStep) { st.Done, st.Total = 2, 3 })
		if err := s.uv(ctx, append([]string{"pip", "install", "--python", py, "--no-deps"}, noDepPkgs...)...); err != nil {
			return fmt.Errorf("Demucs를 설치하지 못했어요: %v", err)
		}
		s.update("packages", func(st *SetupStep) { st.Done, st.Total = 3, 3 })
		s.uv(ctx, "cache", "clean")
		return nil
	}); err != nil {
		return err
	}
	if err := do("model", s.modelReady("htdemucs"), func(st *SetupStep) error {
		return s.EnsureModel(ctx, "htdemucs", func(p float64) {
			s.update("model", func(st *SetupStep) { st.Done, st.Total = int64(p*1000), 1000 })
		})
	}); err != nil {
		return err
	}
	return do("check", false, func(st *SetupStep) error {
		info, err := s.check(ctx)
		if err != nil {
			return err
		}
		stamp := setupStamp{EnvVersion: envVersion, OK: true, Info: info, Date: time.Now().Format(time.RFC3339)}
		b, _ := json.MarshalIndent(stamp, "", "  ")
		writeFileAtomic(s.stampPath(), b, 0o644)
		s.mu.Lock()
		s.info = info
		s.mu.Unlock()
		return nil
	})
}

func (s *Setup) check(ctx context.Context) (map[string]any, error) {
	dir, _ := os.MkdirTemp(app.workDir, "check-")
	defer os.RemoveAll(dir)
	jf := filepath.Join(dir, "task.json")
	os.WriteFile(jf, []byte(`{"task":"check"}`), 0o644)
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.Python(), filepath.Join(s.support, "worker.py"), jf)
	cmd.Env = s.WorkerEnv()
	out, err := cmd.Output()
	var info map[string]any
	for _, line := range strings.Split(string(out), "\n") {
		var m map[string]any
		if json.Unmarshal([]byte(line), &m) == nil {
			if m["type"] == "result" {
				info, _ = m["info"].(map[string]any)
			}
			if m["type"] == "error" {
				return nil, fmt.Errorf("AI 엔진 점검 실패: %v", m["message"])
			}
		}
	}
	if err != nil || info == nil {
		var ee *exec.ExitError
		msg := ""
		if errors.As(err, &ee) {
			msg = lastLine(string(ee.Stderr))
		}
		return nil, fmt.Errorf("AI 엔진 점검 실패: %s", msg)
	}
	return info, nil
}

// uv runs the bundled uv with everything kept inside the app's support folder.
func (s *Setup) uv(ctx context.Context, args ...string) error {
	cmd := exec.CommandContext(ctx, s.uvPath(), args...)
	cmd.Env = append(os.Environ(),
		"UV_CACHE_DIR="+filepath.Join(s.support, "cache", "uv"),
		"UV_PYTHON_INSTALL_DIR="+filepath.Join(s.support, "python"),
		"UV_PYTHON_PREFERENCE=only-managed",
		"UV_NO_PROGRESS=1",
		"UV_LINK_MODE=copy",
		"UV_HTTP_TIMEOUT=120",
		"NO_COLOR=1",
	)
	stderr, _ := cmd.StderrPipe()
	cmd.Stdout = io.Discard
	if err := cmd.Start(); err != nil {
		return err
	}
	var last string
	sc := bufio.NewScanner(stderr)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		last = line
		log.Printf("uv: %s", line)
		key := ""
		s.mu.Lock()
		for _, st := range s.steps {
			if st.State == "run" {
				key = st.Key
			}
		}
		s.mu.Unlock()
		if key != "" {
			d := koDetail(line)
			s.update(key, func(st *SetupStep) { st.Detail = d })
		}
	}
	if err := cmd.Wait(); err != nil {
		if strings.Contains(strings.ToLower(last), "network") || strings.Contains(strings.ToLower(last), "connect") || strings.Contains(strings.ToLower(last), "dns") {
			return errors.New("인터넷 연결을 확인해 주세요")
		}
		return fmt.Errorf("%s", last)
	}
	return nil
}

// ---------------------------------------------------------------- downloads

func (s *Setup) download(ctx context.Context, url, dest string, onProgress func(done, total int64)) error {
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("User-Agent", "SROAD/"+build)
	client := &http.Client{Timeout: 30 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return errCanceled
		}
		return errors.New("인터넷 연결을 확인해 주세요")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("다운로드 실패 (HTTP %d)", resp.StatusCode)
	}
	part := dest + ".part"
	f, err := os.Create(part)
	if err != nil {
		return err
	}
	total := resp.ContentLength
	var done int64
	buf := make([]byte, 256<<10)
	last := time.Now()
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				f.Close()
				os.Remove(part)
				return werr
			}
			done += int64(n)
			if onProgress != nil && time.Since(last) > 150*time.Millisecond {
				onProgress(done, total)
				last = time.Now()
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			os.Remove(part)
			if ctx.Err() != nil {
				return errCanceled
			}
			return errors.New("다운로드가 중간에 끊겼어요. 인터넷 연결을 확인해 주세요")
		}
	}
	f.Close()
	if total > 0 && done != total {
		os.Remove(part)
		return errors.New("다운로드가 중간에 끊겼어요")
	}
	if onProgress != nil {
		onProgress(done, total)
	}
	return os.Rename(part, dest)
}

func (s *Setup) installFFmpeg(ctx context.Context) error {
	if os.Getenv("SROAD_FFMPEG_DIR") != "" {
		return errors.New("SROAD_FFMPEG_DIR 경로에 ffmpeg가 없어요")
	}
	if runtime.GOOS != "darwin" {
		return errors.New("이 운영체제용 ffmpeg 설치는 아직 지원하지 않아요")
	}
	arch := "arm64"
	if runtime.GOARCH == "amd64" {
		arch = "amd64"
	}
	tools := []string{"ffmpeg", "ffprobe"}
	for i, t := range tools {
		urls := []string{
			fmt.Sprintf("https://ffmpeg.martin-riedl.de/redirect/latest/macos/%s/release/%s.zip", arch, t),
			fmt.Sprintf("https://ffmpeg.martin-riedl.de/redirect/latest/macos/%s/snapshot/%s.zip", arch, t),
		}
		zipPath := filepath.Join(s.support, t+".zip")
		var err error
		for _, u := range urls {
			err = s.download(ctx, u, zipPath, func(done, total int64) {
				s.update("ffmpeg", func(st *SetupStep) {
					st.Done, st.Total = int64(i)*1000+fracOf(done, total, 1000), int64(len(tools))*1000
					st.Detail = fmt.Sprintf("%s %s", t, mb(done, total))
				})
			})
			if err == nil {
				break
			}
		}
		if err != nil {
			return err
		}
		if err := extractZipFile(zipPath, t, filepath.Join(s.bin, t)); err != nil {
			os.Remove(zipPath)
			return err
		}
		os.Remove(zipPath)
	}
	return nil
}

func (s *Setup) installUV(ctx context.Context) error {
	triple := map[string]string{
		"darwin/arm64":  "aarch64-apple-darwin",
		"darwin/amd64":  "x86_64-apple-darwin",
		"linux/amd64":   "x86_64-unknown-linux-gnu",
		"linux/arm64":   "aarch64-unknown-linux-gnu",
		"windows/amd64": "x86_64-pc-windows-msvc",
	}[runtime.GOOS+"/"+runtime.GOARCH]
	if triple == "" {
		return errors.New("이 컴퓨터용 설치 도우미가 없어요")
	}
	url := fmt.Sprintf("https://github.com/astral-sh/uv/releases/download/%s/uv-%s.tar.gz", uvVersion, triple)
	tgz := filepath.Join(s.support, "uv.tar.gz")
	if err := s.download(ctx, url, tgz, func(done, total int64) {
		s.update("uv", func(st *SetupStep) { st.Done, st.Total = done, total; st.Detail = mb(done, total) })
	}); err != nil {
		return err
	}
	defer os.Remove(tgz)
	return extractTarGzFile(tgz, "uv", s.uvPath())
}

// EnsureModel downloads the Demucs weights for a model (checked against their SHA-256 prefix).
func (s *Setup) EnsureModel(ctx context.Context, name string, onProgress func(p float64)) error {
	s.modelMu.Lock()
	defer s.modelMu.Unlock()
	files := modelFiles[name]
	if len(files) == 0 {
		return fmt.Errorf("알 수 없는 모델: %s", name)
	}
	os.MkdirAll(s.modelDir(), 0o755)
	for i, f := range files {
		dest := filepath.Join(s.modelDir(), f)
		if fileExists(dest) {
			continue
		}
		err := s.download(ctx, modelBaseURL+f, dest, func(done, total int64) {
			if onProgress != nil {
				onProgress((float64(i) + float64(fracOf(done, total, 1000))/1000) / float64(len(files)))
			}
		})
		if err != nil {
			return fmt.Errorf("AI 모델을 받지 못했어요: %v", err)
		}
		want := strings.TrimSuffix(f[strings.Index(f, "-")+1:], ".th")
		if got := sha256File(dest); !strings.HasPrefix(got, want) {
			os.Remove(dest)
			return errors.New("AI 모델 파일이 손상됐어요. 다시 시도해 주세요")
		}
	}
	if onProgress != nil {
		onProgress(1)
	}
	return nil
}

func sha256File(p string) string {
	f, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil))
}

func fracOf(done, total, scale int64) int64 {
	if total <= 0 {
		return 0
	}
	return done * scale / total
}

func mb(done, total int64) string {
	if total > 0 {
		return fmt.Sprintf("%.1f / %.1f MB", float64(done)/1e6, float64(total)/1e6)
	}
	return fmt.Sprintf("%.1f MB", float64(done)/1e6)
}

func extractZipFile(zipPath, name, dest string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return errors.New("받은 파일이 손상됐어요. 다시 시도해 주세요")
	}
	defer zr.Close()
	for _, f := range zr.File {
		if filepath.Base(f.Name) == name && !f.FileInfo().IsDir() {
			rc, err := f.Open()
			if err != nil {
				return err
			}
			defer rc.Close()
			return writeExecutable(rc, dest)
		}
	}
	return fmt.Errorf("받은 파일 안에 %s가 없어요", name)
}

func extractTarGzFile(tgz, name, dest string) error {
	f, err := os.Open(tgz)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return errors.New("받은 파일이 손상됐어요")
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		base := filepath.Base(h.Name)
		if (base == name || base == name+".exe") && h.Typeflag == tar.TypeReg {
			return writeExecutable(tr, dest)
		}
	}
	return fmt.Errorf("받은 파일 안에 %s가 없어요", name)
}

func writeExecutable(r io.Reader, dest string) error {
	os.MkdirAll(filepath.Dir(dest), 0o755)
	part := dest + ".part"
	out, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, r); err != nil {
		out.Close()
		os.Remove(part)
		return err
	}
	out.Close()
	return os.Rename(part, dest)
}

// koDetail turns uv's progress lines into short Korean text.
func koDetail(line string) string {
	f := strings.Fields(line)
	switch {
	case len(f) >= 2 && f[0] == "Downloading":
		return f[1] + " 내려받는 중"
	case len(f) >= 3 && (f[0] == "Resolved" || f[0] == "Prepared" || f[0] == "Installed" || f[0] == "Audited"):
		verb := map[string]string{"Resolved": "확인", "Prepared": "준비", "Installed": "설치", "Audited": "확인"}[f[0]]
		return "구성요소 " + f[1] + "개 " + verb + " 완료"
	case strings.HasPrefix(line, "+ "):
		return strings.TrimPrefix(line, "+ ") + " 설치됨"
	case strings.HasPrefix(line, "Installed Python"):
		return "Python 설치 완료"
	case strings.HasPrefix(line, "Using CPython"), strings.HasPrefix(line, "Creating virtual environment"):
		return "실행 환경 만드는 중"
	}
	if len(line) > 60 {
		line = line[:60]
	}
	return line
}
