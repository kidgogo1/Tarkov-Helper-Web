# 공개 구버전 업데이트 호환성 실증 보고서

- 조사일: 2026-08-14 KST
- 기준: GitHub Releases의 immutable Direct ZIP과 각 ZIP에 포함된 원본 launcher/worker/broker
- 목적: “새 버전 코드가 정상”이라는 검사와 “이미 배포된 구버전이 새 버전까지 도달”하는 검사를 분리한다.

## 결론

업데이트 파일의 서명·해시·ZIP 검증은 전 공개 릴리스에서 같은 protocol 1과 trust root를 유지하고 있다.
반복 장애의 주원인은 다운로드 자체보다 **교체를 수행하는 구버전 코드**, Windows 폴더 잠금, 공유된
`%LOCALAPPDATA%\TarkovHelperWeb\app-update` transaction 상태, 느린 디스크·백신에서의 고정 시간 제한이다.

이미 배포된 실행기는 후보 패키지를 swap하기 전에 동작한다. 따라서 새 릴리스에 포함된 수정만으로 과거
실행기의 첫 hop 결함을 소급해서 고치는 것은 불가능하다. 유지보수 계약은 다음 세 경로를 함께 가져야 한다.

1. 검증된 버전 cohort의 자동 업데이트
2. 기존 앱을 종료하고 새 짧은 폴더에 푸는 side-by-side bootstrap
3. 매 릴리스의 공개 구버전 first-hop 회귀

## 실제 재현 행렬

| 시작 버전·상태 | 실제 결과 | 원인·운영 판정 |
|---|---|---|
| v1.0.1, package 폴더를 CWD로 실행 | Check/Stage 성공, Apply 실패 후 1.0.1 rollback | 구 launcher/broker가 자기 package 폴더를 잠금. 자동 반복 금지, side-by-side bootstrap |
| v1.0.1, package 밖 CWD | v1.0.31까지 성공 | 서명·protocol 자체는 호환됨. v1.0.2도 같은 코드 경계 |
| v1.0.3 | v1.0.31까지 성공 | CWD 해제 수정 포함. 종료 후 다음 실행 적용 cohort |
| v1.0.5 running Serve | apply 202, 같은 포트에서 v1.0.31 기동 | live apply 최소 cohort |
| v1.0.13 + 기존 `.update-backup` | APPLY_FAILED, rollback | 구 broker의 고정 backup 충돌. v1.0.14에서 해소 |
| v1.0.14 + 같은 backup fixture | 성공 | stale backup 처리 cohort |
| v1.0.20 + 불완전 legacy pending | Start exit 2, 상태 보존 | fresh 폴더도 global state를 공유하므로 명시적 복구 경계 필요 |
| v1.0.27 + currentVersion 이상 오래된 pending | transaction을 stale archive 후 정상 시작 | resilience cohort |
| v1.0.20·27·30 정상 상태 | Check/Stage/Apply 성공 | 정상 state machine의 장기 호환성 확인 |
| v1.0.30 + 외부 프로세스 포트 점유 | exit 2, 원인 로그 보존 | 업데이트가 아니라 고정 origin 충돌로 분류 |

GitHub Releases에 실제 Direct 자산이 있는 공개 버전은 v1.0.1~9, v1.0.11~15, v1.0.19~20,
v1.0.27~31의 21개다. 자산이 없는 tag는 자동 업데이트 모집단으로 간주하지 않고 출처 불명 설치로 다룬다.

## 현재 코드에 반영한 재발 방지

- 첫 package rename이 잠금으로 끝내 실패하더라도 swap 전이라면 staged 후보와 pending을 보존하고 기존
  서버를 인증해 다시 기동한다. 상태는 `READY_TO_RESTART`로 돌아가 다음 시도에서 재사용한다.
- 브라우저는 재기동된 이전 서버의 `READY_TO_RESTART`를 발견하면 90분 polling을 계속하지 않고 재시도
  안내와 진단 코드를 표시한다.
- 다음 실행 적용의 broker 제한 시간을 고정 60초 대신 두 번의 tree 검증과 health·rename·cleanup을 포함한
  패키지 기반 제한 시간으로 계산한다. 새 서버 health는 일반 cold start와 같은 30초를 허용한다.
- 직전 stable broker가 새 tree를 옮긴 직후 중단되어도 새 launcher는 고정 rollback sibling의 이전
  version/commit과 broker SHA-256을 다시 인증해 그 broker로 journal을 이어간다. 상태 폴더의 pinned
  broker만 단독으로 신뢰하지 않으며 rollback broker가 한 바이트라도 바뀌면 복구를 거부한다.
- broken Direct session 초기화 실패와 정적 웹의 정상 비지원을 UI와 진단에서 구분한다.
- terminal update 오류는 화면에 안정적인 `operation/code` 지원 코드를 표시한다.
- `AVAILABLE` 상태에서는 다시 확인을 비활성화하고 이미 검증해 24시간 보관하는 후보를 Stage에 재사용한다.
- launcher·worker·broker가 `StateDirectory` 바깥의 동일한 transaction file lock을 함께 사용하고, 기존
  `UpdateApply` mutex와 `worker.lock`도 유지한다. 그래서 새 코드끼리는 Windows 세션과 side-by-side
  폴더가 달라도 같은 pending·journal·package sibling을 동시에 바꾸지 않는다.
- PREPARED·NEW_MOVED·COMMITTED 중단 지점을 각각 구분한다. tree digest, version/commit, broker hash,
  PID/start time, port, backup·failed·cleanup topology가 모두 맞는 범위에서만 재개하거나 terminal metadata를
  정리하며, 불명확하면 원본을 보존한다. cleanup은 reparse·10,000개·1 GiB 경계를 매 재시도마다 검증한다.
- 명시적 `Tarkov Helper 상태 복구.cmd`는 control/serve/update lock과 loopback port를 잡고, 현재 설치에
  정확히 묶인 복구 불가능 상태만 삭제 없이 고유 quarantine으로 옮긴다. 정상 journal, live process,
  rollback/failed 증거 또는 다른 설치 소유 상태는 거부한다.
- pre-tag의 최소 pending 형식은 `candidateId`·`port`가 실제로 없을 때만 호환한다. 존재하지만 손상된 값은
  legacy로 낮추지 않으며, 이전 package root가 이미 없어도 parent의 backup·stage·cleanup·failed 흔적을
  모두 검사한 뒤에만 stale metadata를 격리한다.
- 공유 상태가 불명확해 명시적 Repair조차 거부할 때는 일반 상태를 건드리지 않는
  `Tarkov Helper 격리 복구 실행.cmd`를 제공한다. 기존 앱과 고정 포트가 비어 있을 때만 deterministic
  `%LOCALAPPDATA%\TarkovHelperWeb-Isolated-Recovery` 상태로 시작하며, 같은 명령의 `stop`만 그 상태를
  종료한다. 데이터 삭제·자동 migration은 하지 않고 브라우저 origin은 유지한다. 이 모드에서는
  `-DisablePackageUpdates`로 Check·Stage·Apply와 package-adjacent rollback/cleanup을 모두 차단한다.

이 방어는 이를 포함한 버전이 설치된 뒤부터 유효하다. 특히 직전 공개판에서 다음 후보로 가는 첫 hop은
직전판의 launcher 제한을 받으므로 실제 old-to-candidate 검증을 생략할 수 없다.

## 남은 구조적 위험과 다음 우선순위

1. global update transaction은 여러 side-by-side 설치가 공유한다. 현재 새 코드는 cross-session file lock과
   legacy locks로 직렬화하지만 이미 배포된 구 broker는 새 file lock을 모른다. 첫 hop의 이 한계는 historical
   gate와 수동 bootstrap으로 관리하고, 장기적으로 packageRoot/installationId 단위 namespace로 분리해야 한다.
2. unparseable pending은 어느 설치의 mid-swap 증거인지 알 수 없어 자동 삭제할 수 없다. 명시적 Repair가
   증명 가능한 상태만 격리하고 나머지는 읽기 전용 isolated state로 우회하는 것이 의도한 안전 경계다.
3. 익명 GitHub API는 공유 IP당 60회/시간이다. 현재 성공 Check는 core API 3회, Stage는 2회를 사용하므로
   같은 NAT에서 약 12회의 전체 시도만으로 제한에 닿을 수 있다. UI의 후보 재사용 외에도 reset 시각 안내와
   향후 안전한 release-download 경로 전환을 검토하되 host·asset ID·digest·서명 검증은 약화하지 않는다.
4. protocol 1은 staged `UPDATE_CONFIG`의 endpoint·schema·key를 exact 비교한다. 이를 느슨하게 바꾸지 말고,
   v2는 병렬 자산으로 추가하며 key/endpoint 전환은 old-key bridge 후 두 번째 hop으로 수행한다.

## 매 릴리스 최소 게이트

1. 후보 ZIP의 서명, manifest, asset ID/digest, tree hash, SafeZip 검증
2. 현재 synthetic check→stage→apply, rollback, crash replay, 파일 잠금 회귀
3. `package.json`보다 낮은 가장 최신 Git tag의 launcher/worker/broker 원문을 사용하는 synthetic
   first-hop. 500개·10 MiB 이상인 release-sized 앱 트리를 사용하고, pending에 그 구버전 broker 해시가
   고정되며 후보가 같은 포트에서 `UPDATED`로 재기동되는지 확인
4. 대표 v1.0.3/5/14/20/27 cohort 중 updater/protocol 변경에 영향받는 cohort
5. v1.0.1/2 side-by-side bootstrap에서 진행도 유지와 old 폴더 미삭제 확인
6. 실패 시 browser diagnostics와 server/worker/broker 로그에 operation/code가 남고 token/path가 redacted되는지 확인

실제 production-signed 후보를 공개 전 old worker에 제공하려면 old client의 exact GitHub configuration을
유지한 HTTPS fixture가 필요하다. 소규모 배포에서는 우선 exact signed bundle 검증과 synthetic gate를
출시 전에 사용하고, 게시 직후 previous stable→실제 GitHub latest smoke를 추가한다. 업데이트 장애가 다시
발생하면 keyless Windows VM의 HTTPS shadow release gate로 승격한다.

현재 CI의 synthetic first-hop은 구버전 updater 코드·고정 시간 제한·broker pinning·swap 프로토콜 회귀를
막지만, 공개 GitHub asset ID와 production signing key까지 재현한다고 주장하지 않는다. 그 경계는 최종
서명 bundle 검증과 게시 직후 실제 GitHub smoke가 담당한다.
