# Tarkov Helper Web

`Zeliper/Tarkov-Item-Helper`의 전체 기능과 `SIGDrone/Tarkov-Helper` 수정본의
PVP/PVE 분리·지도·커스텀 마커 변경을 브라우저에서 실행하도록 이식한 웹 앱입니다.
퀘스트·지도·진행도 기능은 포함된 DB와 자산만 사용합니다. 시세 화면은 포함된 스냅샷으로
오프라인 검색할 수 있고, Windows 바로 실행 버전에서는 Tarkov.dev의 최신 시세를 선택적으로 확인합니다.

## 포함 기능

- 488개 퀘스트 검색·필터·상태 계산·진행 중 입력·선행 자동 완료·대안 처리·목표 체크
- 26개 은신처 시설 레벨과 다음/전체 요구 사항
- 퀘스트와 은신처의 필요 아이템 통합, FIR/일반 보유량과 출처 추적
- 5,309개 아이템의 한글·영문·약칭 PVP/PVE 시세 검색과 Windows 바로 실행 버전의 실시간 갱신
- Collector 및 재귀 선행 퀘스트의 카파 아이템 추적
- Terminal을 포함한 SVG 지도 12개, 팬·줌·층·퀘스트/탈출구/기본 마커와 키보드 조작
- EFT 스크린샷 폴더 자동 감지, 위치·방향·층·이동 경로 실시간 반영
- 지도와 현재 플레이어만 표시하고, 플레이어 추적/고정 보기·팬·줌을 지원하는 300×300 미니맵
- 프로필별 커스텀 지도 마커 추가·수정·삭제
- 사용자가 선택한 EFT 로그 파일/폴더의 퀘스트 이벤트 미리보기·적용
- 서로 완전히 분리된 PVP/PVE 진행도와 브라우저 로컬 저장
- 320px부터 데스크톱까지 대응하는 한국어 우선 UI

## 실행

### Windows 바로 실행 배포본

아이콘이 내장된 `Tarkov Helper.exe`를 더블클릭하면 콘솔 창 없이 백그라운드 서버와 기본 브라우저가 열립니다.
이 파일을 오른쪽 클릭하면 Windows의 `작업 표시줄에 고정` 기능도 사용할 수 있습니다. EXE 실행이 보안 정책으로
차단된 환경에서는 `Tarkov Helper 실행.vbs`를 호환용 실행 파일로 사용할 수 있습니다.
GitHub 업데이트용 RSA 서명은 내려받은 패키지의 무결성을 검증하지만 Windows Authenticode 게시자 인증서는
아닙니다. 따라서 조직의 실행 정책이나 SmartScreen 설정에 따라 EXE 실행이 차단될 수 있으며, 앱은 이 정책을
우회하지 않습니다.
진행도 보존을 위해 `http://127.0.0.1:41753/`을 고정으로 사용합니다. 종료할 때는
`Tarkov Helper 종료.vbs`를 더블클릭하세요. 자세한 내용은 배포본의 `사용 안내.txt`를 참고하세요.

배포본의 `Tarkov Helper 시작 메뉴 등록.vbs`를 실행하면 현재 사용자 Windows 시작 메뉴에 전용
TH 아이콘이 적용된 `Tarkov Helper` 바로가기가 추가됩니다. 관리자 권한이나 자동 시작은 사용하지
않습니다. 폴더를 옮겼다면 새 위치에서 다시 등록하고, 제거할 때는
`Tarkov Helper 시작 메뉴 제거.vbs`를 실행하세요. 제거는 시작 메뉴 바로가기만 삭제하며 앱 데이터는
건드리지 않습니다. 시작 화면과 작업 표시줄 고정은 Windows에서 사용자가 직접 선택합니다.

공개 GitHub 릴리스에 연결된 바로 실행 배포본은
`설정 > 데이터 > 프로그램 업데이트`에서 `업데이트 확인`을 누르면 새 버전을 확인합니다. 새 버전에서
`업데이트 및 계속 사용`을 누르면
다운로드·검증한 뒤 전체 앱과 데이터를 자동으로 교체합니다. 일반적인 패키지는 로컬 서버가 같은
주소로 수 초간 재시작되며, 큰 패키지나 느린 저장 장치에서는 검증 시간이 더 걸릴 수 있습니다.
현재 탭이 자동으로 새로고침되므로 직접 탭을 닫거나 실행 파일을 다시 누를 필요가
없습니다. 새 버전이 정상 기동하지 않으면 실행기가 이전 버전으로 자동 복원하고 같은 주소로 다시
연결합니다. 이전 버전 폴더는 복구 확인이 끝날 때까지만 유지하며, 새 버전의 정상 기동이 확인되면
자동으로 삭제합니다. 백신이나 파일 잠금 때문에 즉시 삭제할 수 없으면 숨김 정리 폴더로 옮겨 다음 실행에서 재시도합니다.

이 업데이트 기능은 **Windows 바로 실행 배포본 전용**입니다. 일반 정적 웹 배포에는 로컬 파일을
교체할 권한이 없으므로 기능은 비활성화되고 안내만 표시됩니다. 공개 릴리스를 익명으로 읽기 때문에 이용자는 계정,
라이선스 키, GitHub 토큰 또는 별도 권한을 입력하지 않습니다. 업데이트 확인·다운로드에는 인터넷
연결이 필요합니다.

실행 중 적용 기능이 없는 v1.0.4 이하 배포본은 이 기능을 스스로 추가할 수 없습니다. v1.0.5 바로
실행 버전만 한 번 수동으로 내려받아 기존 폴더 대신 설치해야 하며, 그 다음
버전부터는 사용 중 한 번의 클릭으로 갱신할 수 있습니다. 진행도와 설정은 고정 주소의 브라우저 로컬
저장소에 있고 실행 상태는 배포 폴더 밖에 보관되므로, 같은 브라우저 프로필과
`127.0.0.1:41753`을 유지하면 업데이트 후에도 그대로 남습니다.

최신 `dist`에서 바로 실행 폴더를 생성하려면 다음 명령을 사용합니다. 출력 폴더가 이미 있으면 덮어쓰지 않고 중단합니다.

```bash
pnpm release:direct
```

### 개발 서버

Node.js 22.22.2 이상과 pnpm 11.16.0이 필요합니다.

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

빌드는 상대 자산 경로를 사용하므로 도메인 루트뿐 아니라 `/tarkov-helper/` 같은 하위 경로에도 배포할 수 있습니다.

## 검증

```bash
pnpm test --run
pnpm test:portable
pnpm typecheck
pnpm lint
pnpm build
pnpm test:e2e
```

Windows에서는 설치된 Edge 또는 Chrome을 자동으로 사용합니다. macOS/Linux에 Chromium이 없다면
E2E 실행 전에 `pnpm exec playwright install chromium`을 한 번 실행하세요.

## 공개 GitHub 릴리스 설정

공개 저장소의 `.github/workflows/release.yml`은 `package.json`의 안정 버전 태그가 푸시되면
테스트, 세 가지 ZIP 생성, SHA-256 검증, RSA 서명, GitHub 증명(attestation), 릴리스 게시 순서로
실행됩니다. 사용자 배포본에는 공개키만 들어가며 개인키나 GitHub 토큰은 들어가지 않습니다.

최초 설정 요약:

1. 저장소에서 immutable releases를 활성화합니다.
2. `main`과 `v*` 태그를 ruleset으로 보호하고 강제 푸시와 삭제를 막습니다. `main`에는 CI 통과를
   필수로 설정합니다.
3. `github-release` Environment를 만들고 required reviewers를 지정합니다.
4. 이 Environment에 `UPDATE_SIGNING_PRIVATE_KEY`와 `IMMUTABLE_RELEASES_READ_TOKEN` secret을
   추가합니다. 후자는 해당 저장소만 선택하고 **Administration: read**만 허용한
   fine-grained token이며, 서명 직전 immutable releases 설정 확인에만 사용합니다.
5. Repository Actions variable `UPDATE_SIGNING_PUBLIC_KEY`에 SPKI PEM 공개키를 추가합니다.

RSA-3072 키는 네트워크에 연결되지 않은 안전한 환경에서 다음처럼 생성할 수 있습니다. 개인키 파일은
저장소에 복사하거나 커밋하지 말고, `github-release` Environment secret에만 등록합니다.

```powershell
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out update-signing-private.pem
openssl pkey -in update-signing-private.pem -pubout -out update-signing-public.pem
openssl pkey -pubin -in update-signing-public.pem -outform DER -out update-signing-public.der
openssl dgst -sha256 update-signing-public.der
```

마지막 명령의 64자리 소문자 해시 앞에 `sha256:`을 붙인 값이 `keyId`입니다. 릴리스 도구도 SPKI DER에
대해 같은 방식으로 계산하며, 개인키와 공개키가 다르거나 RSA 키가 3072비트 미만이면 중단합니다.

릴리스할 때는 `package.json`의 `version`을 먼저 `x.y.z` 형식으로 올리고 변경을 보호된 `main`에
병합합니다. CI가 끝난 정확한 커밋에 같은 버전의 태그를 붙여 푸시합니다.

```powershell
git tag -a v1.2.3 -m "Tarkov Helper v1.2.3"
git push origin v1.2.3
```

태그는 반드시 `v<package.json version>`과 같아야 합니다. 워크플로는 태그 커밋이 기본 브랜치에
포함됐는지 재확인하고, 검증된 draft에 자산을 올린 뒤 서명 메타데이터와 GitHub 자산 ID·digest를
결합합니다. 모든 검증이 끝나야 stable/latest 릴리스로 게시하며, 실패하면 draft를 남기고 기존 최신
릴리스는 바꾸지 않습니다. 자세한 결정과 키 교체 원칙은
[ADR-001](./docs/decisions/001-public-github-updates.md)을 참고하세요.

## 데이터

생성된 `public/data/tarkov-data.json`과 모든 필수 지도·아이콘이 이미 포함되어 있어
퀘스트·지도·아이템 요구량 기능에는 원본 저장소나 네트워크가 필요하지 않습니다. 시세 검색도
릴리스 시점의 PVP/PVE 스냅샷을 포함합니다. Windows 바로 실행 버전에서 아이템을 선택하면
`json.tarkov.dev`의 해당 아이템 가격 기록만 로컬 실행기가 조회하며, 성공한 결과는 10분 동안
재사용하고 통신 실패 시 최대 7일 이내의 검증된 로컬 캐시를 표시합니다. 검색어, 퀘스트 진행도,
설정은 전송하지 않습니다. 공개 릴리스 업데이트 확인·다운로드와 사용자가 직접 여는 위키 링크도
인터넷을 사용합니다.

정확한 참고 저장소 체크아웃에서 데이터를 다시 생성하려면 다음처럼 실행합니다.

```bash
python scripts/export_data.py --source /path/to/SIGDrone-Tarkov-Helper --output public
pnpm data:refresh-prices
```

시세 카탈로그를 갱신하면 같은 검증된 한글·영문 이름을 아이템 데이터에도 반영합니다. 외부 접속 없이 현재 번들만 다시 적용하려면 `pnpm data:localize-items`를 사용합니다.

내보내기는 수정본의 `TarkovHelper/Assets/tarkov_data.db`를 읽기 전용으로 열고,
예상 테이블 행 수와 복사한 파일을 검증합니다. 번들 글꼴은 재배포하지 않았으며,
설정에서 시스템 글꼴을 선택하거나 개인 글꼴 파일을 현재 세션에 불러올 수 있습니다.

## 브라우저 동작 차이

일반 정적 웹 배포에서는 브라우저 보안 정책상 임의의 게임 폴더를 백그라운드에서 감시할 수
없으므로 로그와 스크린샷을 사용자가 직접 선택합니다. Windows 바로 실행 배포본은 로컬 실행기가
EFT 스크린샷 폴더를 자동 감지해 새 PNG 파일명에서 위치를 읽고, 같은 시각의 EFT application
로그에서 지도가 명확히 확인되면 해당 지도로 자동 전환합니다. 이미지 내용과 로그 원문은 브라우저로
전달하지 않으며, 지도를 확인할 수 없을 때는 사용자의 현재 지도 확인을 요구합니다.

미니맵은 Edge/Chrome의 Document Picture-in-Picture를 지원하면 별도 창으로 열리고,
미지원 환경에서는 페이지 안 고정 패널로 열립니다. 일반 정적 웹/압축 배포에서는 브라우저
제약상 게임 창으로 마우스 클릭을 통과시키는 기능과 전역 단축키를 제공하지 않습니다.
미니맵 창이나 페이지 내 미니맵에 포커스한 상태에서는 `Alt + +`로 5% 확대하고
`Alt + -`로 5% 축소할 수 있습니다.

Windows `바로 실행` 버전에서는 미니맵을 기본 300×300 무테·항상 위 오버레이로 고정할 수
있습니다. 잠금 또는 클릭 통과 상태에서는 Edge/Chrome의 주소·창 조작 영역을 제외하고
지도 영역만 표시합니다. 본 지도 화면에서 잠금을 풀어 위치와 크기를 조정한 뒤 다시 고정할 수
있으며, 클릭 통과도 본 지도 화면에서 해제합니다. 표시 방식·확대율·투명도·플레이어 크기와
위치 초기화는 메인 웹의 `설정 > 화면 > 미니맵`에서 조정합니다. 오버레이가 열린 동안에는
게임에 포커스가 있어도 `Alt + +`와 `Alt + -`가 각각 5% 확대·축소로 동작합니다.
다른 프로그램과 단축키가 충돌하면 메인 웹에 안내하고, 미니맵을 클릭해 포커스했을 때 동작하는
방식으로 전환합니다. `Tarkov Helper 종료.vbs`는 서버 종료 전에 원래
PiP 창 스타일과 위치를 복원합니다. 잠긴 위치와 크기는 현재 실행 세션에만 유지됩니다.
퀘스트 적용·위치 계산·프로필 분리 결과는 데스크톱 앱과 같습니다.

## 데이터 출처

- 원본: `Zeliper/Tarkov-Item-Helper` (`ef71936bd428f2abb0c1320010a8e7c29c36482f`)
- 수정본: `SIGDrone/Tarkov-Helper` (`77ee7343ed0f98dc6aa8610519062c61120535f1`, `v1.5.7`)
- 아이템 시세·한글/영문 이름: [Tarkov.dev API](https://github.com/the-hideout/tarkov-api) 및
  `https://json.tarkov.dev/`

자세한 귀속 정보는 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)에 있습니다.
이 웹 포트 자체의 라이선스는 [LICENSE](./LICENSE)를 확인하세요.
