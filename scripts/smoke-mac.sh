#!/bin/bash
# SROAD 실제 맥 시험 (맥 빌드 서버에서 dist/SROAD.app 을 /Applications 에 깔고 여러 상황을 시험해요)
# 결과: $OUT/results.txt (PASS/FAIL 한 줄씩), 스크린샷, 기록 파일
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$ROOT/ci-out}"
mkdir -p "$OUT"
APPDIR="/Applications/SROAD.app"
SUP="$HOME/Library/Application Support/SROAD"
RES="$OUT/results.txt"
: > "$RES"

pass() { echo "PASS  $*" | tee -a "$RES"; }
fail() { echo "FAIL  $*" | tee -a "$RES"; }
check() { local name="$1"; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }

app_pid() { pgrep -x SROAD | head -1; }
engines() { pgrep -x sroad-engine | tr '\n' ' '; }
tok() { cat "$SUP/token" 2>/dev/null; }
port() { cat "$SUP/port" 2>/dev/null; }
ping_ok() { curl -fs -m 2 -H "x-token: $(tok)" "http://127.0.0.1:$(port)/api/ping" >/dev/null 2>&1; }
wait_ready() { for _ in $(seq 1 60); do [ -s "$SUP/port" ] && ping_ok && return 0; sleep 0.5; done; return 1; }
wait_gone() { for _ in $(seq 1 30); do [ -z "$(app_pid)" ] && [ -z "$(engines)" ] && return 0; sleep 0.5; done; return 1; }
snap() { echo "--- $1"; ps -axo pid,ppid,stat,comm | grep -E "SROAD|sroad-engine" | grep -v grep; } >> "$OUT/procs.txt"
launch() { open "$APPDIR"; wait_ready; }

echo "▶ 준비: 앱 설치 · 설정"
rm -rf "$APPDIR"; ditto "$ROOT/dist/SROAD.app" "$APPDIR"
mkdir -p "$SUP"
printf '{"appearance":"light","autoSave":true,"autoUpdate":false,"ui":{}}' > "$SUP/settings.json"

echo "▶ A. 켜기 · 화면"
launch; check "A1 앱을 열면 엔진이 준비됨" ping_ok
check "A2 엔진이 Dock 앱 방식으로 켜짐(shell=native)" bash -c "curl -fs -H 'x-token: $(tok)' http://127.0.0.1:$(port)/api/ping | grep -q '\"shell\":\"native\"'"
check "A3 화면 상태(/api/poll)에 Dock 앱 표시" bash -c "curl -fs -H 'x-token: $(tok)' 'http://127.0.0.1:$(port)/api/poll?rev=0' | grep -q '\"shell\":\"native\"'"
FIRSTPORT=$(port)
sleep 8
screencapture -x "$OUT/shot-app.png"
check "A5 앱 창(WKWebView)이 화면을 불러옴" grep -q "화면 열림" "$SUP/launcher.log"
APID=$(app_pid); snap "A 실행 중"
# (맥의 프로그램 경로에는 빈칸이 있어서 줄 전체에서 찾아요)
SUPPID=$(ps -axo pid=,ppid=,comm= | awk -v a="$APID" '$2==a && /sroad-engine/ {print $1}' | head -1)
CHILD=$(ps -axo pid=,ppid=,comm= | awk -v s="$SUPPID" '$2==s && /sroad-engine/ {print $1}' | head -1)
check "A6 엔진이 SROAD 앱의 자식 (앱 $APID → 지킴이 ${SUPPID:-없음} → 엔진 ${CHILD:-없음})" test -n "$SUPPID" -a -n "$CHILD"

echo "▶ B. Dock 아이콘 다시 누르기(reopen)"
osascript -e 'tell application "SROAD" to reopen' >/dev/null 2>&1; sleep 1
check "B1 다시 열기 뒤에도 앱·엔진 그대로" test "$(app_pid)" = "$APID"

echo "▶ C. 엔진이 고장으로 꺼지면 지킴이가 다시 켬"
kill -SEGV "$CHILD" 2>/dev/null; sleep 4
check "C1 엔진 다시 켜짐" ping_ok
check "C2 앱은 그대로" test "$(app_pid)" = "$APID"

echo "▶ D. 앱 종료(⌘Q) → 엔진까지 모두 꺼짐 · 작업 폴더 정리"
mkdir -p "$SUP/work" && touch "$SUP/work/keep-me"
osascript -e 'tell application "SROAD" to quit' >/dev/null 2>&1
check "D1 앱·엔진 모두 꺼짐" wait_gone
check "D2 종료하면 임시 작업 폴더를 정리함" test ! -e "$SUP/work/keep-me"
snap "D 종료 뒤"

echo "▶ E. 화면의 '종료' 버튼(= /api/quit) → 앱도 꺼짐"
launch
curl -fs -X POST -H "x-token: $(tok)" "http://127.0.0.1:$(port)/api/quit" >/dev/null
check "E1 앱·엔진 모두 꺼짐" wait_gone

echo "▶ F. 앱이 강제로 꺼지면 엔진도 스스로 꺼짐"
launch; kill -9 "$(app_pid)"; sleep 1
check "F1 남은 엔진 없음" bash -c 'for i in $(seq 1 20); do [ -z "$(pgrep -x sroad-engine)" ] && exit 0; sleep 0.5; done; exit 1'

echo "▶ G. 업데이트 뒤 다시 열기 (/api/update/restart) · 작업 목록 이어 가기"
launch; OLD=$(app_pid)
check "G0 지난번과 같은 주소로 켜짐 ($FIRSTPORT → $(port))" test "$(port)" = "$FIRSTPORT"
touch "$SUP/work/keep-me"
curl -fs -X POST -H "x-token: $(tok)" "http://127.0.0.1:$(port)/api/update/restart" >/dev/null
sleep 3
check "G1 새로 열린 앱이 엔진을 켬" wait_ready
NEW=$(app_pid)
check "G2 앱이 새로 열림 ($OLD → ${NEW:-없음})" test -n "$NEW" -a "$NEW" != "$OLD"
check "G3 업데이트 뒤에도 작업 폴더가 그대로" test -e "$SUP/work/keep-me"
osascript -e 'tell application "SROAD" to quit' >/dev/null 2>&1; wait_gone

echo "▶ H. 1.0.1 이하에서 업데이트된 경우 (앱 파일을 직접 실행) → 정식 방법으로 다시 열림"
SROAD_RESTART=1 "$APPDIR/Contents/MacOS/SROAD" >/dev/null 2>&1 &
sleep 4
check "H1 다시 열린 앱이 엔진을 켬" wait_ready
check "H2 앱 하나만 떠 있음 ($(pgrep -x SROAD | wc -l | tr -d ' ')개)" test "$(pgrep -x SROAD | wc -l | tr -d ' ')" = "1"
screencapture -x "$OUT/shot-after-legacy-update.png"
osascript -e 'tell application "SROAD" to quit' >/dev/null 2>&1
check "H3 끝나면 모두 꺼짐" wait_gone

echo "▶ 기록 모으기"
for f in launcher.log launcher.prev.log engine.log engine.out engine.prev.out settings.json; do
  [ -f "$SUP/$f" ] && cp "$SUP/$f" "$OUT/$f"
done
sw_vers > "$OUT/macos.txt"
echo
echo "== 결과 =="; cat "$RES"
! grep -q '^FAIL' "$RES"
