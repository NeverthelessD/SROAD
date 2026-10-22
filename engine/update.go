package main

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 업데이트는 GitHub 저장소(NeverthelessD/SROAD)의 releases/latest.json 을 확인합니다.
const defaultUpdateURL = "https://raw.githubusercontent.com/NeverthelessD/SROAD/main/releases/latest.json"

type Release struct {
	Version string   `json:"version"`
	Date    string   `json:"date"`
	Zip     string   `json:"zip"`
	Sha256  string   `json:"sha256"`
	Size    int64    `json:"size"`
	Notes   []string `json:"notes"`
}

type Updater struct {
	mu        sync.Mutex
	support   string
	status    string // idle | checking | uptodate | available | downloading | installing | ready | error
	latest    *Release
	err       string
	progress  float64
	lastCheck int64
	installed string // version installed and waiting for a restart
}

func NewUpdater(support string) *Updater {
	return &Updater{support: support, status: "idle"}
}

func updateURL() string {
	if u := os.Getenv("SROAD_UPDATE_URL"); u != "" {
		return u
	}
	return defaultUpdateURL
}

func (u *Updater) backupApp() string { return filepath.Join(u.support, "backup", "SROAD.app") }

func (u *Updater) backupVersion() string {
	b, err := os.ReadFile(filepath.Join(u.backupApp(), "Contents", "Resources", "version.txt"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func (u *Updater) State() map[string]any {
	u.mu.Lock()
	defer u.mu.Unlock()
	bv := u.backupVersion()
	return map[string]any{
		"current":       build,
		"status":        u.status,
		"latest":        u.latest,
		"error":         u.err,
		"progress":      u.progress,
		"lastCheck":     u.lastCheck,
		"installed":     u.installed,
		"backupVersion": bv,
		"canRollback":   bv != "" && bv != build,
		"autoUpdate":    app.Settings().AutoUpdate,
		"repo":          "https://github.com/NeverthelessD/SROAD",
	}
}

func (u *Updater) Busy() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.status == "downloading" || u.status == "installing"
}

func (u *Updater) set(fn func()) {
	u.mu.Lock()
	fn()
	u.mu.Unlock()
}

// compareVersions returns -1, 0, 1 for a < b, a == b, a > b ("1.2.10" > "1.2.9").
func compareVersions(a, b string) int {
	pa := strings.Split(strings.TrimPrefix(a, "v"), ".")
	pb := strings.Split(strings.TrimPrefix(b, "v"), ".")
	for i := 0; i < max(len(pa), len(pb)); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(strings.SplitN(pa[i], "-", 2)[0])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(strings.SplitN(pb[i], "-", 2)[0])
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

func (u *Updater) Check(force bool) {
	u.mu.Lock()
	if u.status == "downloading" || u.status == "installing" || u.status == "checking" {
		u.mu.Unlock()
		return
	}
	prev := u.status
	u.status, u.err = "checking", ""
	u.mu.Unlock()

	rel, err := fetchLatest()
	u.mu.Lock()
	defer u.mu.Unlock()
	u.lastCheck = time.Now().UnixMilli()
	if err != nil {
		u.err = err.Error()
		u.status = "error"
		if prev == "ready" {
			u.status = "ready"
		}
		return
	}
	u.latest = rel
	switch {
	case u.installed != "" && compareVersions(rel.Version, u.installed) <= 0:
		u.status = "ready"
	case compareVersions(rel.Version, build) > 0:
		u.status = "available"
	default:
		u.status = "uptodate"
	}
}

func fetchLatest() (*Release, error) {
	url := updateURL()
	sep := "?"
	if strings.Contains(url, "?") {
		sep = "&"
	}
	req, _ := http.NewRequest("GET", fmt.Sprintf("%s%sts=%d", url, sep, time.Now().Unix()), nil)
	req.Header.Set("Cache-Control", "no-cache")
	req.Header.Set("User-Agent", "SROAD/"+build)
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return nil, errors.New("업데이트 서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요")
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil, errors.New("아직 등록된 업데이트 정보가 없어요")
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("업데이트 정보를 받지 못했어요 (HTTP %d)", resp.StatusCode)
	}
	var rel Release
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&rel); err != nil || rel.Version == "" {
		return nil, errors.New("업데이트 정보를 읽지 못했어요")
	}
	return &rel, nil
}

func assetURL(rel string) string {
	if strings.HasPrefix(rel, "http://") || strings.HasPrefix(rel, "https://") {
		return rel
	}
	base := updateURL()
	if i := strings.Index(base, "?"); i >= 0 {
		base = base[:i]
	}
	return base[:strings.LastIndex(base, "/")+1] + rel
}

// autoLoop checks shortly after start and then every 6 hours; installs automatically when allowed.
func (u *Updater) autoLoop() {
	time.Sleep(12 * time.Second)
	for {
		if app.Settings().AutoUpdate {
			u.Check(false)
			u.mu.Lock()
			avail := u.status == "available"
			u.mu.Unlock()
			if avail {
				// AI 작업이 끝날 때까지 기다렸다가 설치합니다
				for app.jobs.AIBusy() {
					time.Sleep(30 * time.Second)
				}
				u.Install()
			}
		}
		time.Sleep(6 * time.Hour)
	}
}

func appBundle() (string, error) {
	p := os.Getenv("SROAD_APP")
	if p == "" {
		return "", errors.New("앱 위치를 알 수 없어요. 앱을 다시 실행해 주세요")
	}
	if strings.Contains(p, "/AppTranslocation/") {
		return "", errors.New("다운로드 폴더에서 바로 실행 중이라 업데이트할 수 없어요. SROAD를 응용 프로그램 폴더로 옮긴 뒤 다시 실행해 주세요")
	}
	return p, nil
}

func (u *Updater) Install() {
	u.mu.Lock()
	if u.status == "downloading" || u.status == "installing" {
		u.mu.Unlock()
		return
	}
	rel := u.latest
	u.mu.Unlock()
	if rel == nil {
		u.Check(true)
		u.mu.Lock()
		rel = u.latest
		u.mu.Unlock()
		if rel == nil {
			return
		}
	}
	if compareVersions(rel.Version, build) <= 0 {
		u.set(func() { u.status = "uptodate" })
		return
	}
	err := u.install(rel)
	u.mu.Lock()
	defer u.mu.Unlock()
	if err != nil {
		log.Printf("update failed: %v", err)
		u.status, u.err = "error", err.Error()
		return
	}
	u.status, u.installed, u.progress = "ready", rel.Version, 1
}

func (u *Updater) install(rel *Release) error {
	appPath, err := appBundle()
	if err != nil {
		return err
	}
	u.set(func() { u.status, u.err, u.progress = "downloading", "", 0 })
	dir := filepath.Join(u.support, "update")
	os.RemoveAll(dir)
	os.MkdirAll(dir, 0o755)
	zipPath := filepath.Join(dir, "SROAD-"+rel.Version+".zip")
	err = app.setup.download(context.Background(), assetURL(rel.Zip), zipPath, func(done, total int64) {
		if total <= 0 {
			total = rel.Size
		}
		u.set(func() {
			if total > 0 {
				u.progress = float64(done) / float64(total)
			}
		})
	})
	if err != nil {
		return err
	}
	u.set(func() { u.status = "installing" })
	if rel.Sha256 != "" && !strings.EqualFold(sha256File(zipPath), rel.Sha256) {
		return errors.New("받은 업데이트 파일이 손상됐어요. 잠시 뒤 다시 시도해 주세요")
	}
	stage := filepath.Join(dir, "stage")
	if err := unzipAll(zipPath, stage); err != nil {
		return fmt.Errorf("업데이트 파일을 풀지 못했어요: %v", err)
	}
	newApp := filepath.Join(stage, "SROAD.app")
	if !fileExists(filepath.Join(newApp, "Contents", "MacOS", "SROAD")) {
		return errors.New("업데이트 파일 안에 앱이 없어요")
	}
	if v, _ := os.ReadFile(filepath.Join(newApp, "Contents", "Resources", "version.txt")); strings.TrimSpace(string(v)) != rel.Version {
		return errors.New("업데이트 파일의 버전 정보가 맞지 않아요")
	}
	if err := u.swap(appPath, newApp); err != nil {
		return err
	}
	os.RemoveAll(dir)
	return nil
}

// swap moves the running app to the backup folder and puts newApp in its place.
func (u *Updater) swap(appPath, newApp string) error {
	backup := u.backupApp()
	os.MkdirAll(filepath.Dir(backup), 0o755)
	os.RemoveAll(backup)
	if err := moveDir(appPath, backup); err != nil {
		if os.IsPermission(err) || errors.Is(err, os.ErrPermission) {
			return adminSwap(appPath, newApp, backup)
		}
		return fmt.Errorf("현재 앱을 옮기지 못했어요: %v", err)
	}
	if err := moveDir(newApp, appPath); err != nil {
		moveDir(backup, appPath) // 되돌리기
		return fmt.Errorf("새 버전을 설치하지 못했어요: %v", err)
	}
	if runtime.GOOS == "darwin" {
		exec.Command("/usr/bin/xattr", "-cr", appPath).Run()
		exec.Command("/usr/bin/touch", appPath).Run()
	}
	return nil
}

func moveDir(from, to string) error {
	if err := os.Rename(from, to); err == nil {
		return nil
	} else if os.IsPermission(err) {
		return err
	}
	// 다른 디스크라면 복사 후 삭제
	if runtime.GOOS == "darwin" {
		if out, err := exec.Command("/usr/bin/ditto", from, to).CombinedOutput(); err != nil {
			return fmt.Errorf("%s", lastLine(string(out)))
		}
	} else if out, err := exec.Command("cp", "-a", from, to).CombinedOutput(); err != nil {
		return fmt.Errorf("%s", lastLine(string(out)))
	}
	return os.RemoveAll(from)
}

func shq(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// adminSwap asks for the Mac password when the app folder is not writable.
func adminSwap(appPath, newApp, backup string) error {
	if runtime.GOOS != "darwin" {
		return errors.New("앱 폴더에 쓸 권한이 없어요")
	}
	cmd := fmt.Sprintf("/bin/rm -rf %s && /bin/mv %s %s && /usr/bin/ditto %s %s && /usr/bin/xattr -cr %s",
		shq(backup), shq(appPath), shq(backup), shq(newApp), shq(appPath), shq(appPath))
	script := fmt.Sprintf(`do shell script "%s" with prompt "SROAD를 업데이트하려면 암호가 필요해요." with administrator privileges`,
		strings.ReplaceAll(strings.ReplaceAll(cmd, `\`, `\\`), `"`, `\"`))
	if out, err := exec.Command("/usr/bin/osascript", "-e", script).CombinedOutput(); err != nil {
		if strings.Contains(string(out), "-128") {
			return errors.New("업데이트를 취소했어요")
		}
		return fmt.Errorf("앱 폴더에 쓸 권한이 없어요: %s", lastLine(string(out)))
	}
	return nil
}

func (u *Updater) Rollback() error {
	appPath, err := appBundle()
	if err != nil {
		return err
	}
	bv := u.backupVersion()
	if bv == "" {
		return errors.New("되돌릴 이전 버전이 없어요")
	}
	tmp := filepath.Join(u.support, "update", "current.app")
	os.RemoveAll(tmp)
	os.MkdirAll(filepath.Dir(tmp), 0o755)
	if err := moveDir(appPath, tmp); err != nil {
		return fmt.Errorf("현재 앱을 옮기지 못했어요: %v", err)
	}
	if err := moveDir(u.backupApp(), appPath); err != nil {
		moveDir(tmp, appPath)
		return fmt.Errorf("이전 버전을 되돌리지 못했어요: %v", err)
	}
	moveDir(tmp, u.backupApp())
	// 되돌린 뒤 곧바로 다시 업데이트되지 않도록 자동 업데이트를 끕니다
	app.mu.Lock()
	app.settings.AutoUpdate = false
	app.saveSettings()
	app.mu.Unlock()
	u.set(func() { u.status, u.installed, u.err = "ready", bv, "" })
	return nil
}

// Restart starts the (possibly new) app on the same port and token, then exits.
func (u *Updater) Restart(port int, token string) error {
	appPath, err := appBundle()
	if err != nil {
		return err
	}
	// Dock 앱 방식: 엔진이 '다시 열어 주세요' 표시를 남기고 끝나면, 앱이 새 버전을 macOS 정식 방법으로 다시 열어요.
	// (작업 목록은 저장해 두고, 다시 열린 앱이 이어서 불러와요)
	if nativeShell() {
		app.lib.Save()
		writeFileAtomic(filepath.Join(u.support, "restart-requested"), []byte(time.Now().Format(time.RFC3339)), 0o644)
		go func() {
			time.Sleep(300 * time.Millisecond)
			app.shutdown(true)
		}()
		return nil
	}
	launcher := filepath.Join(appPath, "Contents", "MacOS", "SROAD")
	if !fileExists(launcher) {
		return errors.New("앱을 찾을 수 없어요")
	}
	app.lib.Save()
	cmd := exec.Command("/bin/bash", "-c", `sleep 1; exec "$0"`, launcher)
	cmd.Env = append(os.Environ(), "SROAD_RESTART=1", "SROAD_PORT="+strconv.Itoa(port), "SROAD_TOKEN="+token)
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("다시 시작하지 못했어요: %v", err)
	}
	go func() {
		time.Sleep(300 * time.Millisecond)
		app.shutdown(true)
	}()
	return nil
}

func unzipAll(zipPath, dest string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer zr.Close()
	os.RemoveAll(dest)
	for _, f := range zr.File {
		name := path.Clean(f.Name)
		if strings.HasPrefix(name, "..") || strings.HasPrefix(name, "/") || strings.HasPrefix(name, "__MACOSX") {
			continue
		}
		target := filepath.Join(dest, filepath.FromSlash(name))
		if f.FileInfo().IsDir() {
			os.MkdirAll(target, 0o755)
			continue
		}
		os.MkdirAll(filepath.Dir(target), 0o755)
		mode := f.Mode().Perm()
		if mode == 0 {
			mode = 0o644
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(out, rc)
		rc.Close()
		out.Close()
		if err != nil {
			return err
		}
		os.Chmod(target, mode)
	}
	return nil
}
