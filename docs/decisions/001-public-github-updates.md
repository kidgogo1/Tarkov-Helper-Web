# ADR-001: 공개 GitHub 릴리스 기반 Windows 업데이트

## 상태

Accepted

## 날짜

2026-08-09

## 배경

Windows 바로 실행 배포본은 원본 Tarkov Item Helper처럼 앱 안에서 새 버전을 확인하고 갱신할 수
있어야 한다. 배포 대상은 소규모 인원이지만, 사용자별 계정·기간제 권한·라이선스 서버를 운영하지
않고 공개 저장소에서 동일한 패키지를 받는 방식이 요구된다.

업데이트는 앱 코드와 데이터, 로컬 실행기를 함께 바꾼다. 따라서 공개 URL의 버전 문자열만 신뢰해
현재 폴더에 덮어쓰면 공급망 변조, 잘못된 ZIP 경로, 중단된 복사 또는 기동 실패로 실행 불능 상태가
될 수 있다. 사용자의 PVP/PVE 진행도와 설정도 업데이트 후 그대로 유지되어야 한다.

## 결정

### 적용 범위와 사용자 흐름

- 자동 업데이트는 로컬 파일을 안전하게 교체할 수 있는 **Windows 바로 실행 배포본**에만 제공한다.
  일반 정적 웹 배포는 업데이트 API를 제공하지 않는다.
- 앱 시작 시 공개 GitHub의 최신 stable 릴리스를 확인하고, `설정 > 데이터 > 프로그램 업데이트`에서
  사용자가 다시 확인할 수 있게 한다.
- 사용자가 선택한 정확한 후보만 백그라운드에서 다운로드하고 검증한다. 실행 중인 폴더는 검증이
  끝날 때까지 건드리지 않는다.
- ADR-002에 따라 검증 완료 뒤 현재 서버가 응답과 정상 종료를 마치면 외부 broker가 전체 배포
  폴더를 교체하고 같은 주소로 자동 재시작한다. 새 서버의 버전·빌드 identity와 health check가
  실패하면 이전 폴더로 자동 롤백한다.
- 사용자는 GitHub 로그인, 토큰, 라이선스 키 또는 개인 권한이 필요 없다. GitHub 인증 정보와
  서명 개인키는 사용자 패키지에 포함하지 않는다.

### 릴리스 신뢰 경계

- 배포본의 `UPDATE_CONFIG.json`에 공개 저장소, 릴리스 API, updater protocol, RSA 공개키와
  `keyId`를 고정한다. 앱 화면이 임의 URL·해시·저장소를 업데이트 worker에 전달할 수 없게 한다.
- stable `vX.Y.Z` 릴리스만 허용하고 draft와 prerelease를 거부한다. 최신 버전은 현재 버전보다
  반드시 커야 한다.
- 공개 저장소에서 immutable releases를 필수로 사용한다. GitHub가 반환한 자산 ID, 이름, 크기와
  `sha256:` digest를 서명 manifest와 대조한다.
- `update-manifest-v1.json`의 원본 UTF-8 bytes를 RSA-SHA256으로 서명한다. 검증 공개키는 SPKI PEM,
  개인키는 RSA-3072 이상을 사용한다. `keyId`는 SPKI DER의 SHA-256이다.
- ZIP은 경로 이탈, 절대·드라이브·UNC 경로, NTFS ADS, 예약 이름, 끝의 점·공백, 대소문자/Unicode
  충돌, 링크·reparse point와 과도한 파일 수·압축 해제 크기를 거부한다. 서명·해시와 내부 파일
  트리를 모두 검증한 뒤 현재 폴더의 sibling 디렉터리에만 준비한다.
- 교체는 같은 볼륨에서 디렉터리 rename으로 수행한다. 이전 버전 하나를 backup으로 유지하고,
  기동 검증이 끝난 뒤에만 성공으로 기록한다.

### 상태 보존

브라우저 진행도와 설정은 `http://127.0.0.1:41753` origin의 localStorage에 있으므로 포트를 바꾸지
않는다. 실행기 상태와 준비된 업데이트는 배포 폴더 밖 `%LOCALAPPDATA%\TarkovHelperWeb` 아래에
두어 전체 폴더 교체와 자동 롤백 중에도 보존한다.

## 공개 저장소 운영 규칙

1. immutable releases를 활성화한다.
2. repository ruleset으로 `main`과 `v*` 태그를 보호한다. 강제 푸시와 삭제를 막고 `main`에는 CI를
   필수로 한다.
3. `github-release` Environment를 만들고 required reviewers를 설정한다. 서명·게시 job은 이
   Environment의 승인을 받은 뒤에만 secret을 읽을 수 있다.
4. `github-release` Environment secrets에 다음을 저장한다.
   - `UPDATE_SIGNING_PRIVATE_KEY`: RSA-3072 이상 PEM 개인키. 저장소나 artifact에 커밋하지 않는다.
   - `IMMUTABLE_RELEASES_READ_TOKEN`: 해당 저장소만 선택하고 `Administration: read`만
     허용한 fine-grained token. 서명 직전 immutable releases 설정 확인에만 사용한다.
5. Repository Actions variable `UPDATE_SIGNING_PUBLIC_KEY`에 같은 키 쌍의 SPKI PEM 공개키를
   저장한다. package job도 사용하므로 Environment variable이 아닌 Repository variable이어야 한다.
6. GitHub Actions가 workflow의 job별 `contents: write`, `id-token: write`, `attestations: write`와
   `artifact-metadata: write` 권한을 사용할 수 있게 저장소 정책을 설정한다.

키 생성과 `keyId` 확인 예시:

```powershell
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out update-signing-private.pem
openssl pkey -in update-signing-private.pem -pubout -out update-signing-public.pem
openssl pkey -pubin -in update-signing-public.pem -outform DER -out update-signing-public.der
openssl dgst -sha256 update-signing-public.der
```

마지막 출력의 64자리 해시를 소문자로 바꾸고 `sha256:`을 앞에 붙인다. `.gitignore`가 `*.pem`을
제외하더라도 개인키는 작업 저장소 밖의 안전한 비밀 저장소에서 생성·보관한다.

### 릴리스 절차

1. `package.json`의 `version`을 stable `X.Y.Z`로 올리고 보호된 `main`에 병합한다.
2. CI가 성공한 정확한 커밋에 `vX.Y.Z` 태그를 생성해 푸시한다. 버전과 태그가 다르면 실패한다.
3. release workflow가 tagged commit과 기본 브랜치 포함 관계를 검증하고 모든 headless 품질 검사를
   수행한다.
4. deterministic direct/static/source ZIP을 만들고 검증한 뒤 draft 릴리스에 올린다.
5. 보호된 publish job이 GitHub 자산 ID·크기·digest를 결합한 manifest를 개인키로 서명하고 모든
   최종 자산을 attest한다.
6. 검증된 draft만 stable/latest로 게시하고 immutable 상태를 확인한다. 중간 실패 시 draft를
   유지하며 기존 latest 릴리스는 바꾸지 않는다.

업데이터가 없는 배포본은 이 프로토콜을 실행할 코드와 공개키가 없으므로 첫 updater-capable direct
릴리스는 사용자에게 한 번 수동 배포한다. 이후에는 같은 공개키와 repository pin을 유지한 새
릴리스만 자동으로 설치할 수 있다.

## 대안 검토

### 비공개 저장소와 사용자별 GitHub 권한

소규모 배포 통제에는 도움이 되지만 사용자마다 토큰을 발급·회수·보호해야 하고 기간·영구 권한을
운영해야 한다. 공개 업데이트를 원한다는 요구와 맞지 않아 채택하지 않았다.

### 원본처럼 변경 가능한 버전 XML과 URL만 확인

단순하지만 패키지 크기·해시·서명·릴리스 identity를 고정하지 못하고 안전한 롤백도 제공하지 않는다.
원본의 사용자 경험만 유지하고 신뢰 모델은 채택하지 않았다.

### 실행 중 현재 폴더에 파일별 덮어쓰기

부분 복사나 잠긴 파일 때문에 서로 다른 버전이 섞일 수 있고 실패 후 원상 복구가 어렵다. 대신
완성된 sibling 디렉터리를 검증한 뒤 외부 broker가 전체 폴더를 교체한다.

### 정적 웹의 Service Worker 업데이트

웹 자산 cache 갱신에는 적합하지만 Windows 실행기, 오버레이 worker와 로컬 데이터 전체를 교체하거나
실패한 네이티브 실행을 롤백할 수 없다. 정적 웹 배포는 호스팅 플랫폼의 배포 방식에 맡긴다.

## 결과

- 사용자는 원본과 비슷한 업데이트 흐름을 사용하면서 별도 계정이나 권한을 관리하지 않는다.
- 릴리스 운영자는 공개키 pin, 개인키 보관, 보호 규칙과 immutable releases를 유지해야 한다.
- 개인키가 유출되면 기존 키로 서명된 악성 업데이트를 신뢰할 수 있으므로 즉시 릴리스를 중단해야
  한다. 공개키 pin을 바꾸는 키 교체는 기존 앱이 임의로 받아들일 수 없으며, 별도 bootstrap 릴리스를
  수동 배포하거나 기존 신뢰 키가 새 키 전환을 승인하는 후속 프로토콜이 필요하다.
- GitHub 또는 네트워크 장애 시 현재 설치본은 계속 동작한다. 업데이트 확인 실패가 앱 실행을 막지
  않는다.
