#!/bin/bash
# 내려받기용 zip 만들기 — 저장소에는 늘 최신판 zip 1개만 (사용자 요청 2026-10-29)
#   저장소 첫 화면의 '앱 받기' 링크로 바로 받을 수 있게, 앱 + 사용 가이드가 든 zip 을 download/ 폴더에 두고
#   예전 zip 은 지워요. 자동 업데이트(releases/)와는 따로예요.
#   (GitHub 릴리스 페이지는 이 작업 환경에서 만들 수 없어서 저장소 안 폴더를 써요)
#
#   scripts/publish-download.sh [처음 설치용 맥 zip]
#     - 맥 zip 을 주면 (release.sh 가 dist/SROAD.zip 을 넘겨요) download/SROAD.zip 으로 바꿔 넣어요
#     - releases/latest-win.json 이 있으면 업데이트용 exe + Windows 가이드로 download/SROAD-Windows.zip 을 새로 만들어요
#   그다음 커밋 · 푸시하면 끝. 받는 주소(버전이 바뀌어도 그대로):
#     https://github.com/NeverthelessD/SROAD/raw/main/download/SROAD.zip
set -euo pipefail
NAME="SROAD"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="$(tr -d ' \n' < VERSION)"
MAC_ZIP="${1:-}"
mkdir -p download

if [ -n "$MAC_ZIP" ]; then
  # 맥 zip 확인: <NAME>/<NAME>.app 과 사용 가이드가 들어 있고, 앱 버전이 VERSION 과 같아야 해요
  python3 - "$MAC_ZIP" "$NAME" "$VERSION" <<'PY'
import sys, unicodedata, zipfile
z = zipfile.ZipFile(sys.argv[1]); name, v = sys.argv[2], sys.argv[3]
def fix(i):  # 맥 ditto zip 은 UTF-8 표시 없이 한글을 풀어 쓴 꼴(NFD)로 적어요
    n = i.filename if i.flag_bits & 0x800 else i.filename.encode("cp437").decode("utf-8", "replace")
    return unicodedata.normalize("NFC", n)
infos = z.infolist(); names = [fix(i) for i in infos]
assert any(n.startswith(f"{name}/{name}.app/") for n in names), f"zip 안에 {name}/{name}.app 이 없어요"
assert any(n.startswith(f"{name}/") and n.endswith("사용가이드.png") for n in names), "zip 안에 사용 가이드 이미지가 없어요"
vt = [i for i, n in zip(infos, names) if n.endswith(f"{name}.app/Contents/Resources/version.txt")]
if vt:
    got = z.read(vt[0]).decode().strip()
    assert got == v, f"zip 안의 앱 버전({got})이 VERSION({v})과 달라요"
print("✔ 맥 zip 확인 (앱 + 사용 가이드)")
PY
  cp "$MAC_ZIP" "download/$NAME.zip"
fi

if [ -f releases/latest-win.json ]; then
  WZIP="releases/$(python3 -c "import json;print(json.load(open('releases/latest-win.json'))['zip'])")"
  python3 - "$WZIP" "download/$NAME-Windows.zip" "$NAME" "docs/${NAME}_Windows_사용가이드.png" <<'PY'
import os, sys, zipfile
src, out, name, guide = sys.argv[1:5]
with zipfile.ZipFile(src) as s:
    exe = s.read(f"{name}.exe")
    zi = s.getinfo(f"{name}.exe")
tmp = out + ".part"
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    info = zipfile.ZipInfo(f"{name}/{name}.exe", zi.date_time); info.compress_type = zipfile.ZIP_DEFLATED
    z.writestr(info, exe)
    if os.path.exists(guide):
        z.write(guide, f"{name}/{os.path.basename(guide)}")
os.replace(tmp, out)
print("✔ Windows zip 만들기 (앱 + 사용 가이드)")
PY
fi

# download/ 에는 최신판만: 정해진 이름 말고는 모두 지워요
find download -mindepth 1 -maxdepth 1 ! -name "$NAME.zip" ! -name "$NAME-Windows.zip" -exec rm -rf {} +
[ -f "download/$NAME.zip" ] || { echo "✖ download/$NAME.zip 이 없어요 — 맥 처음 설치용 zip 을 넘겨 주세요" >&2; exit 1; }
echo "✔ download/: $(ls download | tr '\n' ' ')— 커밋 · 푸시하면 '앱 받기' 링크가 새 버전을 줘요"
