package main

// 엔진 지킴이 (supervisor)
//
// 실행기는 엔진을 SROAD_SUPERVISOR=1 로 켜요. 그러면 이 프로그램은 먼저 '지킴이'가 되어
//   1) 실행기와 완전히 떨어진 새 세션으로 옮겨 가고 (실행기가 끝나도 함께 꺼지지 않게)
//   2) 진짜 엔진을 자식으로 켠 뒤
//   3) 엔진이 비정상으로 꺼지면 기록을 남기고 같은 주소(포트·토큰)로 곧바로 다시 켜요.
// 엔진이 스스로 정상 종료(종료 버튼 · 오래 쉼 · 업데이트 후 다시 시작)하면 지킴이도 함께 끝나요.

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	maxRestarts   = 5
	restartWindow = 5 * time.Minute
)

// graceWindow: 켜진 직후 이 시간 안에 오는 종료 신호는 앱 창이 열리며 생긴 것으로 봐요 (테스트용 SROAD_GRACE_SEC)
var graceWindow = func() time.Duration {
	if n, err := strconv.Atoi(env("GRACE_SEC")); err == nil && n >= 0 {
		return time.Duration(n) * time.Second
	}
	return 20 * time.Second
}()

func supLog(support, format string, a ...any) {
	p := filepath.Join(support, "launcher.log")
	if st, err := os.Stat(p); err == nil && st.Size() > 256<<10 {
		os.Rename(p, filepath.Join(support, "launcher.prev.log"))
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s [지킴이 %d] %s\n", time.Now().Format("01-02 15:04:05"), os.Getpid(), fmt.Sprintf(format, a...))
}

func tailFile(p string, n int) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

func runSupervisor(support string) {
	detachSelf()
	self, err := os.Executable()
	if err != nil {
		supLog(support, "엔진 위치를 찾지 못했어요: %v", err)
		os.Exit(1)
	}
	supLog(support, "시작 · 엔진 %s · %s/%s · %s", build, runtime.GOOS, runtime.GOARCH, map[string]string{"helper": "백그라운드 도우미 앱", "nohup": "예전 방식"}[env("VIA")])

	// macOS 27 에서는 SROAD.app(실행기)이 창을 열고 끝나는 순간, 시스템이 그 앱이 켠 프로그램들에게
	// '종료' 신호(SIGTERM)를 보내요. 켜진 직후(graceWindow 안)에 오는 종료 신호는 그 때문이라서 무시하고 엔진을 계속 켜 둬요.
	// 그 뒤에 오는 신호(로그아웃 · 시스템 종료 · 강제 종료)는 진짜 '그만'이라서 엔진도 끄고, 다시 켜지 않아요.
	supStart := time.Now()
	var (
		mu       sync.Mutex
		child    *os.Process
		stopping bool
	)
	sig := make(chan os.Signal, 4)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	go func() {
		for s := range sig {
			if time.Since(supStart) < graceWindow {
				supLog(support, "켜진 직후 받은 종료 신호(%v)는 앱 창이 열리며 생긴 것이라 무시하고 엔진을 계속 켜 둬요", s)
				continue
			}
			mu.Lock()
			stopping = true
			c := child
			mu.Unlock()
			supLog(support, "신호 %v 를 받아 엔진을 끄고 지킴이도 끝냅니다", s)
			if c != nil {
				c.Signal(syscall.SIGTERM)
			} else {
				os.Exit(0)
			}
			return
		}
	}()

	baseEnv := []string{}
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "SROAD_SUPERVISOR=") || strings.HasPrefix(kv, "SROAD_PORT=") || strings.HasPrefix(kv, "SROAD_PORT_WAIT=") {
			continue
		}
		baseEnv = append(baseEnv, kv)
	}
	port := env("PORT")
	wait := env("PORT_WAIT")
	var crashes []time.Time

	for {
		out := filepath.Join(support, "engine.out")
		if _, err := os.Stat(out); err == nil {
			os.Rename(out, filepath.Join(support, "engine.prev.out"))
		}
		f, _ := os.OpenFile(out, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
		cmd := exec.Command(self)
		cmd.Env = append(append([]string{}, baseEnv...), "SROAD_PORT="+port, "SROAD_PORT_WAIT="+wait, "SROAD_CHILD=1")
		if wait == "1" {
			// 다시 켜는 경우: 작업 폴더를 지우지 않고 라이브러리를 이어서 불러와요
			cmd.Env = append(cmd.Env, "SROAD_RESTART=1")
		}
		cmd.Stdout, cmd.Stderr = f, f
		started := time.Now()
		if err := cmd.Start(); err != nil {
			supLog(support, "엔진을 켜지 못했어요: %v", err)
			if f != nil {
				f.Close()
			}
			os.Exit(1)
		}
		mu.Lock()
		child = cmd.Process
		mu.Unlock()
		supLog(support, "엔진 켬 (pid %d, 포트 %s)", cmd.Process.Pid, orDash(port))
		err := cmd.Wait()
		if f != nil {
			f.Close()
		}
		code := cmd.ProcessState.ExitCode()
		how := fmt.Sprintf("종료 코드 %d", code)
		if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			how = fmt.Sprintf("신호 %v 로 꺼짐", ws.Signal())
		}
		ran := time.Since(started).Round(time.Second)
		mu.Lock()
		stop := stopping
		child = nil
		mu.Unlock()
		if stop {
			supLog(support, "엔진을 껐어요 (%s)", how)
			return
		}
		// 엔진에게만 '그만' 신호가 간 경우: 켜진 직후라면 앱 창이 열리며 생긴 것이라 다시 켜고,
		// 그 뒤라면(활동 상태 보기의 종료 등) 일부러 끈 것으로 봐요
		if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() && (ws.Signal() == syscall.SIGTERM || ws.Signal() == syscall.SIGINT || ws.Signal() == syscall.SIGHUP) {
			// 지킴이에게도 같은 신호가 오는 중일 수 있어서 잠깐 기다렸다가 판단해요
			time.Sleep(300 * time.Millisecond)
			mu.Lock()
			stop := stopping
			mu.Unlock()
			if stop {
				supLog(support, "엔진을 껐어요 (%s)", how)
				return
			}
			if time.Since(supStart) < graceWindow+2*time.Second {
				supLog(support, "켜진 직후 엔진이 종료 신호로 꺼져서(%s) 바로 다시 켜요", how)
			} else {
				supLog(support, "엔진이 종료 신호로 꺼져서 다시 켜지 않아요 (%s)", how)
				return
			}
		} else if err == nil && code == 0 {
			supLog(support, "엔진이 정상적으로 끝났어요 (%s 동안 실행)", ran)
			return
		} else {
			supLog(support, "⚠️ 엔진이 갑자기 꺼졌어요: %s, %s 동안 실행\n----- 엔진 마지막 출력 -----\n%s\n----------------------------", how, ran, headTail(out, 30, 8))
		}

		now := time.Now()
		kept := crashes[:0]
		for _, t := range crashes {
			if now.Sub(t) < restartWindow {
				kept = append(kept, t)
			}
		}
		crashes = append(kept, now)
		if len(crashes) > maxRestarts {
			supLog(support, "5분 안에 %d번 꺼져서 더 이상 다시 켜지 않아요", len(crashes))
			os.Exit(1)
		}
		// 같은 포트·토큰으로 다시 켜서 열려 있던 창이 그대로 이어지게 해요
		if b, err := os.ReadFile(filepath.Join(support, "lastport")); err == nil && strings.TrimSpace(string(b)) != "" {
			port = strings.TrimSpace(string(b))
		}
		wait = "1"
		time.Sleep(700 * time.Millisecond)
	}
}

func orDash(s string) string {
	if s == "" {
		return "자동"
	}
	return s
}

// headTail keeps the first lines (where Go prints "panic:" / "fatal error:") and the last few.
func headTail(p string, head, tail int) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) <= head+tail+1 {
		return strings.Join(lines, "\n")
	}
	return strings.Join(lines[:head], "\n") + fmt.Sprintf("\n… (%d줄 생략) …\n", len(lines)-head-tail) + strings.Join(lines[len(lines)-tail:], "\n")
}

func env(k string) string { return os.Getenv("SROAD_" + k) }

// envArgs: 백그라운드 도우미 앱으로 켜질 때는 환경 변수를 넘길 수 없어서 `--env SROAD_X=값` 으로 받아요.
func envArgs() {
	for i := 1; i+1 < len(os.Args); i++ {
		if os.Args[i] == "--env" {
			if k, v, ok := strings.Cut(os.Args[i+1], "="); ok && strings.HasPrefix(k, "SROAD_") {
				os.Setenv(k, v)
			}
			i++
		}
	}
}

// childGrace: 엔진(자식)도 켜진 직후 graceWindow 동안은 종료 신호를 무시해요.
// (macOS 27 은 앱 창을 연 실행기가 끝날 때 엔진에게도 종료 신호를 보내요. 그대로 꺼지면 작업 중인 목록을 잃어요)
func childGrace() {
	if env("CHILD") != "1" {
		return
	}
	signal.Ignore(syscall.SIGHUP) // 예전처럼(nohup) 계속 무시해요
	// 주의: signal.Ignore 는 signal.Reset 으로 되돌릴 수 없어요. 그래서 유예 시간 동안은 받아서 버리고(Notify),
	// 끝나면 Reset 으로 원래대로(종료 신호를 받으면 꺼짐) 돌려요.
	ch := make(chan os.Signal, 4)
	signal.Notify(ch, syscall.SIGTERM)
	go func() {
		for range ch {
			log.Printf("켜진 직후 받은 종료 신호는 무시해요 (macOS 27)")
		}
	}()
	go func() {
		time.Sleep(graceWindow)
		signal.Reset(syscall.SIGTERM)
	}()
}
