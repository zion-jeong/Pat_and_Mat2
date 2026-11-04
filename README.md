# STEELCOAT 웹 — H빔 도장 금지 영역 지정

KS D 3502:2022 H형강 95종에서 단면을 고르고, 3D 화면에서 칠하지 않을 영역을 지정해
작업 JSON(`steelcoat-job-v1`)으로 내보냅니다. 빌드 과정 없는 정적 페이지이며
three.js는 `vendor/`에 포함되어 인터넷 없이 동작합니다.

## 실행

```bash
cd web
python3 -m http.server 8000
# PC: http://localhost:8000
# 태블릿(같은 Wi-Fi): http://<PC IP>:8000
```

`file://`로 직접 열면 모듈 로딩이 막히므로 반드시 서버로 여세요.
홈 화면 설치·오프라인 캐시(PWA)는 HTTPS 또는 localhost에서만 활성화됩니다.

## 사용

1. 부재 번호, 호칭 → 단면, 길이(mm) 선택
2. **영역 그리기** 모드에서 면 위를 드래그 → 사각형 금지 영역
   - 한 손가락: 그리기 / 두 손가락: 확대·이동 / **보기** 모드: 회전
   - `면 폭 전체로 그리기`: 길이 방향만 지정
   - `+ 전체 면 길이 구간`: 모든 면의 같은 길이 구간 (볼트 체결부 등)
   - 목록에서 숫자로 미세 조정, 5 mm 단위 스냅
3. 작업자 입력, 승인 체크 → **JSON 내보내기** (태블릿은 공유 시트)

## 좌표와 면 (planner.py와 동일)

- X: 길이, 0 = 시작단(초록 단면) / Y: 폭, 웹 중심 0, +좌 / Z: 높이, 0 = 하부 플랜지 아랫면. 단위 mm
- 면: `top_outer`, `bottom_outer`, `top_inner_left/right`, `bottom_inner_left/right`, `web_left/right`
- 플랜지 두께면과 필렛(r)은 도장 대상·형상에서 생략

## 출력 예

```json
{
  "schema": "steelcoat-job-v1",
  "member": "B-101",
  "approved": true,
  "approved_by": "홍길동",
  "approved_at": "2026-11-04T01:57:40.215Z",
  "spec": "H-400 × 200 × 8 × 13",
  "spec_ref": { "standard": "KS D 3502:2022", "no": 45, "H": 400, "B": 200, "t1": 8, "t2": 13, "r": 16, "kg_m": 66 },
  "length_mm": 6000,
  "exclusion_zones": [
    { "start": 0, "end": 250 },
    { "face": "top_outer", "start": 2155, "end": 3280, "axis": "y", "from": -60, "to": 25 },
    { "face": "web_right", "start": 4145, "end": 4720, "axis": "z", "from": 185, "to": 215 }
  ]
}
```

- `face` 없음: 모든 면의 길이 구간 (기존 planner 형식)
- `face` 있음: 그 면의 사각형. `from`/`to`는 `axis` 좌표(플랜지 면 Y, 웹 면 Z)
- 현재 planner는 `face`를 무시하고 길이 구간 전체를 모든 면에서 제외합니다(보수적).
  면별 사각형 반영은 planner 확장 작업입니다.

## 파일

- `hbeam_specs.js` — KS 규격표 엑셀에서 자동 변환한 95종
- `app.js` — 3D 화면, 영역 편집, 면적 계산, 내보내기/불러오기, 임시 저장
- `manifest.webmanifest`, `sw.js`, `icons/` — 태블릿 앱(PWA)
- `vendor/` — three.js r160 (MIT, `three-LICENSE`)
