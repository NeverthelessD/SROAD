# SROAD — notes for Claude

SROAD is a personal macOS (Apple Silicon) app for **Nevertheless_D**, who is not a programmer.
Talk to them in Korean, in plain words. Never ask them to use Terminal; give them a double-clickable result.

## What it is

A "script-type" app: `SROAD.app/Contents/MacOS/SROAD` is a bash launcher (`app/launcher.sh`). It copies
`Contents/Resources/sroad-engine` (a Go binary) to `~/Library/Application Support/SROAD/bin/`, starts it on
127.0.0.1 with a random token, and opens the UI in a Chrome `--app` window (or the default browser).

- `engine/` — Go, stdlib only. Embeds `web/` and `worker.py`.
  - `main.go` routes/settings · `library.go` uploads, ffprobe, peaks, streaming · `jobs.go` queue (one AI lane, one quick lane for saves/exports)
  - `encode.go` ffmpeg output (mp3 libmp3lame, m4a aac_at/ALAC, wav, flac; 128/192/320/lossless)
  - `setup.go` first-run installer: ffmpeg (martin-riedl), uv → Python 3.11 → torch 2.5.1 + demucs 4.0.1 (no-deps) + pedalboard, Demucs weights from dl.fbaipublicfiles.com. Bump `envVersion` when Python packages change (users get a re-install prompt).
  - `update.go` auto-update from `releases/latest.json` in this repo (raw.githubusercontent.com), sha256 check, swaps the .app (backup kept in Support/backup for rollback), restart keeps port+token so the open window reloads.
- `engine/worker.py` — Demucs separation (MPS first, CPU fallback) and Rubber Band pitch/tempo. Prints JSON lines.
- `engine/web/js/` — ES modules: `core` (state/api/helpers) · `library` · `modes` (Vocal/Track/Pitch/Tempo) · `player` (A/B compare) · `editor` (segment-list editor) · `panels` (save settings, queue, setup, updates, settings) · `main`.

Design: five lane colours (Vocal #ff5c8a, Track #8a6cff, Pitch #2bc5e8, Tempo #ffb020, Edit #2fd39a), indigo night / lavender mist backgrounds, Pretendard + Unbounded (bundled). Footer must say `made by. Nevertheless_D`.

## macOS 27: the engine must not be a child of the launcher (since 1.0.1)

On macOS 27, when an app's main executable exits (our bash launcher, right after it opens the Chrome window),
the system sends SIGTERM to every process that app started — `nohup`, `disown` and `setsid` do not protect them.
Found with MSROAD's launcher.log on the user's Mac (macOS 27.0.1): the engine got SIGTERM ~1 s after the window opened.
So:
- The launcher builds `Support/bin/SROAD Engine.app` (LSBackgroundOnly helper bundle holding a copy of the engine) and starts it with
  `open -g -j -n -a "SROAD Engine.app" --args --env SROAD_SUPERVISOR=1 --env SROAD_TOKEN=… …` (LaunchServices → its own app, not ours).
  `open` can't pass env vars, so the engine reads `--env KEY=VALUE` args (`envArgs()`). If that fails or isn't ready in 8 s, it falls back to `nohup`.
- `engine/supervise.go`: with SROAD_SUPERVISOR=1 the binary is a supervisor that runs the real engine as a child (SROAD_CHILD=1),
  restarts it on a crash (same port via `lastport`, SROAD_RESTART=1 so work isn't wiped; max 5 in 5 min), and ends when the engine exits 0.
  Safety net: for the first 20 s (`graceWindow`, tests: SROAD_GRACE_SEC) both supervisor and child swallow SIGTERM; after that SIGTERM means stop.
  Gotcha: `signal.Ignore` can NOT be undone by `signal.Reset` — use Notify + drain, then Reset.
- `launcher.log` in Support records each launch step and every engine exit (ask the user to drag it into the chat when debugging).
Test on Linux with a fake `open` that `setsid nohup`s the helper's binary, then `kill -TERM` every `sroad-engine` right after launch.
Never use `pkill -f sroad-engine` in tests — it matches your own shell's command line; use `pgrep -x`/`pkill -x`.

## Releasing an update (this is how the user's app updates itself)

1. Make the change. Bump `VERSION` (semver, e.g. 1.0.1).
2. `scripts/build.sh --notes "바뀐 점 1" "바뀐 점 2"` (Korean, user-facing). This writes `releases/SROAD-<v>.zip` and `releases/latest.json`.
3. Commit everything (including the zip and latest.json) and push to `main`. Installed apps pick it up within 6 hours or via "업데이트 확인".
4. Keep only the three newest zips in `releases/` (delete older ones in the same commit).
5. Also send the user the zip (`dist/SROAD.zip`) for a fresh install if they ask.

Never publish a `latest.json` whose zip is missing or whose `version.txt` differs — the app verifies both.

## Testing without a Mac

Build for Linux (`go build -o /tmp/sroad-linux ./engine`) and run with env overrides:
`SROAD_SUPPORT` (data dir), `SROAD_TOKEN`, `SROAD_FFMPEG_DIR` (dir with ffmpeg/ffprobe), `SROAD_TORCH_INDEX=https://download.pytorch.org/whl/cpu`,
`SROAD_TEST_CHOOSE` (fake folder picker result), `SROAD_APP` (fake .app path for update tests), `SROAD_UPDATE_URL` (local latest.json).
Drive the UI with Playwright (Chromium is preinstalled). MUSDB18 test songs with ground-truth stems are on Hugging Face (`danjacobellis/musdb`).

Things only a real Mac can confirm: osascript folder picker, Finder reveal, Chrome app window, MPS acceleration, Gatekeeper prompts.

## Later

The user plans a Windows version with the same features. The engine already builds for windows/amd64
(`proc_windows.go`); still needed: a Windows launcher, ffmpeg download for Windows, Explorer integration, folder picker, and an update swap that works with a running .exe.

## User-facing text

Never mention GitHub (or the repo name) in anything the user sees — app screens, update messages, usage-guide images.
Say "새 버전이 나오면 앱이 알아서 받아요" instead. The user asked for this for all of their apps.
