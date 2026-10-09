# SROAD

AI 음원 분리 · 편집 스튜디오 (macOS, Apple Silicon) — made by. Nevertheless_D

| 메뉴 | 하는 일 |
|---|---|
| **ROAD Vocal** · 보컬 추출 | 목소리를 뺀 MR, 목소리만 남긴 보컬(아카펠라) 만들기 |
| **ROAD Track** · 악기 분리 | 보컬 · 드럼 · 베이스 · 그 밖의 악기(6트랙: +기타 · 피아노)로 나누기, 고른 트랙만 합치기 |
| **ROAD Pitch** · 키 변경 | 빠르기는 그대로, 키만 반음 단위로 −12 ~ +12 |
| **ROAD Tempo** · 템포 변경 | 음 높이는 그대로, 빠르기만 50% ~ 200% (BPM으로도 지정) |
| **ROAD Edit** · 편집 | 파형 보며 자르기 · 잘라내기 · 복사 · 붙여넣기 · 삭제 · 이동 · 파일/무음 삽입 · Fade In/Out · 실행 취소, 원곡과 비교 |

- 여러 곡을 한 번에 넣고(개수 제한 없음) 체크한 곡을 **일괄 처리**할 수 있어요.
- 읽기/저장 형식: MP3 · M4A · WAV · FLAC, 음질 128k · 192k · **320k(기본)** · 무손실
- 저장 폴더 지정 · 기본 폴더 지정, 라이트/다크 모드(기본: macOS 설정)
- **자동 업데이트**: 이 저장소의 `releases/latest.json`을 확인해 새 버전을 받아요. 수동 확인 · 이전 버전 되돌리기도 돼요.

## 설치

1. [`releases/`](releases) 폴더에서 가장 최신 `SROAD-x.y.z.zip`을 받아 압축을 풀어요.
2. `SROAD.app`을 **응용 프로그램** 폴더로 옮겨요. (업데이트가 동작하려면 꼭 옮겨 주세요)
3. 처음 열 때 경고가 뜨면 **시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기"**.
4. 앱 화면에서 **AI 엔진 설치 시작**을 누르면 약 300MB를 받아요 (처음 한 번만).

모든 구성요소는 `~/Library/Application Support/SROAD` 한 폴더에만 설치돼요.
지우려면 앱을 휴지통에 버리고 그 폴더도 지우면 끝이에요.

## 사용한 오픈소스

- [Demucs](https://github.com/adefossez/demucs) (Meta, MIT) — AI 음원 분리
- [Rubber Band](https://breakfastquay.com/rubberband/) via [pedalboard](https://github.com/spotify/pedalboard) (GPL) — 키 · 템포 변경
- [FFmpeg](https://ffmpeg.org) (LGPL/GPL, [martin-riedl.de](https://ffmpeg.martin-riedl.de) 빌드) — 음원 읽기 · 저장
- [PyTorch](https://pytorch.org), [uv](https://github.com/astral-sh/uv)
- 글꼴: [Pretendard](https://github.com/orioncactus/pretendard), [Unbounded](https://github.com/googlefonts/unbounded) (SIL OFL)

AI 엔진(PyTorch · Demucs · 모델 · FFmpeg)은 앱에 들어 있지 않고, 처음 실행할 때 각 배포처에서 직접 받아요.

## 폴더 구조

```
engine/     Go 엔진 (로컬 서버 · 작업 대기열 · 인코딩 · 설치 · 업데이트) + worker.py (AI)
engine/web/ 앱 화면 (HTML · CSS · JS)
app/        SROAD.app 껍데기 (실행 스크립트 · Info.plist · 아이콘)
scripts/    빌드 스크립트
releases/   업데이트 파일 (SROAD-x.y.z.zip, latest.json)
docs/       사용 가이드 이미지
```
