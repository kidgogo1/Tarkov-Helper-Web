# ADR-004: 다중 PC 배포와 구버전 업데이트 호환성

## 상태

Accepted

## 날짜

2026-08-14

## 배경

개발 PC 한 대에서 최신 버전만 실행하는 검증으로는 회사 PC 정책, 긴 설치 경로, 손상된 로컬 상태,
Windows 버전 차이와 아주 오래된 updater의 교체 동작을 확인할 수 없다. 공개 릴리스는 immutable이므로
이미 설치된 updater의 결함을 나중 릴리스 코드만으로 고칠 수도 없다. 특히 모든 기존 Direct 설치본은
동일한 RSA 공개키를 고정하므로 릴리스 키가 실수로 바뀌면 새 릴리스 자체는 정상이어도 기존 사용자는
전부 업데이트할 수 없게 된다.

## 결정

1. `release.config.example.json`에 기존 공개 Direct 설치본의 `trustedKeyId`를 고정한다. 릴리스 생성과
   최종 검증은 환경의 공개키가 이 값과 다르면 서명 전에 중단한다. 키 회전은 값만 바꾸는 방식으로 하지
   않으며, 기존 키와 새 키를 모두 검증할 수 있는 별도 bridge 릴리스·수동 배포 계획이 승인된 경우에만 한다.
2. 자동 업데이트 호환 범위를 다음과 같이 운영한다.
   - v1.0.5 이상 정상 상태: 실행 중 한 번의 클릭으로 다운로드, 적용, 같은 주소 재연결. 단, 첫 hop은
     설치된 구버전 코드가 수행하므로 그 버전의 시간 제한·파일 잠금·상태 복구 결함은 후보 패키지가
     swap되기 전에 소급해서 고칠 수 없다.
   - v1.0.3~v1.0.4: 다운로드·검증 후 앱 종료와 다음 실행에서 적용.
   - v1.0.1~v1.0.2 및 출처 불명 설치: 최신 Direct ZIP을 짧은 새 폴더에 푸는 수동 bootstrap.
   - v1.0.20 이하가 인증된 회사 프록시를 통해서만 GitHub에 연결되는 환경: 구버전 worker가 시스템
     프록시를 사용하지 않으므로 같은 수동 bootstrap. 현재 worker는 URI 허용 목록을 유지하면서 Windows
     기본 프록시와 현재 사용자 자격 증명을 사용한다.
3. 수동 bootstrap은 기존 앱을 먼저 종료하고 기존 폴더에 덮어쓰지 않는다. `%USERPROFILE%\TarkovHelper`
   같은 짧은 새 경로에서 최신 버전을 실행하고, 정상 기동을 확인할 때까지 기존 폴더를 보관한다. 진행도와
   설정은 같은 브라우저 프로필의 `127.0.0.1:41753` origin에 있으므로 이 절차에서 유지된다.
4. 손상된 `instance.json`은 자동 삭제하지 않는다. 명시적인 상태 복구 동작만 control mutex 아래에서
   실행하며, 기록된 프로세스가 살아 있으면 거부하고 그 외 파일은 이름이 충돌하지 않는 격리 파일로 옮긴다.
   공유 상태가 불명확해 복구도 거부하는 경우에는 기존 앱과 41753 포트가 모두 종료됐음을 확인한 뒤
   `Tarkov Helper 격리 복구 실행.cmd`로 `%LOCALAPPDATA%\TarkovHelperWeb-Isolated-Recovery` 상태만
   사용하는 side-by-side 실행을 제공한다. 일반 상태는 삭제·이동·자동 migration하지 않으며, 같은 CMD의
   `stop` 인수가 정확히 이 격리 상태만 종료한다. Start와 Stop 모두 launcher의 `-DisablePackageUpdates`를
   사용한다. 따라서 격리 모드는 기존 패키지 파일을 읽기 전용으로 서빙하고 Check/Stage/Apply뿐 아니라
   package-adjacent rollback/cleanup 정리도 수행하지 않는다. 고정 origin은 유지해 브라우저 진행도를 보존한다.
5. 대표 EXE는 Windows Script Host에 의존하지 않고 시스템 Windows PowerShell 5.1을 직접 실행한다.
   패키지 스크립트를 실행하기 위해 PowerShell `ExecutionPolicy Bypass`는 사용하지만 AppLocker, WDAC, SmartScreen 같은
   조직 실행 제어는 우회하지 않는다. 실패 시 로컬의 제한된 bootstrap 코드와 진단 실행 안내만 남긴다.
6. Windows 릴리스 검증은 기본 runner 외에 더 오래된 지원 runner를 포함하고, 준비된 Direct ZIP을 실제로
   다시 추출해 그 추출본으로 브라우저 E2E를 통과시킨다. 최종 릴리스 전에는 대표 구버전에서의 실제
   check/stage/apply 또는 문서화된 수동 bootstrap을 확인한다.
7. 자동 업데이트 호환성을 버전 번호만으로 추정하지 않는다. 공개 자산을 기준으로 다음 대표 cohort를
   회귀 대상으로 유지한다.
   - v1.0.3: 종료 후 적용이 가능한 최소 legacy cohort
   - v1.0.5: 실행 중 apply가 도입된 최소 cohort
   - v1.0.14: 고정 `.update-backup` 충돌이 수정된 cohort
   - v1.0.20: legacy pending·프록시 전환 전후 경계
   - v1.0.27: 손상된 오래된 transaction 정리가 추가된 cohort
   - 직전 stable: 실제 사용자가 가장 많이 밟는 첫 hop
   v1.0.1~v1.0.2는 자동 성공을 요구하지 않고 side-by-side bootstrap 안내가 실제로 작동하는지를 검사한다.
8. 현재 manifest/config protocol 1과 기존 signing trust root는 old client 호환 자산으로 유지한다. endpoint,
   manifest shape 또는 signing key를 바꿀 때는 기존 키로 서명된 bridge 릴리스와 다음 hop을 설계하며,
   bridge 자체를 적용할 수 없는 설치에는 side-by-side bootstrap을 제공한다.
9. 첫 hop broker가 package swap 중 중단되면 pending에 고정된 구 broker를 상태 복사본만으로 신뢰하지 않는다.
   고정 `.update-backup`의 이전 version/commit과 broker SHA-256이 모두 일치할 때만 그 코드로 journal을
   재개하며, rollback package가 없거나 한 바이트라도 바뀌면 원본 상태를 보존하고 거부한다.

## 고려했지만 채택하지 않은 대안

### 최신 worker가 모든 구버전 broker를 고친다고 가정

구버전 broker는 새 패키지를 교체하기 전에 기존 설치본에서 복사되어 실행된다. 최신 worker나 broker는
swap 성공 전에는 실행되지 않으므로 이 방식은 v1.0.1/1.0.2의 현재 디렉터리 잠금을 고칠 수 없다.

### 손상된 instance 상태 자동 삭제

파일이 손상되었어도 기존 서버가 살아 있을 수 있다. 자동 삭제는 인증되지 않은 중복 서버와 포트 충돌을
만들 수 있으므로 거부한다. 사용자가 명시적으로 복구를 선택한 경우에도 원본을 격리 보존한다.

### 서명 키를 릴리스 환경 변수만으로 관리

공개키와 개인키를 함께 잘못 교체하면 두 값은 서로 일치하므로 일반 키쌍 검사는 통과한다. 기존 설치본이
고정한 신뢰 루트와 별도로 비교해야 배포 단절을 막을 수 있다.

## 결과

- 지원 범위를 벗어난 오래된 설치는 무한 자동 재시도 대신 데이터가 유지되는 명확한 복구 경로를 갖는다.
- 릴리스 운영자가 키 변수를 실수로 함께 교체해도 기존 사용자에게 도달하지 못하는 릴리스는 게시 전에
  차단된다.
- Windows 정책과 파일 시스템 차이는 완전히 제거할 수 없으므로 짧은 설치 경로, 진단 기록, 다중 runner와
  실제 ZIP 실행 검증을 릴리스 계약으로 유지해야 한다.
- “모든 옛 버전 자동 업데이트” 대신 자동 호환 cohort, 수동 bootstrap cohort, 실제 first-hop 검증을
  분리하므로 실패 지점과 담당 코드가 명확해진다.
