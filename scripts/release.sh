#!/bin/bash
# SROAD 릴리스 (1.1.0~): 맥 빌드 서버가 만들고 실제 맥에서 시험한 앱을 그대로 업데이트로 내보내요.
#   1) VERSION 을 올리고 커밋 · 푸시 → 맥 빌드 서버가 ci-results 브랜치에 결과를 올릴 때까지 기다려요 (5~10분)
#   2) scripts/release.sh --notes "바뀐 점 1" "바뀐 점 2"
#      → ci-results 의 결과가 지금 VERSION · 커밋과 맞고 build=ok · smoke=ok 인지 확인한 뒤
#        releases/SROAD-<v>.zip · releases/latest.json · dist/SROAD.zip(처음 설치용)을 만들어요
#   3) 커밋 · 푸시
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="$(tr -d ' \n' < VERSION)"
NOTES=()
if [ "${1:-}" = "--notes" ]; then shift; NOTES=("$@"); fi

git fetch -q origin ci-results
TMP="$(mktemp -d)"
git archive origin/ci-results | tar -x -C "$TMP"
cat "$TMP/status.json"
python3 - "$TMP/status.json" "$VERSION" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); v = sys.argv[2]
assert s["version"] == v, f"빌드 서버 결과의 버전({s['version']})이 VERSION({v})과 달라요"
assert s["build"] == "ok" and s["smoke"] == "ok", f"빌드 서버 결과가 통과가 아니에요: {s}"
PY
python3 - "$TMP" <<'PY'
import hashlib, os, sys
d = sys.argv[1]
for line in open(os.path.join(d, "sha256.txt")):
    h, path = line.split(maxsplit=1)
    f = os.path.join(d, os.path.basename(path.strip()))
    got = hashlib.sha256(open(f, "rb").read()).hexdigest()
    assert got == h, f"{f} 의 내용이 빌드 서버 기록과 달라요"
print("✔ 빌드 서버 파일 확인")
PY
mkdir -p releases dist
cp "$TMP/SROAD-$VERSION.zip" "releases/SROAD-$VERSION.zip"
cp "$TMP/SROAD-first-install.zip" dist/SROAD.zip
python3 scripts/feed.py releases/latest.json "$VERSION" "releases/SROAD-$VERSION.zip" "${NOTES[@]+"${NOTES[@]}"}"
ls -1t releases/SROAD-*.zip | tail -n +4 | xargs -r rm -f
rm -rf "$TMP"
echo "✔ releases/SROAD-$VERSION.zip · latest.json · dist/SROAD.zip — 커밋 · 푸시하면 설치된 앱들이 받아요"
