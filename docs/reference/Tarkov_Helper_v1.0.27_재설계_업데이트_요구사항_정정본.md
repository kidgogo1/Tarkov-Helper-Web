# Tarkov Helper v1.0.27 기준 재설계 업데이트 요구사항 - 정정본

> 정정: 실시간 판단 근거가 없는 v1.0.33 AI·퀘스트 추천 기능을 전체 구현 범위에서 제거했다.

## 문서 목적

이 문서는 다음 자료를 다시 검토한 뒤 작성한 **Codex 전달용 실제 구현 요구사항**이다.

- `Tarkov Helper 바로 실행 v1.0.27.zip`
- `Tarkov Helper 전체 요구사항 메모.txt`
- `kidgogo1/Tarkov-Helper-Web`의 v1.0.27 소스 커밋
- 현재 앱의 퀘스트·보상·위키 가이드 데이터
- EFT 로그를 분석하는 공개 소스 구현
- Document Picture-in-Picture와 현재 Windows 네이티브 오버레이 구조

목표는 아이디어를 늘어놓는 것이 아니라 다음을 명확히 하는 것이다.

- 현재 코드에서 실제로 구현 가능한가
- 어떤 데이터를 근거로 동작하는가
- PVP·PVE·시즌 PVP 진행도가 섞이지 않는가
- 로그로 알 수 없는 값을 추정하지 않는가
- 기존 미니맵·업데이트·진행도를 깨뜨리지 않는가
- Codex가 바로 작업할 수 있도록 파일·타입·상태·UI·테스트를 지정하는가

---

# 1. 최종 결정

## 1.1 버전별 결정

| 버전 | 기존 제안 | 최종 결정 | 이유 |
|---|---|---|---|
| v1.0.28 | 진행도 백업·복원 | **유지** | 이후 프로필 구조를 변경하기 전에 복구 수단이 반드시 필요함 |
| v1.0.29 | 실제 진행 중 퀘스트 추적 | **전면 재설계 후 유지** | 단순 `started` 저장이 아니라 로그 출처와 PVP·PVE·시즌 PVP 프로필을 먼저 분리해야 함 |
| v1.0.30 | 퀘스트 보상 패널 | **위키 검증 파이프라인을 포함해 유지** | 현재 보상 데이터는 많지만 화면 미표시·누락·링크 불일치가 남아 있음 |
| v1.0.31 | 이번 레이드 계획 목록 | **폐기하고 현재 지도 퀘스트 오버레이로 교체** | 수동 계획표보다 플레이 중 항상 볼 수 있는 퀘스트 창의 실효성이 높음 |
| v1.0.32 | 전체 구매 목록·예상 비용 | **폐기** | 현재 우선순위와 사용 목적에 맞지 않음 |
| v1.0.33 | 퀘스트 추천 | **폐기** | 로그와 스크린샷으로 목표별 실시간 진행 수치·레이드 상황을 확인할 수 없어 신뢰 가능한 추천이 불가능함 |

## 1.2 퀘스트 추천 기능 최종 삭제

기존 메모에는 `추천 퀘스트 섹션은 제거한다`고 명시되어 있다.
이번 정정본은 그 요구를 그대로 따른다.

구현하지 않는다.

- AI 추천 패널
- `간단한 퀘스트 찾기` 버튼
- 퀘스트 난이도 점수
- 현재 레이드 우선순위 자동 선정
- Codex 또는 AI가 생성하는 추천 메타데이터
- 사용자 로그·진행도를 외부 AI로 보내는 기능

`Visit`, `Stash`, `Mark`, `Kill` 같은 기존 `objectiveType`은 현재 지도 퀘스트 창에서 목록을 분류하거나 필터하는 데만 사용할 수 있다. 이를 근거로 `쉬움`, `추천`, `우선`, `지금 가능`, `최적`이라고 표시하지 않는다.

---

# 2. v1.0.27 실제 점검 결과

## 2.1 배포 데이터

v1.0.27 Direct ZIP의 실제 데이터팩을 검사한 결과는 다음과 같다.

| 항목 | 개수 |
|---|---:|
| 퀘스트 | 501개 |
| 아이템 | 4,014개 |
| 은신처 시설 | 26개 |
| 지도 | 12개 |
| 기본 지도 마커 | 454개 |
| 위키 가이드 인덱스 | 501개 |
| 위키 페이지 정상 확인 | 463개 |
| 위키 페이지 확인 실패 | 38개 |

위키 확인 실패 38개는 모두 현재 패키지에서 `PAGE_NOT_FOUND`로 기록돼 있다. 현재 스크립트는 앱에 저장된 위키 주소와 제목을 그대로 `action=parse`에 전달하므로, 위키 이름 변경·리다이렉트·문장부호·URL 인코딩 변경을 충분히 처리하지 못한다.

## 2.2 보상 데이터 보유 현황

| 필드 | 값이 있는 퀘스트 |
|---|---:|
| `rewardItems` | 347개 |
| `rewardXp` | 383개 |
| `rewardRoubles` | 260개 |
| `rewardReputation` | 343개 |
| `rewardSkills` | 28개 |
| `rewardUnlocks` | 157개 |
| `rewardText` | 441개 |
| 보상 필드가 하나라도 있음 | 441개 |
| 모든 보상 필드가 비어 있음 | 60개 |

따라서 보상 패널은 새 데이터를 처음부터 만드는 작업이 아니다. 기존 구조화 데이터와 원문 보상 문구를 화면에 표시하고, 위키 비교로 누락·불일치를 검출하는 작업이다.

## 2.3 목표 유형 현황

현재 데이터는 퀘스트 이름만 저장한 것이 아니라 목표별 `objectiveType`을 가지고 있다.

| 목표 유형 | 목표 수 |
|---|---:|
| `HandOver` | 328 |
| `Custom` | 306 |
| `Collect` | 221 |
| `Kill` | 190 |
| `Visit` | 177 |
| `Stash` | 106 |
| `Mark` | 92 |
| `Survive` | 90 |
| 기타 소수 유형 | 47 |

이 구조는 현재 지도 퀘스트 오버레이의 단순 분류·필터에 사용할 수 있다.

- `Visit` - 방문 유형 필터
- `Stash`·`Mark` - 설치·배치 유형 필터
- `Kill` - 처치 유형 필터
- `Custom`과 복합 목표 - 기타 유형으로 표시하고 자동 난이도 판정 금지

목표 유형은 데이터의 사실 표시를 위한 값일 뿐, 현재 가장 쉬운 퀘스트나 우선 처리할 퀘스트를 판정하는 근거로 사용하지 않는다.

## 2.4 현재 로그 기능의 실제 한계

현재 웹 코드의 `parseQuestLogContent()`는 메시지 유형을 다음처럼 읽는다.

- `10` - started
- `11` - failed
- `12` - completed

그러나 v1.0.27에서는 다음 문제가 있다.

- `started`는 미리보기에서 기본 선택되지 않는다.
- 적용 단계에서도 `started`를 무시한다.
- 최종 상태는 `done` 또는 `failed`만 저장한다.
- 로그 이벤트를 PVP·PVE·시즌 PVP 프로필과 연결하지 않는다.
- Direct 실행기의 로컬 트래커는 현재 스크린샷 폴더 감시 중심이다.
- 퀘스트 로그는 사용자가 파일·폴더를 직접 선택해 가져오는 방식이다.

## 2.5 현재 프로필 구조의 문제

현재 `ProfileType`은 `pvp | pve` 두 값만 가진다. 이 타입은 다음 두 용도로 동시에 사용된다.

- 진행도 프로필 구분
- 시세 API의 PVP·PVE 모드 구분

시즌 PVP를 단순히 `ProfileType`에 추가하면 시세 코드와 진행도 코드가 섞인다. 따라서 v1.0.29에서는 타입을 분리해야 한다.

```ts
export type MarketMode = "pvp" | "pve";

export type EftProgressMode =
  | "regular"
  | "pve"
  | "pvp-season";
```

매핑은 다음처럼 고정한다.

```ts
export function marketModeForProgressMode(mode: EftProgressMode): MarketMode {
  return mode === "pve" ? "pve" : "pvp";
}
```

---

# 3. 전체 개발 순서

| 순서 | 버전 | 작업 | 선행 조건 |
|---:|---|---|---|
| 1 | v1.0.28 | 상태 마이그레이션·백업·복원 | 없음 |
| 2 | v1.0.29 | 프로필 구분 로그 동기화·진행 중 상태 | v1.0.28 |
| 3 | v1.0.30 | 보상 패널·위키 보상 비교 | v1.0.28, v1.0.29와 병렬 가능 |
| 4 | v1.0.31 | 현재 지도 퀘스트 오버레이 | v1.0.29 |

v1.0.32의 기존 구매비 기능과 v1.0.33의 AI·퀘스트 추천 기능은 개발 목록에서 삭제한다. 해당 버전 번호는 다른 버그 수정 릴리스에 사용할 수 있으며, 이 문서에서는 기능 버전으로 예약하지 않는다.

---

# 4. v1.0.28 - 진행도 백업·복원과 상태 마이그레이션

## 4.1 목표

v1.0.29에서 프로필 구조를 크게 바꾸기 전에 현재 PVP·PVE 진행도를 사용자가 직접 백업하고 복구할 수 있어야 한다.

## 4.2 수정·추가 파일

- `src/types/state.ts`
- `src/app/store.tsx`
- `src/app/state-migrations.ts` 신규
- `src/app/state-backup.ts` 신규
- `src/features/settings/StateBackupPanel.tsx` 신규
- `src/features/settings/SettingsDialog.tsx`
- `src/styles/settings.css`
- `tests/app/state-migrations.test.ts`
- `tests/app/state-backup.test.ts`
- `tests/features/state-backup-panel.test.tsx`

## 4.3 상태 마이그레이션

현재처럼 저장된 `version`이 다르면 바로 초기화하지 않는다.

```ts
export function migratePersistedState(value: unknown): PersistedAppState;
```

구조는 순차 마이그레이션으로 만든다.

```ts
const migrations: Record<number, (value: unknown) => unknown> = {
  1: migrateV1ToV2,
  2: migrateV2ToV3,
};
```

v1.0.28에서는 다음을 구현한다.

- 기존 version 1 상태를 version 2로 변환한다.
- version 1의 PVP·PVE 진행도를 모두 보존한다.
- 누락 필드는 기본값으로 채운다.
- 잘못된 하위 필드는 해당 필드만 정리한다.
- 최상위 JSON 자체를 복구할 수 없을 때만 기본 상태를 사용한다.
- 향후 v1.0.29의 version 3 변환을 추가할 수 있게 한다.

## 4.4 백업 형식

```ts
interface StateBackupEnvelope {
  schemaVersion: 1;
  product: "tarkov-helper-web";
  appVersion: string;
  stateVersion: number;
  exportedAt: string;
  state: unknown;
}
```

파일명:

```text
tarkov-helper-backup-YYYY-MM-DD-HHmmss.json
```

백업에는 다음을 포함한다.

- PVP 진행도
- PVE 진행도
- 퀘스트 상태
- 목표 체크 상태
- 은신처 레벨
- FIR·일반 아이템 수량
- 커스텀 지도 마커
- 지도·미니맵·화면 설정

## 4.5 복원 절차

1. `.json` 파일만 허용한다.
2. 최대 크기는 5MB로 제한한다.
3. JSON을 파싱한다.
4. 제품명과 백업 스키마를 검증한다.
5. `migratePersistedState()`를 적용한다.
6. 현재 상태에는 아직 적용하지 않고 미리보기를 만든다.
7. 사용자가 `백업으로 전체 교체`를 눌렀을 때만 적용한다.
8. 적용 직전에 현재 상태를 `tarkov-helper-web:last-known-good-state`에 한 번 저장한다.
9. 새 상태 저장이 성공한 뒤 화면을 다시 렌더링한다.
10. 저장 실패 시 기존 상태를 유지한다.

## 4.6 복원 미리보기

- 백업 생성 시각
- 백업 앱 버전
- 상태 버전
- PVP 레벨과 완료·실패 퀘스트 수
- PVE 레벨과 완료·실패 퀘스트 수
- 인벤토리에 기록된 아이템 종류 수
- 커스텀 마커 수

버튼:

- 취소
- 백업으로 전체 교체
- 마지막 정상 상태 복구

## 4.7 보안·개인정보

v1.0.29부터 백업 파일에 로그에서 파생된 프로필 식별 해시가 포함될 수 있다. 설정 화면에 다음 문구를 표시한다.

> 백업 파일에는 게임 진행도와 프로필 식별용 해시가 포함될 수 있습니다. 공개 게시판에 그대로 올리지 마세요.

## 4.8 테스트

- version 1 상태를 version 2로 변환
- 누락 필드 복구
- 잘못된 숫자·문자열·배열 정리
- 잘못된 JSON 거부
- 다른 제품 백업 거부
- 5MB 초과 거부
- PVP·PVE 진행도 보존
- 원자적 상태 교체
- 저장 실패 시 기존 상태 보존
- 마지막 정상 상태 복구

## 4.9 완료 조건

```bash
pnpm typecheck
pnpm lint
pnpm test --run
pnpm build
pnpm test:portable
```

모두 통과해야 한다.

---

# 5. v1.0.29 - PVP·PVE·시즌 PVP 구분 로그 동기화

## 5.1 먼저 확정할 로그 지원 범위

공개 소스 구현과 현재 앱 파서를 기준으로 검증 가능한 범위는 다음과 같다.

| 정보 | 로그로 확인 | 적용 방식 |
|---|---|---|
| 퀘스트 수락·시작 | 가능 | 메시지 유형 10을 `inProgress`로 저장 |
| 퀘스트 실패 | 가능 | 메시지 유형 11을 `failed`로 저장 |
| 퀘스트 완료 | 가능 | 메시지 유형 12를 `done`으로 저장 |
| 프로필 모드 | 가능 | `Session mode: Regular/PVE/PvpSeason` 파싱 |
| 프로필 ID | 가능 | 프로필 선택 로그 파싱 |
| 계정 ID | 가능 | 프로필 선택 로그 파싱 후 해시만 사용 |
| 게임 버전 | 가능 | 로그 세트의 breakpoint 식별에 사용 |
| 현재 지도·레이드 문맥 | 일부 가능 | application 로그의 지도 문자열 파싱 |
| 퀘스트 목표별 중간 진행도 | 검증된 일반 이벤트 없음 | 자동 추정 금지, 수동 체크 유지 |
| 처치·수집 카운터의 실시간 값 | 검증된 일반 이벤트 없음 | 자동 추정 금지, 수동 카운터만 제공 |
| 은신처 건설 단계 | 로그 이벤트 없음 | 수동 입력 유지 |
| PMC 레벨 | 로그에 안정적으로 제공되지 않음 | 수동 입력 유지 |
| 레이드 중 실시간 퀘스트 완료 | 보장 불가 | 로그 이벤트 수신 시점에만 반영 |
| 스크린샷 파일명 | 위치·방향 확인 가능 | 퀘스트 상태 판단에는 사용하지 않음 |

### 반드시 지킬 원칙

- 로그에서 읽지 못한 값을 완료로 추정하지 않는다.
- 스크린샷 위치가 목표 근처라는 이유로 목표를 완료 처리하지 않는다.
- 레이드 종료를 성공·실패로 추정하지 않는다.
- 시즌 PVP를 일반 PVP 진행도에 합치지 않는다.
- 모드나 프로필 ID가 불명확한 이벤트를 임의 프로필에 적용하지 않는다.

## 5.2 읽을 로그 파일

| 파일 | 용도 |
|---|---|
| `application.log`, `application_000.log` | 모드, 프로필 ID, 계정 ID, 게임 버전, 지도·레이드 문맥 |
| `notifications.log`, `notifications_000.log` | 퀘스트 started·failed·finished 이벤트 |
| `output.log`, `output_000.log` | 게임 종료 등 수명 확인에만 사용 가능, 퀘스트 상태에는 사용하지 않음 |

## 5.3 타입 분리

`ProfileType` 하나를 계속 공유하지 않는다.

```ts
export type MarketMode = "pvp" | "pve";

export type EftProgressMode =
  | "regular"
  | "pve"
  | "pvp-season";

export type SavedQuestStatus =
  | "inProgress"
  | "done"
  | "failed";
```

UI 표기:

| 내부값 | UI |
|---|---|
| `regular` | 일반 PVP |
| `pve` | PVE |
| `pvp-season` | 시즌 PVP |

## 5.4 진행 프로필 구조

```ts
interface ProgressProfileMeta {
  id: string;
  mode: EftProgressMode;
  identityHash?: string;
  accountHash?: string;
  seasonKey?: string;
  label: string;
  source: "legacy" | "log" | "manual";
  firstSeenAt: string;
  lastSeenAt: string;
  lastGameVersion?: string;
}

interface ProgressProfileRecord {
  meta: ProgressProfileMeta;
  progress: ProfileState;
  logSync: {
    lastImportedAt?: string;
    lastLiveEventAt?: string;
    appliedEventIds: string[];
  };
}

interface PersistedAppStateV3 {
  version: 3;
  activeProgressProfileId: string;
  progressProfiles: Record<string, ProgressProfileRecord>;
  marketMode: MarketMode;
  settings: SharedSettings;
}
```

## 5.5 프로필 식별 규칙

### 일반 PVP와 PVE

```text
identityHash = SHA-256(mode + NUL + profileId)
```

### 시즌 PVP

시즌 PVP 로그에서 안정적인 시즌 ID가 실제로 확인되기 전에는 자동으로 시즌 번호를 만들어내지 않는다.

```text
identityHash = SHA-256("pvp-season" + NUL + profileId + NUL + seasonKey)
```

`seasonKey` 결정 순서:

1. 로그에 안정적인 시즌 식별자가 실제 존재하는 경우 해당 값
2. 없으면 과거 로그 가져오기에서 사용자가 선택한 시작 breakpoint 날짜
3. 사용자가 직접 만든 시즌 슬롯 키

금지:

- `accountId`만으로 프로필을 합치기
- `regular`과 `pvp-season`을 같은 PVP로 합치기
- 게임 버전 하나만 보고 새 시즌을 자동 생성하기
- 모드만 같다는 이유로 기존 진행도에 자동 병합하기

## 5.6 기존 상태 마이그레이션

version 2에서 version 3으로 다음처럼 변환한다.

- 기존 `profiles.pvp` -> `legacy-regular` 슬롯
- 기존 `profiles.pve` -> `legacy-pve` 슬롯
- 시즌 PVP 슬롯은 빈 상태로 생성하지 않는다.
- 사용자가 처음 로그를 가져올 때 감지된 프로필과 legacy 슬롯을 병합할지 미리보기에서 선택한다.
- 양쪽에 진행도가 있으면 자동 병합하지 않는다.

## 5.7 로그 파서를 지도 도메인에서 분리

현재 `src/domain/map.ts` 안의 퀘스트 로그 파서를 별도 모듈로 이동한다.

신규 파일:

- `src/types/log-sync.ts`
- `src/domain/eft-log.ts`
- `src/domain/log-event-replay.ts`
- `src/services/local-log-tracker.ts`

예시 타입:

```ts
interface EftProfileContextEvent {
  kind: "profile-context";
  mode: EftProgressMode;
  profileIdentityHash: string;
  accountHash?: string;
  gameVersion?: string;
  occurredAt: string;
}

interface EftQuestStatusEvent {
  kind: "quest-status";
  mode: EftProgressMode;
  profileIdentityHash: string;
  questId: string;
  status: "started" | "failed" | "completed";
  traderId?: string;
  occurredAt: string;
  eventId: string;
}
```

브라우저에 다음 원문은 보내지 않는다.

- 전체 로그 줄
- 전체 파일 경로
- 원본 profileId
- 원본 accountId

## 5.8 Direct 실행기 자동 감시

`portable/launcher.ps1`에 로그 감시자를 추가한다.

### 요구사항

- BSG Launcher 설치 위치를 확인한다.
- Steam 설치 위치를 확인한다.
- 사용자가 지정한 로그 폴더를 지원한다.
- `application`과 `notifications` 로그를 각각 감시한다.
- 파일 생성, 내용 추가, rotation, truncation을 처리한다.
- `FileSystemWatcher` 이벤트만 믿지 않고 5초 주기의 reconciliation을 함께 사용한다.
- 파일별 byte cursor와 마지막 fingerprint를 상태 디렉터리에 저장한다.
- 동일 이벤트 중복을 해시로 제거한다.
- 로그 폴더가 처음에는 없어도 다시 탐색한다.
- 권한 오류는 서버를 종료하지 않고 `ERROR` 상태로 표시한다.
- 감시 상태는 `WATCHING`, `NOT_FOUND`, `ERROR`, `MANUAL_ONLY`로 구분한다.

### API

```text
GET /api/v1/local-log/status
GET /api/v1/local-log/events?after=<cursor>
POST /api/v1/local-log/rescan
```

`events` 응답은 최대 100개로 제한한다.

## 5.9 이벤트 재생 규칙

현재처럼 퀘스트별 마지막 이벤트 하나만 남기지 않는다. 시간 순서대로 상태 기계를 재생한다.

예:

```text
started -> failed -> started -> completed
```

최종 결과는 `done`이어야 하지만, 중간 `started`가 재수락을 의미하므로 단순 collapse로는 처리하면 안 된다.

규칙:

- `started` -> `inProgress`
- `failed` -> `failed`
- 실패 뒤 `started` -> `inProgress`
- `completed` -> `done`
- 완료 뒤 더 오래된 이벤트는 무시
- 동일 `eventId`는 한 번만 적용
- 알 수 없는 퀘스트 ID는 적용하지 않고 미매핑 목록에 표시

## 5.10 선행 퀘스트 처리

로그에 `started`가 있으면 해당 퀘스트가 실제 게임에서 수락됐다는 뜻이므로 선행 상태를 보정할 수 있다. 그러나 다음처럼 제한한다.

- 단일 AND 선행 조건은 미리보기에서 완료 후보로 표시한다.
- OR 선행 그룹은 어느 경로를 통과했는지 로그만으로 알 수 없으면 사용자가 선택한다.
- 실패가 필요한 특수 선행 조건은 자동 변경하지 않는다.
- 대안 퀘스트 실패는 완료 이벤트가 실제로 적용될 때만 처리한다.

## 5.11 로그 가져오기 미리보기

미리보기는 먼저 프로필별로 그룹화한다.

```text
일반 PVP / 프로필 A / 게임 버전 X / 이벤트 142개
PVE / 프로필 B / 게임 버전 X / 이벤트 97개
시즌 PVP / 시즌 슬롯 2026-08 / 이벤트 35개
```

각 그룹에 표시:

- 모드
- 프로필 식별 해시의 앞 8자리
- 게임 버전
- 최초·최종 로그 시각
- started·failed·completed 개수
- 매핑되지 않은 퀘스트 개수
- 적용 대상 진행 프로필

모드·프로필 문맥이 없는 이벤트는 `대상 불명`으로 분리하고 사용자가 직접 대상을 선택하기 전에는 적용하지 않는다.

## 5.12 과거 로그 가져오기

과거 로그의 시작점을 다음 조합으로 표시한다.

- 프로필 식별 해시
- 모드
- 게임 버전
- 로그 폴더 시작 시각
- 로그 폴더 종료 시각

시즌 PVP에서는 사용자가 시즌 시작 breakpoint를 선택한 뒤 새 시즌 슬롯을 만들게 한다.

## 5.13 수동 진행 중 입력 수정

현재 `진행 중인 퀘스트 입력`은 선행 퀘스트만 완료 처리한다. 다음처럼 변경한다.

- 선택한 퀘스트 자체를 `inProgress`로 저장한다.
- 선행 완료 후보를 별도 미리보기한다.
- 로그로 감지된 `inProgress`와 수동 입력을 같은 상태로 사용한다.
- 수동 입력 출처는 `manual`, 로그 입력 출처는 `log`로 기록한다.

## 5.14 프로필 UI

헤더에 다음을 표시한다.

- 일반 PVP
- PVE
- 시즌 PVP

각 모드에 여러 진행 슬롯이 있으면 두 번째 선택기를 표시한다.

설정 > 프로필 관리:

- 슬롯 이름 변경
- 현재 슬롯 전환
- 빈 슬롯 생성
- legacy 슬롯과 로그 프로필 병합
- 시즌 슬롯 생성
- 슬롯 삭제 전 JSON 백업 저장

## 5.15 로그 근거 보고서

설정 > 로그 동기화 화면에 다음 설명을 고정 표시한다.

- 실제로 읽은 로그 파일 종류
- 프로필 모드를 판단한 문자열 유형
- started·failed·completed 메시지 유형
- 목표별 중간 진행도는 자동으로 알 수 없다는 제한
- 은신처와 레벨은 자동 갱신하지 않는다는 제한
- 마지막 정상 이벤트 시각
- 마지막 오류

## 5.16 테스트

### 파서

- Regular 모드
- PVE 모드
- PvpSeason 모드
- 세 가지 프로필 선택 로그 변형
- started·failed·completed
- 잘못된 JSON
- 로그 rotation
- 로그 truncation
- 같은 이벤트 중복
- 여러 프로필이 한 폴더에 섞인 경우

### 상태

- legacy PVP·PVE 마이그레이션
- 일반 PVP와 시즌 PVP 분리
- 서로 다른 profileId 분리
- 시즌 슬롯 분리
- 이벤트 시간 순 재생
- OR 선행 그룹 미리보기
- 미매핑 퀘스트 보존

### 포터블

- BSG 경로 감지
- Steam 경로 감지
- 사용자 지정 경로
- 권한 오류
- 폴더가 나중에 생성되는 경우
- 서버 재시작 후 cursor 복구
- 브라우저에 원본 경로·ID를 노출하지 않는지 확인

## 5.17 완료 조건

- 일반 PVP·PVE·시즌 PVP 진행도가 절대 섞이지 않는다.
- started 이벤트가 실제 `inProgress`로 저장된다.
- 목표별 진행도를 로그에서 추정하지 않는다.
- 기존 PVP·PVE 진행도가 마이그레이션 후 유지된다.
- 수동 파일 가져오기와 자동 감시가 같은 파서를 사용한다.
- 모든 테스트·typecheck·lint·build·portable 테스트가 통과한다.

---

# 6. v1.0.30 - 퀘스트 보상 패널과 위키 검증

## 6.1 목표

현재 앱 데이터의 보상을 퀘스트 상세 화면에 표시하고, 위키의 현재 개별 퀘스트 페이지와 비교해 누락·차이·리다이렉트 문제를 보고한다.

## 6.2 위키 소스별 역할

| 소스 | 역할 | 단독 사용 여부 |
|---|---|---|
| `Quests` 페이지 | 현재 상인별 퀘스트 목록과 표의 목표·보상 확인 | 전체 커버리지 기준으로 사용 |
| `Category:Quests` | 이름 변경·역사 콘텐츠·목록 누락 페이지 탐색 | 카테고리 수를 앱 퀘스트 수로 직접 비교하지 않음 |
| 개별 퀘스트 페이지 | 정확한 보상, 조건부 금액, 아이템, 스킬, 해금 확인 | 보상 비교의 주 소스 |

`Category:Quests`에는 과거·이벤트·변동형 콘텐츠가 섞일 수 있으므로 페이지 총수를 앱의 현재 고정 퀘스트 개수와 바로 비교하지 않는다.

## 6.3 현재 스크립트의 한계

`refresh-quest-wiki-guides.mjs`는 현재 다음만 추출한다.

- 위키 제목
- revision ID
- 위치
- 목표
- 가이드 요약
- 이미지 URL

보상은 추출하지 않는다. 또한 저장된 정확한 페이지 제목을 바로 parse하므로 리다이렉트 해결이 약하다.

## 6.4 신규 스크립트

- `scripts/resolve-quest-wiki-pages.mjs`
- `scripts/refresh-quest-wiki-rewards.mjs`
- `scripts/compare-quest-rewards.mjs`
- `scripts/validate-quest-wiki-coverage.mjs`

package.json:

```json
{
  "scripts": {
    "data:refresh-quest-wiki-pages": "node scripts/resolve-quest-wiki-pages.mjs",
    "data:refresh-quest-wiki-rewards": "node scripts/refresh-quest-wiki-rewards.mjs",
    "data:compare-quest-rewards": "node scripts/compare-quest-rewards.mjs",
    "data:validate-quest-wiki": "node scripts/validate-quest-wiki-coverage.mjs"
  }
}
```

## 6.5 페이지 이름·리다이렉트 해결

1. 앱의 `wikiPageLink`, `nameEn`, `nameAliases`를 후보로 만든다.
2. MediaWiki query API에서 redirects와 normalized titles를 활성화한다.
3. 실제 page ID, canonical title, redirect source를 저장한다.
4. 개별 페이지가 없으면 `Quests` 표와 `Category:Quests`에서 이름을 다시 찾는다.
5. 끝까지 찾지 못한 경우에만 `PAGE_NOT_FOUND`로 기록한다.

현재 38개의 `PAGE_NOT_FOUND`를 회귀 목록으로 만들어, 새 resolver 적용 전후 개수를 보고한다.

기존 요구사항 메모에 명시된 다음 항목은 별도 회귀 fixture로 유지한다.

- `A Big Loss`
- `Small Things, Big Help`

이 이름이 현재 위키에서 변경·리다이렉트·삭제됐는지는 스크립트가 결과로 보고해야 하며, 코드에 임의 새 이름을 넣지 않는다.

## 6.6 보상 데이터 구조

```ts
interface QuestRewardCurrency {
  currency: "RUB" | "USD" | "EUR" | "GP" | "OTHER";
  amount: number;
  condition?: string;
}

interface QuestWikiRewardSnapshot {
  wikiTitle: string;
  wikiPageId: number;
  wikiRevisionId: number;
  wikiPageLink: string;
  fetchedAt: string;
  xp?: number;
  currencies: QuestRewardCurrency[];
  reputation: Array<{ trader: string; amount: number }>;
  items: Array<{
    itemName: string;
    itemId?: string;
    count: number;
  }>;
  skills: Array<{ skill: string; amountText: string }>;
  unlocks: string[];
  conditionalRewards: string[];
  variable: boolean;
  parseWarnings: string[];
}
```

## 6.7 비교 결과 구조

```ts
type RewardComparisonStatus =
  | "MATCH"
  | "DIFFERENT"
  | "APP_ONLY"
  | "WIKI_ONLY"
  | "VARIABLE"
  | "UNVERIFIED";

interface QuestRewardComparison {
  questId: string;
  status: RewardComparisonStatus;
  appFingerprint: string;
  wikiFingerprint?: string;
  differences: Array<{
    field: string;
    appValue: unknown;
    wikiValue: unknown;
  }>;
}
```

## 6.8 파싱 규칙

- 기본 경험치
- 기본 통화 보상
- 조건부 통화 보상
- 상인 평판 증감
- 아이템 수량
- 스킬 보상
- 구매·제작·지역·기타 해금 문구

주의:

- 조건부 금액을 기본 금액으로 덮어쓰지 않는다.
- 변동형 일일·주간 과제 보상은 `variable: true`로 분류한다.
- 이름만으로 아이템 ID를 억지 매핑하지 않는다.
- 아이템 ID가 확인되지 않으면 위키 원문 이름만 저장한다.
- 위키의 긴 대화·가이드 본문은 패키지에 복제하지 않는다.
- 구조화된 보상 사실과 출처·revision만 저장한다.
- 위키 비교 결과가 다르더라도 앱 데이터를 자동 덮어쓰지 않는다.

## 6.9 보상 패널 UI

신규 파일:

- `src/features/quests/QuestRewardsPanel.tsx`
- `src/features/quests/QuestRewardComparisonPanel.tsx`
- `src/types/wiki-verification.ts`
- `src/styles/quests.css`

배치:

- 목표와 위키 위치 안내 아래
- 필수 아이템 위 또는 바로 아래

표시 항목:

- 경험치
- 통화
- 상인 평판
- 보상 아이템
- 스킬
- 해금
- 기타 보상 문구
- 조건부 보상

상태 배지:

- 위키와 일치
- 위키와 차이 있음
- 위키에서만 확인
- 앱에만 있음
- 변동형 보상
- 위키 확인 실패

아이템 클릭 시 기존 아이템 화면을 연다. 매핑되지 않은 위키 아이템은 버튼으로 만들지 않는다.

## 6.10 데이터 화면 보고서

설정 > 데이터에 다음 통계를 표시한다.

- 전체 퀘스트 수
- 보상 데이터 보유 수
- 위키 정상 확인 수
- 페이지 리다이렉트 수
- 페이지 확인 실패 수
- 보상 일치 수
- 차이 수
- 변동형 보상 수
- 마지막 위키 확인 시각
- 위키 revision 기준

## 6.11 테스트

- redirect 해결
- canonical title 저장
- 문장부호가 있는 제목
- 페이지 없음
- 경험치
- 여러 통화
- 조건부 금액
- 양수·음수 평판
- 아이템 수량
- 스킬 보상
- 해금 문구
- 변동형 보상
- 미매핑 아이템
- 앱과 위키 차이 보고
- 비교 결과가 앱 데이터를 자동 수정하지 않는지 확인
- 보상이 없는 퀘스트에서 패널 숨김

## 6.12 완료 조건

- 기존 38개 `PAGE_NOT_FOUND`가 새 resolver 결과와 함께 보고된다.
- 보상 패널이 실제 구조화 데이터로 표시된다.
- 위키 비교 상태와 확인 시각이 보인다.
- 위키 불일치를 자동으로 덮어쓰지 않는다.
- 데이터 갱신 실패 시 이전 정상 파일을 보존한다.
- 모든 테스트와 빌드가 통과한다.

---

# 7. v1.0.31 - 현재 지도 퀘스트 오버레이

## 7.1 기존 레이드 계획 기능 폐기

다음 기능은 만들지 않는다.

- 사용자가 레이드별 계획 목록을 따로 작성하는 기능
- 퀘스트를 계획에 추가·제거하는 별도 상태
- 자동 최단 동선
- 목표 사이 경로선

대신 현재 선택·감지된 지도에서 수행할 수 있는 퀘스트와 목표를 별도 창에 계속 표시한다.

## 7.2 중요한 기술 제약

Document Picture-in-Picture는 같은 브라우저 탭에서 동시에 한 개만 열 수 있다. 현재 미니맵이 Document PiP를 사용하므로 퀘스트 창도 `requestWindow()`로 열면 기존 미니맵이 닫힌다.

따라서 다음 방식은 금지한다.

```ts
// 금지: 두 번째 Document PiP 요청
await window.documentPictureInPicture.requestWindow(...);
```

## 7.3 최종 구현 방식

### Direct Windows 버전

- 미니맵은 기존 Document PiP + 네이티브 오버레이 방식을 유지한다.
- 퀘스트 창은 `window.open()`으로 별도 same-origin popup을 만든다.
- Direct 실행기의 네이티브 오버레이 프로토콜을 다중 창으로 확장한다.
- 퀘스트 popup을 별도의 topmost·잠금·클릭 통과 가능한 창으로 연결한다.

### 일반 웹 버전

- 일반 popup으로 연다.
- 브라우저가 popup을 막으면 페이지 내부 도킹 패널로 연다.
- 일반 웹에서는 항상 위·무테·클릭 통과를 보장하지 않는다.
- 이 제한을 UI에 표시한다.

## 7.4 네이티브 오버레이 프로토콜 v2

현재 런처는 다음 구조라서 동시에 한 창만 연결할 수 있다.

- 단일 `$nativeOverlayRecord`
- 단일 window title
- `/api/v1/native-overlay/minimap`
- 두 번째 연결 시 `OVERLAY_ALREADY_ATTACHED`

이를 다음처럼 일반화한다.

```ts
export type OverlayKind = "minimap" | "quest-list";
```

PowerShell:

```powershell
$nativeOverlayRecords = @{}
$nativeOverlayClaims = @{}
```

각 record는 `overlayKind`를 가진다.

```text
minimap    -> Tarkov Helper Mini Map
quest-list -> Tarkov Helper Quest List
```

### API

기존 v1 미니맵 API는 호환을 위해 유지한다.

신규 API:

```text
GET    /api/v2/native-overlay/session
POST   /api/v2/native-overlay/claims
POST   /api/v2/native-overlay/windows
PATCH  /api/v2/native-overlay/windows
DELETE /api/v2/native-overlay/windows
GET    /api/v2/native-overlay/events?kind=minimap&after=<cursor>
```

claim 요청:

```json
{
  "overlayKind": "quest-list"
}
```

attach 요청:

```json
{
  "overlayKind": "quest-list",
  "claimId": "...",
  "windowTitle": "Tarkov Helper Quest List"
}
```

## 7.5 창 식별 보안

- claim 생성 전 존재하던 HWND를 제외한다.
- 같은 브라우저 프로세스 계열인지 확인한다.
- exact window title을 확인한다.
- overlay kind와 title 조합을 확인한다.
- 후보가 0개면 `WINDOW_NOT_FOUND`로 실패한다.
- 후보가 2개 이상이면 `AMBIGUOUS_WINDOW`로 실패한다.
- 모호할 때 임의 창을 조작하지 않는다.
- 미니맵과 퀘스트 창의 원래 style·region·rect를 각각 보존한다.
- 한 창을 닫을 때 다른 창의 style을 복구하거나 해제하지 않는다.

## 7.6 웹 컴포넌트

신규 파일:

- `src/features/overlay/QuestOverlay.tsx`
- `src/features/overlay/QuestOverlaySurface.tsx`
- `src/features/overlay/useQuestOverlayWindow.ts`
- `src/features/overlay/overlay-channel.ts`
- `src/services/native-overlay-v2.ts`
- `src/styles/quest-overlay.css`

라우팅:

```text
#/overlay/quests
```

열기 순서:

1. 사용자가 `퀘스트 창 열기` 버튼을 누른다.
2. Direct 세션이 있으면 `quest-list` claim을 생성한다.
3. `window.open()`으로 popup을 연다.
4. popup title과 DOM 준비를 확인한다.
5. claim을 완료한다.
6. 네이티브 연결에 성공하면 topmost·잠금·클릭 통과 UI를 활성화한다.
7. 실패하면 일반 popup을 그대로 유지하고 오류를 표시한다.

## 7.7 퀘스트 창 표시 내용

상단:

- 현재 진행 프로필
- 일반 PVP·PVE·시즌 PVP 모드
- 현재 지도
- 지도 판단 출처: 로그 / 스크린샷 / 수동 선택
- 마지막 지도 갱신 시각

필터:

- 진행 중만
- 진행 가능 포함
- 미완료 목표만
- 완료 목표 포함
- 목표 유형
- 한국어 / English

퀘스트 카드:

- 퀘스트 이름
- 상인
- 상태
- 목표 수와 완료 수
- 목표 유형 배지
- 목표 설명
- 현재 지도 여부
- 좌표 존재 여부
- 지도 마커 이동 버튼
- 목표 수동 완료 체크
- 카운터가 필요한 목표의 수동 `- / +`

## 7.8 표시 범위

기본값은 현재 진행 프로필에서 `inProgress`인 퀘스트 중 현재 지도에 해당하는 목표다.

사용자가 `진행 가능 포함`을 켜면 다음도 포함한다.

- 현재 조건상 available인 퀘스트
- 현재 지도에 최소 하나의 목표가 있는 퀘스트

다음은 기본적으로 제외한다.

- 완료
- 실패
- 다른 진영 전용
- 현재 에디션에서 이용 불가
- 다른 지도 목표만 있는 퀘스트

## 7.9 지도와의 동기화

- 퀘스트 창에서 목표의 지도 버튼을 누르면 메인 지도와 미니맵의 동일 마커를 선택한다.
- 메인 지도에서 선택한 목표를 퀘스트 창에서도 강조한다.
- 현재 지도가 로그로 바뀌면 퀘스트 창 목록도 즉시 바뀐다.
- 프로필을 바꾸면 목록도 해당 프로필로 전환한다.
- 창을 닫아도 메인 앱·서버·미니맵은 유지한다.
- 미니맵을 닫아도 퀘스트 창은 유지한다.

동기화 방식:

- 같은 창 계열에서는 React portal 또는 shared store 사용
- popup과 메인 창 사이에는 `BroadcastChannel("tarkov-helper-overlay")` 사용
- 메시지에 state 전체를 넣지 않고 이벤트와 revision만 전달
- 수신 후 localStorage의 최신 revision을 다시 읽음

## 7.10 독립 설정

퀘스트 창 설정:

- 너비 280-800px
- 높이 300-1,000px
- 글자 크기
- 투명도
- 잠금
- 클릭 통과
- 항상 위 상태
- 완료 목표 표시 여부
- 진행 가능 포함 여부
- 한국어·영어
- 위치 초기화

미니맵 설정과 별도로 저장한다.

## 7.11 금지 사항

- 두 번째 Document PiP 요청
- 경로·안전 동선 자동 추정
- 스크린샷 위치만으로 목표 자동 완료
- 퀘스트 창을 닫을 때 서버 종료
- 미니맵과 퀘스트 창을 하나의 overlay record로 공유
- popup 후보가 모호한데 강제 style 변경

## 7.12 테스트

### 웹

- 퀘스트 창 열기·닫기
- popup 차단 시 도킹 fallback
- 현재 지도 변경
- 프로필 변경
- 목표 선택 동기화
- 목표 체크 동기화
- BroadcastChannel 중복 이벤트 방지
- 언어·필터 저장

### 포터블·네이티브

- 미니맵과 퀘스트 창 동시 연결
- 각각 독립 lock·click-through·opacity
- 퀘스트 창만 닫기
- 미니맵만 닫기
- 런처 종료 시 두 창 모두 복원
- 고DPI 125·150·200%
- 보조 모니터 음수 좌표
- 창 후보 0개·2개 이상 fail-closed
- 백신·파일 잠금과 무관하게 기존 업데이트 기능 유지

## 7.13 작업 분리

v1.0.31은 한 커밋으로 만들지 않는다.

1. PR A - 네이티브 오버레이 프로토콜 v2와 다중 record
2. PR B - 퀘스트 popup·도킹 UI
3. PR C - 지도·프로필·목표 동기화
4. PR D - Direct 통합·DPI·복구 테스트

---

# 8. 구현 제외 - 퀘스트 AI·추천 기능

## 8.1 제외 이유

현재 확인된 EFT 로그로 안정적으로 확인할 수 있는 정보는 다음 범위다.

- 퀘스트 시작·실패·완료
- 일반 PVP·시즌 PVP·PVE
- ProfileId와 AccountId 문맥
- 일부 지도·레이드 문맥

확인할 수 없는 정보는 다음과 같다.

- 퀘스트 목표별 현재 카운터
- 남은 처치 수
- 설치·방문 목표의 실시간 완료 상태
- 생존·탈출 조건 충족 여부
- 적 위치와 교전 위험도
- 사용자의 현재 장비와 수행 가능성

스크린샷 파일명은 위치와 방향을 제공하지만 퀘스트 완료 여부나 난이도를 증명하지 않는다. 따라서 정적 퀘스트 데이터에 AI 분류를 추가해도 현재 레이드에서 무엇이 쉽고 우선인지 신뢰성 있게 판단할 수 없다.

## 8.2 구현하지 않을 항목

- 추천 퀘스트 섹션
- `간단한 퀘스트 찾기` 버튼
- AI 추천 패널
- 퀘스트 추천 점수와 순위
- AI·Codex 추천 메타데이터 파일
- 퀘스트 난이도 자동 판정
- 현재 레이드 자동 우선순위
- 로그·프로필·진행도의 외부 AI 전송

## 8.3 허용되는 항목

현재 지도 퀘스트 오버레이에서 원본 `objectiveType`을 그대로 이용한 단순 필터는 허용한다.

- 방문 - `Visit`
- 설치·배치 - `Stash`, `Mark`
- 처치 - `Kill`
- 기타 - 나머지 유형

이 기능은 목록 필터이며 추천이 아니다. UI에 `추천`, `쉬움`, `우선`, `지금 가능`, `최적`, `AI 판단`이라는 표현을 사용하지 않는다.

---

# 9. 상시 데이터 무결성 검사

이 작업은 별도 기능 버전으로 만들지 않고 각 데이터 갱신 PR에 포함한다.

검사 항목:

- 퀘스트 ID 중복
- 퀘스트 BSG ID 중복
- 이름·alias·리다이렉트 충돌
- 필수 아이템 참조 누락
- 보상 아이템 참조 누락
- 위키 canonical page 중복 매핑
- 위키 페이지 미확인
- 목표 지도명과 map config 불일치
- 목표 좌표 누락
- README 개수와 실제 메타 불일치

오류와 경고를 구분한다.

```text
[ERROR] 데이터 참조가 깨져 앱 기능이 잘못됨
[WARN] 위키 비교·번역·좌표 검토가 필요함
```

오류가 있으면 릴리스 빌드를 실패시킨다. 경고는 보고서 파일로 남긴다.

---

# 10. 만들지 않을 기능

| 기능 | 결정 | 이유 |
|---|---|---|
| 이번 레이드 계획 목록 | 제외 | 현재 지도 퀘스트 오버레이로 대체 |
| 전체 구매 목록·예상 비용 | 제외 | 현재 우선순위 아님 |
| 두 번째 Document PiP | 제외 | 브라우저 제약상 기존 미니맵이 닫힘 |
| 로그로 목표별 진행도 추정 | 제외 | 검증된 이벤트 없음 |
| 로그로 은신처·레벨 자동 입력 | 제외 | 로그 근거 없음 |
| 모드만 보고 진행도 병합 | 제외 | PVP·PVE·시즌 진행도 혼합 위험 |
| 위키 데이터 자동 덮어쓰기 | 제외 | 위키 오류·변경 시 정상 데이터 손상 위험 |
| 퀘스트 추천·난이도·우선순위 판단 | 제외 | 목표별 실시간 진행과 레이드 상황을 확인할 근거가 없음 |
| 퀘스트 ID별 추천 하드코딩 | 제외 | 데이터 변경 때 유지 불가하며 근거 없는 추천이 됨 |
| 사용자 앱의 실시간 LLM 호출 | 제외 | 판단 입력 부족, 키·비용·개인정보·오프라인 문제 |
| 자동 최단 경로·안전 경로 | 제외 | 이동 그래프와 실시간 위험 데이터 없음 |

---

# 11. Codex 공통 작업 규칙

각 버전을 Codex에 전달할 때 다음 공통 조건을 붙인다.

```md
## 공통 구현 규칙

1. 현재 v1.0.27의 자동 업데이트 보안·서명·롤백 코드를 불필요하게 수정하지 않는다.
2. 상태 구조를 바꾸기 전에 마이그레이션 테스트를 먼저 작성한다.
3. 기존 사용자의 PVP·PVE 진행도를 초기화하지 않는다.
4. 새 로그 기능은 PVP·PVE·시즌 PVP를 모드와 프로필 식별자로 분리한다.
5. 로그에서 확인되지 않은 진행도를 추정하지 않는다.
6. 위키 비교 결과로 앱 데이터를 자동 덮어쓰지 않는다.
7. 퀘스트 추천·난이도 점수·실시간 AI 판단 기능을 구현하지 않는다.
8. objectiveType은 목록 분류·필터에만 사용한다.
9. 외부에 로그·프로필·보유 아이템을 전송하지 않는다.
10. 새 기능은 Direct Windows와 일반 웹 fallback을 각각 테스트한다.
11. 한글 경로, 공백 경로, 다른 드라이브, Windows PowerShell 5.1을 유지한다.
12. 기존 미니맵·지도·시세·업데이트 회귀 테스트를 삭제하거나 약화하지 않는다.
13. 타입 오류를 `any`나 무검증 type assertion으로 숨기지 않는다.
14. 오류 발생 시 기존 정상 데이터와 진행도를 보존한다.
15. 완료 후 변경 파일, 상태 마이그레이션, 테스트 결과를 요약한다.
```

필수 검증:

```bash
pnpm typecheck
pnpm lint
pnpm test --run
pnpm build
pnpm test:release
pnpm test:portable
pnpm test:e2e:direct
```

Windows 전용 테스트는 실제 Windows CI에서 통과해야 완료로 판단한다.

---

# 12. 최종 권장 작업 단위

## PR 1 - v1.0.28 마이그레이션 기반

- migration engine
- JSON export/import
- last-known-good recovery
- 관련 테스트

## PR 2 - v1.0.29 프로필 모델

- MarketMode와 EftProgressMode 분리
- version 3 migration
- 일반 PVP·PVE·시즌 PVP 슬롯
- inProgress 상태

## PR 3 - v1.0.29 로그 파서

- application·notifications 파서
- profile context
- event replay
- import preview

## PR 4 - v1.0.29 Direct 로그 감시

- 폴더 감지
- rotation·truncation
- cursor·dedupe
- local log API

## PR 5 - v1.0.30 위키 resolver

- canonical title·redirect
- 38개 실패 회귀 보고
- Quests·Category·개별 페이지 비교

## PR 6 - v1.0.30 보상 비교·UI

- reward parser
- comparison report
- QuestRewardsPanel

## PR 7 - v1.0.31 overlay protocol v2

- multi-overlay records
- overlay kind
- 독립 복구·잠금·클릭 통과

## PR 8 - v1.0.31 퀘스트 창

- popup·dock fallback
- 현재 지도 목록
- 지도·프로필 동기화

---

# 13. 검증에 사용한 외부 자료

## 프로젝트·로그

- 현재 프로젝트: https://github.com/kidgogo1/Tarkov-Helper-Web
- EFT 로그 공개 구현: https://github.com/the-hideout/TarkovMonitor
- 프로필 모드·로그 파서 참고: `TarkovMonitor/GameWatcher.cs`
- 퀘스트 상태 메시지 구조 참고: `TarkovMonitor/LogMessageTypes.cs`

## 위키

- 퀘스트 목록: https://escapefromtarkov.fandom.com/wiki/Quests
- 퀘스트 카테고리: https://escapefromtarkov.fandom.com/wiki/Category:Quests
- 보상 검증은 각 개별 퀘스트 페이지의 `Rewards` 섹션을 기준으로 한다.

## 오버레이 제약

- WICG Document Picture-in-Picture specification:
  https://wicg.github.io/document-picture-in-picture/
- MDN Document Picture-in-Picture API:
  https://developer.mozilla.org/en-US/docs/Web/API/Document_Picture-in-Picture_API

---

# 14. 최종 판단

이번 변경에서 가장 중요한 것은 기능 수가 아니다.

1. v1.0.28에서 진행도를 복구할 수 있게 만든다.
2. v1.0.29에서 일반 PVP·PVE·시즌 PVP를 로그 기준으로 완전히 분리한다.
3. 로그가 제공하는 started·failed·completed만 자동 적용한다.
4. 목표별 진행도·은신처·레벨은 로그로 추정하지 않는다.
5. v1.0.30에서 보상을 표시하되 위키를 통해 누락과 차이를 보고한다.
6. v1.0.31은 계획 목록이 아니라 현재 지도 퀘스트 오버레이로 만든다.
7. 두 번째 PiP가 아니라 Direct 네이티브 다중 오버레이로 구현한다.
8. 퀘스트 추천·난이도·우선순위 자동 판단 기능은 구현하지 않는다.
9. objectiveType은 현재 지도 퀘스트 창의 사실 기반 분류·필터에만 사용한다.

이 순서대로 구현해야 기존 진행도와 미니맵을 보존하면서 사용 중 실제 도움이 되는 기능을 추가할 수 있다.
