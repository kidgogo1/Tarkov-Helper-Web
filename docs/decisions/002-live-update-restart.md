# ADR-002: 실행 중 업데이트 적용과 자동 재연결

## 상태

Accepted

## 날짜

2026-08-09

## 목표

Windows 바로 실행 버전을 사용 중인 사용자가 새 stable 릴리스를 발견하면 한 번의 명시적 동작으로
다운로드, 서명·해시 검증, 전체 패키지 교체, 같은 로컬 주소의 서버 재시작, 브라우저 새로고침까지
완료하고 기존 진행도와 설정을 이어서 사용한다.

## 사용자 경험

- `업데이트 및 계속 사용`을 누르면 선택한 정확한 후보를 다운로드하고 검증한 뒤 즉시 적용한다.
- 실행 파일과 웹 번들을 교체하는 동안 일반적인 패키지는 수 초간 로컬 서버 연결이 끊길 수 있다.
  매우 큰 패키지나 느린 저장 장치에서는 검증이 더 오래 걸릴 수 있으며, 화면은 이를 예상된 재시작으로
  표시하고 같은 `http://127.0.0.1:41753` 주소가 새 버전으로 돌아오면 자동 새로고침한다.
- 재시작 전에 현재 입력 상태가 저장되어야 하며 PVP/PVE 진행도와 설정은 같은 origin의
  `localStorage`를 그대로 사용한다.
- 새 서버가 기동 검증에 실패하면 broker가 이전 전체 폴더를 복원한다. 브라우저는 이전 서버에 다시
  연결하고 업데이트 실패를 표시하며 무한 새로고침하지 않는다.
- 정적 웹 배포에서는 적용 기능을 비활성화하고 Windows 바로 실행 버전 전용이라는 안내만 표시한다.

## 인터페이스

기존 same-origin, memory-only token 인증 경계에 다음 mutation을 추가한다.

```text
POST /api/v1/app-update/apply
Origin: http://127.0.0.1:41753
Sec-Fetch-Site: same-origin
X-Tarkov-Update: <session token>
Content-Type: application/json

{"candidateId":"<reviewed opaque id>"}
```

요청은 `READY_TO_RESTART` 상태와 `pending.json`의 후보가 모두 정확히 일치할 때만 `202`를 반환한다.
응답 전에 실행기는 staged tree를 다시 검증하고, 상태 저장소에 해시로 고정한 external broker를 먼저
기동한다. broker가 정확한 현재 PID·시작 시각·빌드·후보·포트에 결속되어 종료를 기다린다는 ACK를
보낸 뒤에만 응답 상태 `APPLYING`을 전송한다. 응답 전송이 실패하면 nonce에 결속된 취소 표식을 쓰고
broker의 정확한 종료를 확인하므로 기존 서버는 그대로 실행된다. 응답 전송에 성공하면 서버는
listener와 native overlay/watcher/instance state를 정상 종료하고, 미리 준비된 broker가 동일 pending
plan을 적용한다.
웹은 기존 session token이 서버 재시작 때 폐기된다는 전제에서 새 session을 받아 version과 terminal
status를 확인한다.

## 구현 경계

- 브라우저가 URL, 파일 경로, PID, 포트, 해시 또는 broker 경로를 넘길 수 없게 한다.
- 현재 설치본에 포함되고 `pending.json`에 해시로 고정된 broker만 실행한다.
- 해시로 고정된 broker의 신원·staged tree·현재 서버를 검증하고 ACK를 받은 뒤에만 `202`를 보낸다.
- `202` 전송에 실패하면 broker 취소와 정확한 종료를 확인하고 기존 server request loop로 돌아간다.
- API 응답을 flush한 뒤에만 server shutdown과 실제 directory swap이 시작되게 한다.
- 설치는 sibling staging과 디렉터리 rename, same-port health/version probe, 자동 rollback이라는
  ADR-001의 transaction을 그대로 재사용한다.
- 실행 중 적용과 다음 실행 적용 모두 패키지 크기·파일 수로 계산한 검증 예산을 사용한다. broker는
  staged tree와 교체된 tree를 각각 다시 검증하므로 적용 제한 시간은 단일 검증 예산의 두 배에
  health/start/rename/cleanup 여유를 더해 120초에서 85분 사이로 제한한다. 새 서버의 인증된 health
  대기는 일반 cold start와 같은 30초를 사용한다.
- 첫 package-to-backup rename이 잠금 때문에 실패했지만 아직 swap이 시작되지 않았다면 후보와 pending을
  삭제하지 않는다. 기존 서버를 인증해 다시 기동하고 `READY_TO_RESTART`로 되돌려 다음 명시적 재시도를
  허용한다. 브라우저는 이 상태를 90분 동안 `APPLYING`으로 오인하지 않고 재시도 안내로 끝낸다.
- 여러 탭에서 동시에 적용해도 한 요청만 transaction을 소유하고 나머지는 충돌 응답을 받는다.
- 자동 재연결은 최대 90분의 제한 시간과 초기 10초 이후 빈도를 낮추는 bounded polling을 가지며,
  새 버전 또는 복원된 이전 버전만 신뢰한다.
- `UpdateNonce`가 있는 replacement/rollback Serve에만 첫 client lease를 기다리는 5분 유예를 둔다.
  첫 탭이 연결되면 기존 탭 종료 수명 주기로 전환하고, 끝내 연결이 없을 때만 orphan 서버를 종료한다.
  일반 Serve나 정상 heartbeat에는 이 자동 종료 조건을 적용하지 않는다.
- 진짜 무중단 hot swap은 하지 않는다. 실행기와 JavaScript 자체가 바뀌므로 짧은 자동 재시작과
  reload가 안전하고 예측 가능한 최소 중단 방식이다.

## 검증 기준

1. API는 잘못된 token/origin/body/candidate/state를 거부하고 성공 응답을 완전히 전송한다.
2. 실제 임시 direct package가 실행 중 `check -> stage -> apply`만으로 새 버전의 같은 포트 서버가 된다.
3. 새 서버 health 실패 시 이전 버전이 같은 포트로 복원되고 terminal `ERROR`가 보존된다.
4. 프런트는 다운로드·검증 뒤 apply를 호출하고 예상된 네트워크 단절을 오류로 오표시하지 않는다.
5. 새 session의 `currentVersion`이 목표와 일치할 때 한 번만 reload한다. 이전 버전 복원 또는 timeout은
   오류로 끝나며 reload loop를 만들지 않는다.
6. 전체 Vitest, typecheck, ESLint, portable updater/lifecycle/overlay 회귀가 headless 또는 off-screen으로
   통과한다. 메인 모니터에 브라우저나 PiP 창을 띄우지 않는다.

## Bootstrap 제한

v1.0.5부터 실행 중 apply endpoint와 브라우저 자동 재연결을 지원한다. 이는 정상 상태의 기능 기준이며
모든 과거 로컬 상태와 느린 저장 장치를 무조건 자동 복구한다는 뜻은 아니다. v1.0.3과 v1.0.4는 같은
서명·교체 프로토콜로 최신 릴리스를 준비할 수 있지만, 앱을 종료하고 다시 실행해야 pending 업데이트가
적용된다.
v1.0.1과 v1.0.2도 updater protocol 1을 사용하지만 실행 프로세스의 현재 디렉터리가 패키지 폴더인 경우
Windows가 폴더 rename을 막는다. 이미 배포된 구버전 broker는 새 패키지가 실행되기 전에 동작하므로 최신
패키지 코드로 이 잠금을 안전하게 우회할 수 없다. 이 두 버전과 출처를 확인할 수 없는 더 오래된 설치본은
기존 앱을 종료한 뒤 최신 Direct ZIP을 짧은 새 폴더에 푸는 수동 bootstrap을 사용한다. 상세 릴리스 호환성
정책은 ADR-004를 따른다.

업데이트의 첫 hop은 항상 현재 설치본의 launcher·worker·broker가 수행한다. 따라서 동적 적용 제한 시간,
30초 health, 잠금 실패 후보 보존 같은 새 방어는 해당 방어가 포함된 릴리스를 한 번 설치한 뒤의 업데이트부터
적용된다. 새 릴리스는 직전 공개 Direct 설치본이 가진 기존 제한 시간 안에서도 실제 후보를 적용할 수 있는지
별도 first-hop 회귀로 확인해야 한다.
