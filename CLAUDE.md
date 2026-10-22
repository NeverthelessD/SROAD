# SROAD — notes for Claude

SROAD is a personal macOS (Apple Silicon) app for **Nevertheless_D**, who is not a programmer.
Talk to them in Korean, in plain words. Never ask them to use Terminal; give them a double-clickable result.

## What it is

Since 1.1.0 `SROAD.app` is a **real, visible Dock app**: `Contents/MacOS/SROAD` is a Swift/AppKit shell (`app/shell/main.swift`)
with a WKWebView window. It copies `Contents/Resources/sroad-engine` (a Go binary) to `~/Library/Application Support/SROAD/bin/`,
runs it as its own child (app → supervisor → engine) on 127.0.0.1 with a token (same port as last time, from `lastport`),
and shows the UI in its window. The engine runs only while the app is open (⌘Q stops everything; closing the window keeps the app in the Dock).
It can only be built on a Mac — see "Releasing an update".

- `engine/` — Go, stdlib only. Embeds `web/` and `worker.py`.
  - `main.go` routes/settings · `library.go` uploads, ffprobe, peaks, streaming · `jobs.go` queue (one AI lane, one quick lane for saves/exports)
  - `encode.go` ffmpeg output (mp3 libmp3lame, m4a aac_at/ALAC, wav, flac; 128/192/320/lossless)
  - `setup.go` first-run installer: ffmpeg (martin-riedl), uv → Python 3.11 → torch 2.5.1 + demucs 4.0.1 (no-deps) + pedalboard, Demucs weights from dl.fbaipublicfiles.com. Bump `envVersion` when Python packages change (users get a re-install prompt).
  - `update.go` auto-update from `releases/latest.json` in this repo (raw.githubusercontent.com), sha256 check, swaps the .app (backup kept in Support/backup for rollback), restart keeps port+token so the open window reloads.
- `engine/worker.py` — Demucs separation (MPS first, CPU fallback) and Rubber Band pitch/tempo. Prints JSON lines.
- `engine/web/js/` — ES modules: `core` (state/api/helpers) · `library` · `modes` (Vocal/Track/Pitch/Tempo) · `player` (A/B compare) · `editor` (segment-list editor) · `panels` (save settings, queue, setup, updates, settings) · `main`.

Design: five lane colours (Vocal #ff5c8a, Track #8a6cff, Pitch #2bc5e8, Tempo #ffb020, Edit #2fd39a), indigo night / lavender mist backgrounds, Pretendard + Unbounded (bundled). Footer must say `made by. Nevertheless_D`.

## macOS 27: Background App Activity (why 1.1.0 is a Dock app)

macOS 27 terminates processes that keep running after their app quits with no visible presence ("Background App Activity",
System Settings › General › Login Items & Extensions), unless the app that launched them is in the Dock. 1.0.1 worked around this
(hidden `SROAD Engine.app` helper + supervisor ignoring SIGTERM for 20 s); 1.1.0 removed that and follows the rule instead.
**Never reintroduce hidden helpers or SIGTERM-ignoring.**
- Shell env to the supervisor: `SROAD_SUPERVISOR=1 SROAD_SHELL=native SROAD_VIA=native SROAD_TOKEN SROAD_SUPPORT SROAD_APP SROAD_PARENT_PID SROAD_PORT(=lastport) SROAD_PORT_WAIT=1`.
- `engine/supervise.go`: obeys SIGTERM/INT/HUP, stops when the app (PARENT_PID) disappears, restarts the engine only after a real crash
  (same port, `SROAD_RESTART=1` so the work folder/library is kept; max 5 in 5 min). Engine exit 0 → supervisor exits → app quits.
- Engine (`main.go`): no idle shutdown in native mode; `watchParent`; `watchSignals` cancels AI jobs + the installer (`Setup.Stop`) before exiting,
  so no python/uv process is left running. `/api/ping` and `/api/poll` include `"shell"`.
- Update restart (`update.go`): native → `lib.Save()`, write `Support/restart-requested`, `shutdown(true)`; the shell sees the marker and relaunches
  itself with `NSWorkspace.openApplication` (env without SROAD_RESTART, plus `SROAD_RELAUNCHED=1` → the new engine gets `SROAD_RESTART=1` and keeps the work list).
  Updating from 1.0.1: the old updater runs `Contents/MacOS/SROAD` directly with `SROAD_RESTART=1` → the shell relaunches itself properly.
  An old Chrome window that reconnects sees `shell=native` and shows "SROAD가 새 모습으로 바뀌었어요" (`IS_SHELL` = UA contains `SROADShell`).
- `launcher.log` in Support records shell (`[앱 pid]`, incl. "화면 열림") and supervisor steps (ask the user to drag it into the chat when debugging).
`signal.Ignore` can NOT be undone by `signal.Reset`. Never use `pkill -f sroad-engine` in tests — it matches your own shell; use `pgrep -x`/`pkill -x`.

## Releasing an update (this is how the user's app updates itself)

The app needs Swift + codesign, so it is built on a real Mac by GitHub Actions (`.github/workflows/build-mac.yml` → `scripts/ci-mac.sh`
→ `scripts/build-mac.sh` + `scripts/smoke-mac.sh`). The session proxy blocks the Actions API, so results are read via git:
1. Make the change. Bump `VERSION` (semver). Commit and push to `main` (changes under app/, engine/, VERSION, docs png or the CI scripts trigger the build).
2. Wait 5–10 min, then `git fetch origin +refs/heads/ci-results:refs/remotes/origin/ci-results` and read `status.json`, `results.txt`,
   `build.log`, `smoke.log`, screenshots (`git show origin/ci-results:results.txt`). It must be for the current VERSION/commit with build=ok smoke=ok.
3. `scripts/release.sh --notes "바뀐 점 1" "바뀐 점 2"` (Korean, user-facing) → verifies the CI result + sha256, writes `releases/SROAD-<v>.zip`,
   `releases/latest.json` and `dist/SROAD.zip` (first install: folder with the app + usage guide). Keeps the three newest zips.
4. Commit and push. Installed apps pick it up within 6 hours or via "업데이트 확인". Send the user `dist/SROAD.zip` for a fresh install if they ask.
Never publish a `latest.json` whose zip is missing or whose `version.txt` differs — the app verifies both. Don't delete the `ci-results` branch.

## Testing without a Mac

Build for Linux (`go build -o /tmp/sroad-linux ./engine`) and run with env overrides:
`SROAD_SUPPORT` (data dir), `SROAD_TOKEN`, `SROAD_FFMPEG_DIR` (dir with ffmpeg/ffprobe), `SROAD_TORCH_INDEX=https://download.pytorch.org/whl/cpu`,
`SROAD_TEST_CHOOSE` (fake folder picker result), `SROAD_APP` (fake .app path for update tests), `SROAD_UPDATE_URL` (local latest.json).
Drive the UI with Playwright (Chromium is preinstalled). MUSDB18 test songs with ground-truth stems are on Hugging Face (`danjacobellis/musdb`).

The Mac CI smoke test covers launch, Dock reopen, crash restart, ⌘Q, quit button, app force-kill, update relaunch (incl. from 1.0.1).
Things only the user's Mac can confirm: osascript folder picker, Finder reveal, MPS acceleration, Gatekeeper prompts, macOS 27 behaviour.

## Later

The user plans a Windows version with the same features. The engine already builds for windows/amd64
(`proc_windows.go`); still needed: a Windows launcher, ffmpeg download for Windows, Explorer integration, folder picker, and an update swap that works with a running .exe.

## User-facing text

Never mention GitHub (or the repo name) in anything the user sees — app screens, update messages, usage-guide images.
Say "새 버전이 나오면 앱이 알아서 받아요" instead. The user asked for this for all of their apps.
