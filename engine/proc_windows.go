//go:build windows

package main

import (
	"os/exec"
	"strconv"
	"syscall"
)

// Windows 버전은 나중에 만들 예정이라 최소한의 구현만 둡니다.

func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200} // CREATE_NEW_PROCESS_GROUP
}

func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
	}
}

func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008} // DETACHED_PROCESS
}

func freeSpace(path string) int64 { return 0 }
