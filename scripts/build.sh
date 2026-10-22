#!/bin/bash
# 1.1.0 부터 SROAD.app 은 맥에서만 만들 수 있어요 (Swift 앱 껍데기 · 앱 전체 서명).
# 맥 빌드 서버(.github/workflows/build-mac.yml → scripts/ci-mac.sh → scripts/build-mac.sh)가 만들고 시험해요.
# 릴리스는 scripts/release.sh 를 쓰세요. 리눅스에서 엔진만 시험하려면: go -C engine build -o /tmp/sroad .
echo "SROAD.app 은 맥 빌드 서버에서 만들어요 → scripts/release.sh 를 쓰세요 (PROJECT_NOTES.md 참고)" >&2
exit 1
