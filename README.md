# Tarkov Helper Web

`Zeliper/Tarkov-Item-Helper`의 전체 기능과 `SIGDrone/Tarkov-Helper` 수정본의
PVP/PVE 분리·지도·커스텀 마커 변경을 브라우저에서 실행하도록 이식한 정적 웹 앱입니다.
실행 중 외부 게임 데이터 API를 호출하지 않으며, 참고 저장소에 포함된 DB와 자산만 사용합니다.

## 포함 기능

- 488개 퀘스트 검색·필터·상태 계산·추천·선행 자동 완료·대안 처리·목표 체크
- 26개 은신처 시설 레벨과 다음/전체 요구 사항
- 퀘스트와 은신처의 필요 아이템 통합, FIR/일반 보유량과 출처 추적
- Collector 및 재귀 선행 퀘스트의 카파 아이템 추적
- Terminal을 포함한 SVG 지도 12개, 팬·줌·층·퀘스트/탈출구/기본 마커
- EFT 스크린샷 파일명의 위치·방향 파싱과 이동 경로
- 프로필별 커스텀 지도 마커 추가·수정·삭제
- 사용자가 선택한 EFT 로그 파일/폴더의 퀘스트 이벤트 미리보기·적용
- 서로 완전히 분리된 PVP/PVE 진행도와 브라우저 로컬 저장
- 320px부터 데스크톱까지 대응하는 한국어 우선 UI

## 실행

Node.js 20 이상과 pnpm이 필요합니다.

```bash
pnpm install
pnpm dev --host 127.0.0.1
```

브라우저에서 `http://127.0.0.1:4173`을 엽니다.

프로덕션 빌드:

```bash
pnpm build
pnpm preview
```

## 검증

```bash
pnpm test --run
pnpm typecheck
pnpm lint
pnpm build
pnpm test:e2e
```

## 데이터

생성된 `public/data/tarkov-data.json`과 모든 필수 지도·아이콘이 이미 포함되어 있어
일반 실행에는 원본 저장소나 네트워크가 필요하지 않습니다.

정확한 참고 저장소 체크아웃에서 데이터를 다시 생성하려면 다음처럼 실행합니다.

```bash
python scripts/export_data.py --source /path/to/SIGDrone-Tarkov-Helper --output public
```

내보내기는 수정본의 `TarkovHelper/Assets/tarkov_data.db`를 읽기 전용으로 열고,
예상 테이블 행 수와 복사한 파일을 검증합니다. 번들 글꼴은 재배포하지 않았으며,
설정에서 시스템 글꼴을 선택하거나 개인 글꼴 파일을 현재 세션에 불러올 수 있습니다.

## 브라우저 동작 차이

브라우저는 임의의 게임 폴더를 백그라운드에서 감시하거나 전역 단축키·항상 위 오버레이를
등록할 수 없습니다. 따라서 로그와 스크린샷은 사용자가 명시적으로 선택하며, 지도는 페이지
내 전체화면으로 제공합니다. 퀘스트 적용·위치 계산·프로필 분리 결과는 데스크톱 앱과 같습니다.

## 데이터 출처

- 원본: `Zeliper/Tarkov-Item-Helper` (`ef71936bd428f2abb0c1320010a8e7c29c36482f`)
- 수정본: `SIGDrone/Tarkov-Helper` (`77ee7343ed0f98dc6aa8610519062c61120535f1`, `v1.5.7`)

자세한 귀속 정보는 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)에 있습니다.
