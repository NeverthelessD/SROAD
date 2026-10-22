#!/bin/bash
# 맥 빌드 서버에서 돌아요: 빌드 → 실제 맥 시험 → 결과를 ci-results 브랜치에 올림 (실패해도 기록은 올려요)
# Claude 는 빌드 서버 화면을 볼 수 없어서, 결과(빌드 기록 · 시험 결과 · 스크린샷 · 앱 zip)를 저장소로 받아 봐요.
set -uo pipefail
ROOT="$(pwd)"
OUT="$ROOT/ci-out"; rm -rf "$OUT"; mkdir -p "$OUT"
VERSION="$(tr -d ' \n' < VERSION)"
export OUT

{
  echo "commit: ${GITHUB_SHA:-local}  version: $VERSION  started: $(date -u +%FT%TZ)"
  sw_vers; uname -m
} > "$OUT/info.txt"

BUILD=fail; SMOKE=skip
if bash scripts/build-mac.sh > "$OUT/build.log" 2>&1; then
  BUILD=ok
  cp "dist/SROAD-$VERSION.zip" "$OUT/"
  cp dist/SROAD.zip "$OUT/SROAD-first-install.zip"
  shasum -a 256 "$OUT/SROAD-$VERSION.zip" "$OUT/SROAD-first-install.zip" > "$OUT/sha256.txt"
  if bash scripts/smoke-mac.sh > "$OUT/smoke.log" 2>&1; then SMOKE=ok; else SMOKE=fail; fi
fi
printf '{"version":"%s","commit":"%s","build":"%s","smoke":"%s"}\n' "$VERSION" "${GITHUB_SHA:-local}" "$BUILD" "$SMOKE" > "$OUT/status.json"
cat "$OUT/status.json"; tail -40 "$OUT/build.log"; [ -f "$OUT/smoke.log" ] && tail -40 "$OUT/smoke.log"

if [ -n "${GITHUB_TOKEN:-}" ]; then
  cd "$OUT"
  git init -q && git checkout -q -b ci-results
  git add -A
  git -c user.name="SROAD build" -c user.email="NeverthelessD@users.noreply.github.com" commit -qm "v$VERSION build=$BUILD smoke=$SMOKE (${GITHUB_SHA:-local})"
  git push -qf "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" ci-results
fi
[ "$BUILD" = ok ] && [ "$SMOKE" = ok ]
