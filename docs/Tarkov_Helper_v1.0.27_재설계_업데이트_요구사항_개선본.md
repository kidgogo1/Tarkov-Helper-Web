# Tarkov Helper 재설계·업데이트 요구사항 개선본

> 검토 기준: v1.0.27 코드와 사용자가 제공한 `Tarkov_Helper_v1.0.27_재설계_업데이트_요구사항_정정본.md`
> 작성일: 2026-08-11
> 이 문서는 기존 정정본의 세부 기능 목록을 버리지 않고, 구현 순서·안전 경계·검증 기준을 보강한 실행용 요구사항이다.

## 0. 기준선과 규범 문서

| 항목 | 상태 |
|---|---|
| 기준 앱 | v1.0.27, 기준 commit `a71e0ad` |
| P0-A 상세 ID 라우팅·메뉴/상세 Back·Forward | 구현·검증 완료 — 관련 47/47, 전체 354/354, typecheck·ESLint·build 통과. 이 개선본과 구현을 같은 commit으로 보존하며 공개 릴리스는 별도 |
| P0-B 검색어·필터·스크롤 history snapshot | 계획 |
| M0 상태 안전·백업 | 계획 |
| M1 프로필·로그 | 계획 |
| M2 위키·보상 | 일부 기존 파이프라인 존재, 재설계는 계획 |
| M3 다중 퀘스트 overlay | 기존 단일 미니맵만 현재, 다중 overlay는 계획 |

다음 두 파일을 함께 규범 요구사항으로 사용한다.

1. 이 개선본: 우선순위, 안전 경계, 보완·변경 계약
2. [`reference/Tarkov_Helper_v1.0.27_재설계_업데이트_요구사항_정정본.md`](./reference/Tarkov_Helper_v1.0.27_재설계_업데이트_요구사항_정정본.md): 기존 세부 schema, UI, API, 테스트 목록

두 문서가 충돌하면 이 개선본이 우선한다. 원문의 고정 버전 번호는 마일스톤으로 해석하며, 원문에만 있는 세부 요구는 삭제된 것이 아니다. 아래 표는 대표 매핑이고, 표에 생략된 원문 절도 모두 해당 마일스톤의 규범 요구로 상속한다.

| 원문 절 | 개선본 대표 작업 단위 |
|---|---|
| 4.4~4.8 백업 envelope·미리보기·복구 UI | M0-B |
| 5.1~5.17 로그 schema·parser·watcher·프로필 UI | M1-A~M1-C |
| 6.2~6.12 resolver·reward schema·비교 패널 | M2-A~M2-B |
| 7.4~7.13 overlay v2 API·popup UI·필터·동기화 | M3-A~M3-C |
| 11 공통 구현 규칙·13 외부 자료 | 전 마일스톤 공통 |

## 1. 문서 사용 규칙

각 요구사항에는 다음 상태 중 하나를 붙인다.

- **현재**: v1.0.27에 이미 존재하며 회귀를 막아야 하는 동작
- **P0**: 다른 재설계보다 먼저 고쳐야 하는 사용자 차단 결함
- **계획**: 아직 구현하지 않은 기능
- **검증 필요**: 외부 자료나 실제 로그 표본으로 사실을 확인하기 전에는 구현하면 안 되는 가정
- **제외**: 의도적으로 만들지 않는 기능

기존 문서의 `v1.0.28`~`v1.0.31` 고정 번호는 아래의 `M0`~`M3` 마일스톤으로 읽는다. 실제 패치 버전은 긴급 수정과 자동 업데이트 릴리스를 고려해 릴리스 직전에 `package.json`, Git 태그, 서명 manifest와 함께 결정한다.

## 2. 목표와 우선순위

1. P0 탐색 오류를 먼저 고쳐 아이템·퀘스트·은신처 사이의 정확한 이동과 뒤로가기를 보장한다.
2. M0에서 진행도 백업·복원·마이그레이션·롤백 안전성을 만든다.
3. M1에서 PVP·PVE·시즌 진행도를 로그의 실제 프로필 문맥에 따라 분리한다.
4. M2에서 위키를 증거 자료로 사용해 퀘스트 이름·위치·보상을 비교하되 앱 데이터를 자동 덮어쓰지 않는다.
5. M3에서 현재 지도 퀘스트 창을 미니맵과 독립된 창으로 제공한다.
6. 실시간 정보가 없는 AI 추천, 난이도 추정, 안전 경로 추정은 만들지 않는다.

---

# 3. P0 - 상세 이동·URL·뒤로가기

## 3.1 확인된 기존 결함

- 탭 전환이 `history.replaceState()`로 현재 이력을 덮어써 브라우저 뒤로가기가 직전 메뉴를 복원하지 못했다.
- 주소에는 탭만 있고 퀘스트·아이템·은신처 상세 ID가 없어서 새로고침과 앞으로가기로 상세를 복원할 수 없었다.
- 은신처 출처는 `stationId`만 전달하고 실제 요구 레벨을 버렸다.
- `HideoutPage`는 처음 마운트될 때 전달받은 시설 대신 항상 첫 시설로 초기화될 수 있었다.
- 기존 통합 테스트는 대상 퀘스트가 첫 항목이고 은신처 시설이 한 개뿐이라 위 결함을 통과시켰다.

## 3.2 라우트 계약

표시 이름이 아니라 안정적인 내부 ID를 사용한다.

```text
#/quests?quest=<questId>
#/hideout?station=<stationId>&level=<positiveInteger>
#/items?item=<itemId>
#/collector
#/prices
#/map
```

```ts
type AppRoute =
  | { tab: "quests"; questId?: string }
  | { tab: "hideout"; stationId?: string; stationLevel?: number }
  | { tab: "items"; itemId?: string }
  | { tab: "collector" }
  | { tab: "prices" }
  | { tab: "map" };

type AppNavigationIntent = "focus" | "selection";

interface AppRouteHistoryStateV1 {
  schemaVersion: 1;
  navigationIntent: AppNavigationIntent;
  route: string; // 이 state가 결속된 canonical hash
}
```

규칙:

- 사용자가 탭·출처·관련 항목을 눌러 다른 화면으로 이동할 때 `pushState()`를 사용한다.
- 같은 화면의 목록 행을 키보드나 목록 클릭으로 단순 선택할 때는 `navigationIntent: "selection"`으로 보고 현재 이력 항목을 `replaceState()`로 갱신한다. 이 경로는 검색 입력의 초점을 결과 행으로 강제 이동하지 않는다.
- 관련 퀘스트·필수 아이템처럼 사용자가 링크를 따라 다른 상세 엔티티로 이동할 때는 `navigationIntent: "focus"`로 기록하고, 같은 탭이어도 `pushState()`를 사용한다. 이 경로만 일회성 scroll/focus와 필터 밖 임시 노출을 수행한다.
- history state의 `route`가 현재 canonical hash와 정확히 일치할 때만 기록된 intent를 신뢰한다. 일치하지 않거나 state가 없고 URL에 target이 있으면 복사·새로고침된 deep link로 보고 `focus`를 사용한다.
- 같은 목적지를 반복 클릭하면 중복 이력을 만들지 않는다.
- `popstate`와 외부 `hashchange`에서 주소를 다시 파싱해 화면과 상세를 복원한다.
- 주소를 복사하거나 새로고침해도 같은 상세를 연다.
- 전체 hash는 최대 2,048자, 각 ID는 percent-decode 뒤 최대 256 Unicode code point로 제한한다. 은신처 레벨은 1~99의 10진 정수만 허용한다.
- 잘못된 percent encoding, 범위를 벗어난 레벨·ID, 현재 데이터에 없는 target은 해당 탭 자체는 유지하되 target 강제 선택을 적용하지 않는다. 해당 탭의 기존 선택이 있으면 유지하고, 없으면 그 탭의 정상 기본 선택 규칙을 사용한다.
- 잘못된 target과 알 수 없는 query key는 `replaceState()`로 canonical URL에서 제거하며 새 history 항목을 만들지 않는다. P0-A에서는 조용히 안전 복구하고, P0-C에서 같은 복구 결과에 사용자 안내만 추가한다.
- 모달 열기·닫기는 이번 URL 이력 범위에서 제외한다.

## 3.3 상세 이동 계약

### 아이템 → 퀘스트

- `questId`로 정확한 행과 상세 패널을 연다.
- 검색·상인·지도·상태·진영 필터가 대상을 숨기더라도 출처로 지정된 퀘스트는 임시 대상 행으로 표시한다.
- 완료·실패·현재 진영과 다른 퀘스트도 완료 이력 출처에서 열 수 있어야 한다.
- 대상 목록 행으로 스크롤하고 키보드 포커스를 이동한다.

### 아이템 → 은신처

- 콜백은 `(stationId, level)`을 함께 전달한다.
- 정확한 시설을 선택하고 해당 레벨 요구사항만 먼저 표시한다.
- 이미 완료한 레벨도 완료 이력 출처에서 임시 상세로 열 수 있어야 한다.
- 대상 시설과 레벨 영역으로 스크롤하고 포커스를 이동한다.

### 뒤로·앞으로

- 아이템 상세에서 퀘스트 또는 은신처로 이동한 뒤 브라우저 뒤로가기를 누르면 원래 아이템 상세로 돌아간다.
- 앞으로가기를 누르면 동일한 목적지 상세를 다시 연다.
- 다른 메뉴에서 아이템을 열고 돌아오는 반대 방향도 동일한 중앙 탐색 함수를 사용한다.
- 뒤로가기는 서버 종료나 미니맵 종료를 실행하지 않는다.
- `popstate`로 상세 선택을 복원할 때는 복원된 목록 행으로 키보드 초점도 이동해 `aria-current`, 상세 제목, 실제 focus가 서로 다르지 않게 한다. 일반 검색·필터 fallback은 입력 초점을 빼앗지 않는다.
- 검색 결과가 잠시 0건이 되어도 직전 상세 ID를 지우지 않는다. 검색을 해제하면 같은 상세가 복원되며 URL도 다른 첫 항목으로 바뀌지 않는다.

## 3.4 P0 완료 조건

- 대상이 데이터 배열의 두 번째 이후 항목이어도 정확히 열린다.
- 은신처가 두 개 이상이고 요구 레벨이 2 이상인 fixture에서 정확한 시설·레벨이 열린다.
- `#/items?item=...` 직접 진입과 새로고침이 같은 상세를 연다.
- 출처 이동 후 주소에 정확한 ID가 남는다.
- `history.back()`이 직전 아이템 상세를 복원한다.
- `history.forward()`가 이동했던 상세를 다시 복원한다.
- 기존 퀘스트·아이템·은신처·지도 기능 테스트가 약화되지 않는다.
- Direct와 정적 웹 모두 같은 해시 라우트를 사용한다.

추가 필수 회귀:

```text
items -> exact quest -> Back -> original item
items -> exact hideout level -> Back -> original item
quest -> required item -> Back -> original quest
quest -> related quest(push visit) -> Back -> original quest
deep link -> reload
Back -> Forward
invalid/missing target
completed or faction-mismatched quest source
completed hideout level source
```

## 3.5 P0-B - 화면 문맥 history snapshot 계약

P0-A는 직전 메뉴와 상세 ID만 복원한다. P0-B는 목록형 화면의 검색어·필터·스크롤을 같은 history entry에 저장해, 연결을 따라갔다가 돌아왔을 때 사용자가 보던 문맥까지 복원한다. 진행도와 설정은 snapshot에 복제하지 않는다.

```ts
interface AppHistoryStateV1 {
  schemaVersion: 1;
  appEntryId: string;
  appDepth: number;
  route: AppRoute;
  view?: AppHistoryViewV1;
}

type AppHistoryViewV1 =
  | {
      tab: "quests";
      query: string;
      requiredItemQuery: string;
      rewardQuery: string;
      traderFilter: string;
      mapFilter: string;
      statusFilter: string;
      kappaOnly: boolean;
      itemOnly: boolean;
      language: "ko" | "en";
      listScrollTop: number;
    }
  | {
      tab: "items";
      searchText: string;
      source: string;
      category: string;
      sortBy: string;
      firOnly: boolean;
      hideFulfilled: boolean;
      listScrollTop: number;
    }
  | {
      tab: "hideout";
      searchText: string;
      showAllRemaining: boolean;
      listScrollTop: number;
    };
```

규칙:

- 각 페이지는 자기 union variant만 encode/decode하며, 허용된 enum 값이 아닌 필터는 기본값으로 복구한다.
- 검색 문자열은 필드당 256자, 직렬화한 전체 `history.state`는 16 KiB로 제한한다. 초과하면 scroll과 기본 필터만 남기고 route는 반드시 보존한다.
- `appEntryId`는 한 entry를 중복 적용하지 않기 위한 UUID이고 `appDepth`는 앱 안에서 만든 entry에만 증가시킨다. 브라우저 전체 history 길이를 추정하는 값으로 사용하지 않는다.
- snapshot 복원 순서는 `route -> 상세 데이터 -> 검색·필터 -> 목록 렌더 -> scrollTop`이다. scroll은 목록 layout이 끝난 다음 frame에 한 번 적용하며 사용자의 이후 스크롤을 덮어쓰지 않는다.
- 없거나 알 수 없는 `schemaVersion`, 다른 탭의 view, 손상된 값은 view만 버리고 P0-A route 복원으로 안전하게 강등한다.
- `replaceState()`로 transient selection 또는 입력 문맥을 갱신할 때 기존 `appEntryId`와 `appDepth`를 유지한다. 연결 이동의 `pushState()`는 새 ID와 증가한 depth를 만든다.

완료 조건:

- 검색·필터·스크롤이 있는 아이템에서 퀘스트 또는 은신처로 이동한 뒤 Back하면 같은 아이템, 검색어, 필터, 목록 위치를 복원한다.
- 다시 Forward하면 목적지 상세와 그 entry의 화면 문맥을 복원한다.
- 손상되거나 16 KiB를 넘는 snapshot, 구 schema snapshot에서도 앱이 열리고 정확한 route가 보존된다.

---

# 4. M0 - 상태 안전 기반과 백업·복원

## 4.1 핵심 원칙

- 마이그레이션 전에 실패하는 회귀 테스트를 작성한다.
- 중간 버전을 건너뛰어도 `v1 -> v2 -> v3` 순서로 적용한다.
- 각 마이그레이션은 여러 번 실행해도 같은 결과인 멱등성을 가져야 한다.
- 알 수 없는 미래 상태 버전을 기본값으로 덮어쓰거나 저장하지 않는다.
- 알 수 없는 퀘스트·아이템 ID는 삭제하지 않고 orphan 항목으로 보존한다. 별도 복사본을 만들지 않고 `ProfileStateV3`의 원래 `questProgress`, `objectiveProgress`, `inventory`, `hideoutLevels` map에 그대로 둔다. 현재 데이터 팩에 없는 key 목록만 파생해 데이터 설정 화면과 복원 미리보기에 표시한다.
- orphan map entry는 export/import와 last-known-good에 포함한다. 이후 데이터 팩에 같은 canonical ID가 돌아오면 이동·복사 없이 자동으로 정상 항목에 다시 연결하며, 사용자가 명시적으로 삭제하기 전에는 migration이나 데이터 팩 갱신이 제거하지 않는다.
- 화면 탭·검색어·스크롤 같은 일시 UI 상태는 진행도 백업에서 제외한다.

## 4.2 롤백과 호환되는 저장 키

구버전이 신버전 상태를 읽고 초기화한 뒤 덮어쓰는 일을 막기 위해 버전별 키와 활성 포인터를 사용한다.

```text
tarkov-helper-web:state             # v1.0.27이 실제로 읽는 legacy mirror
tarkov-helper-web:state:v1
tarkov-helper-web:state:v2
tarkov-helper-web:state:v3
tarkov-helper-web:state:active
tarkov-helper-web:last-known-good-state
tarkov-helper-web:state:legacy-mirror-base
tarkov-helper-web:state:legacy-mirror-meta
```

롤백 지원 기간에는 `tarkov-helper-web:state` legacy mirror를 유지한다. 신버전 전용 필드는 제거한 v1 호환 형태만 mirror에 기록한다. v1이 표현할 수 없는 `inProgress`, 로그 출처, revision 등은 v3에 계속 보존하고 mirror 변환 보고서에 `lossyFields`로 기록한다.

`legacy-mirror-meta`에는 적어도 `sourceStateVersion`, `sourceRevision`, `mirrorHashAlgorithm: "sha256"`, `mirrorHash`, `generatedAt`, `compatibilityStatus`를 둔다. `legacy-mirror-base`는 마지막으로 검증한 v1 호환 snapshot이며, 구버전 실행 뒤 재업그레이드할 때 현재 legacy key와 비교하는 3-way merge의 base다.

```ts
type RollbackCompatibility = "HEALTHY" | "DEGRADED" | "MERGE_REQUIRED";
```

- mirror와 meta를 다시 읽어 hash·schema를 검증하기 전에는 새 durable active revision을 확정하지 않는다. 쓰기 실패 시 기존 정상 v3 active state는 유지하고 이번 변경은 저장 실패로 표시한다.
- mirror가 없거나 meta hash와 다르면 `DEGRADED`다. Direct updater는 이 상태에서 자동으로 v1.0.27 실행 파일로 rollback하지 않으며, 사용자에게 재동기화 또는 백업 export를 요구한다.
- 구버전 실행 뒤 legacy key가 base와 달라졌으면 `MERGE_REQUIRED`다. `base`, 최신 v3, 구버전 legacy의 3-way diff를 보여 주고 v1이 표현 가능한 필드만 새 v3 revision으로 가져온다.
- 같은 key를 v3와 legacy가 모두 다르게 바꾼 충돌은 자동 선택하지 않는다. 사용자 선택 뒤 새 revision과 새 mirror/base/meta를 아래의 staged write·재검증·pointer commit 절차로 다시 만든다. 여러 localStorage key가 실제 원자 transaction이라고 가정하지 않는다.
- `HEALTHY`는 active v3에서 다시 생성한 v1 호환 값, legacy key, base, meta hash가 모두 일치할 때만 표시한다.

저장 순서:

1. 현재 정상 상태를 last-known-good에 기록한다.
2. 새 버전 임시 키에 기록한다.
3. 다시 읽어 schema·크기·내용을 검증한다.
4. 새 revision에서 v1 mirror를 만들고 legacy key·base·`DEGRADED` meta를 쓴 뒤 각각 다시 읽어 hash·schema를 검증한다.
5. 4단계까지 성공한 경우에만 활성 포인터를 새 revision으로 바꾼다.
6. active v3·legacy mirror·base·meta가 모두 새 revision과 일치하는지 다시 검증한 뒤 meta를 `HEALTHY`로 바꾸고 updater rollback을 허용한다.
7. 활성 포인터 변경 전 어느 단계든 실패하면 기존 포인터를 유지하고, 다음 시작에서 기존 active를 기준으로 부분 작성된 mirror 묶음을 복구한다. 포인터 변경 뒤 최종 검증이 실패하면 active v3는 유지하되 `DEGRADED`로 자동 rollback을 차단한다.

필수 테스트:

- localStorage quota·차단·손상 JSON
- v1에서 최신 상태로 직접 이동
- 신버전 실행 후 실행 파일 롤백
- legacy mirror 쓰기 실패 뒤 자동 rollback 차단
- v1.0.27에서 진행도를 바꾼 뒤 재업그레이드하는 3-way merge와 동일 key 충돌
- 백업 가져오기 중 새로고침·강제 종료
- 한글 이름·한글 경로·공백 경로
- 다른 PC에서 가져온 백업과 알 수 없는 데이터 ID

---

# 5. M1 - 프로필·로그 동기화

## 5.1 모드 분리

시세 모드와 게임 진행 모드는 다른 축이다.

```ts
type MarketMode = "pvp" | "pve";
type EftProgressMode = "regular" | "pve" | "pvp-season";
type PersistedQuestStatusV3 = "inProgress" | "done" | "failed";
```

단순히 PVP/PVE 문자열만 같다고 진행도를 합치지 않는다. 시즌과 프로필 식별 근거가 불완전하면 자동 병합 대신 사용자 확인을 요청한다.

## 5.2 프로필 식별정보 보호

단순 SHA-256은 반복 추적이 가능한 가명화이므로 기본값으로 사용하지 않는다.

```text
profileKey = HMAC-SHA256(perInstallSecret, mode + NUL + profileId + NUL + seasonKey)
accountKey = HMAC-SHA256(perInstallSecret, accountId)
```

정확한 profile 입력은 UTF-8 `mode + NUL + profileId + NUL + (seasonKey ?? "")`이며 출력은 lowercase hex로 고정한다. 설치 비밀은 암호학적으로 안전한 32바이트 난수다. DPAPI 보호가 실패하면 평문으로 강등하지 않고 자동 프로필 연결을 `MANUAL_ONLY`로 제한한다. 다른 PC 복원이나 비밀 rotation 뒤에는 기존 HMAC alias를 자동 병합하지 않고 사용자 확인으로 다시 연결한다.

- 설치별 비밀은 Direct 상태 폴더에 만들고 Windows DPAPI로 보호해야 한다. 생성·암호화·복호화 중 하나라도 실패하면 fail-closed로 `MANUAL_ONLY`를 사용한다.
- 원본 ID는 파싱 직후 버린다.
- UI에는 짧은 앞부분만 표시한다.
- 백업에는 원본 ID와 설치 비밀을 넣지 않는다.
- 다른 PC 복원 프로필은 자동 합치지 않는다.

## 5.3 퀘스트별 출처 메타데이터

프로필 전체에 출처 하나를 기록하지 말고 각 퀘스트 전이에 출처를 남긴다.

```ts
interface SavedQuestProgressEntry {
  status: PersistedQuestStatusV3;
  source: "legacy" | "manual" | "log-import" | "log-live";
  updatedAt: string;
  eventId?: string;
}

interface ProfileStateV3 extends Omit<ProfileState, "questProgress"> {
  questProgress: Record<string, SavedQuestProgressEntry>;
}

interface ProgressProfileRecordV3 {
  meta: ProgressProfileMeta;
  progress: ProfileStateV3;
  logSync: {
    lastImportedAt?: string;
    lastLiveEventAt?: string;
    appliedEventIds: string[];
  };
}
```

기존 `Record<string, "done" | "failed">`를 새 schema와 동시에 사용하지 않는다. v3의 유일한 저장형은 `Record<string, SavedQuestProgressEntry>`이고 화면의 계산된 `active`, `locked`, `levelLocked`, `unavailable`은 저장하지 않는다.

마이그레이션과 충돌 규칙:

- 기존 `done`·`failed`는 같은 status, `source: "legacy"`, `updatedAt: "1970-01-01T00:00:00.000Z"`로 결정적으로 변환한다. 없는 값은 만들지 않으며 여러 번 migration해도 같은 결과다.
- 수동 변경은 실제 저장 시각을 UTC RFC 3339로 기록한다. 로그 변경은 원문 event의 `occurredAt`과 `eventId`를 사용한다.
- 동일 `eventId`는 한 번만 적용한다. 같은 status는 revision만 불필요하게 늘리지 않는다.
- `legacy` 상태는 더 새로운 유효 이벤트나 수동 변경으로 갱신할 수 있다. `log-import`가 기존 `manual` 또는 `log-live`와 충돌하거나, 어떤 로그든 더 새로운 `manual`과 충돌하면 자동 덮어쓰지 않고 미리보기에 보낸다.
- `log-live`끼리처럼 자동 적용 가능한 이벤트는 `occurredAt`이 더 새로운 것만 적용한다. 시각이 같고 결과가 다르면 자동 tie-break하지 않고 충돌로 보낸다.
- 사용자가 충돌 미리보기에서 선택한 값은 새 `manual` entry가 되며, 원래 eventId는 별도 audit 기록에 남긴다.
- v1 legacy mirror로 내릴 때 `done`·`failed`만 기록하고 `inProgress`는 생략한다. 원본 v3 entry는 지우지 않으며 이 생략을 mirror meta의 `lossyFields`에 남긴다.

## 5.4 Direct와 일반 웹의 경계

- Direct 자동 감시는 백엔드가 로그를 읽고 정규화된 이벤트만 브라우저에 반환한다.
- 일반 웹 수동 가져오기는 브라우저에서 읽을 수 있으나 원문을 네트워크·localStorage·오류 로그에 남기지 않는다.
- PowerShell과 TypeScript가 같은 함수를 쓴다고 약속하지 않는다. 동일 wire schema와 동일 fixture를 통과하도록 요구한다.
- 일반 웹에서 임의 폴더 자동 감시를 지원한다고 표시하지 않는다.

## 5.5 이벤트·커서 완료 조건

- UTF-8 BOM, 잘린 문자, 부분 줄, CRLF/LF를 처리한다.
- rotation·truncate·동일 시각 tie-break 규칙을 문서화한다.
- 이벤트 ID 입력값과 시간대 해석을 고정한다.
- cursor 응답에 `nextCursor`, `hasMore`, reset/expired 상태를 둔다.
- 100개 초과 이벤트를 페이지 반복으로 누락 없이 읽는다.
- dedupe 저장소에 개수·기간 상한을 둔다.
- 권한 오류는 감시기만 오류 상태로 만들고 정적 앱 서버는 유지한다.
- 시작 이벤트만으로 선행 퀘스트를 자동 완료하지 않는다.
- 오래된 로그가 최신 수동 상태를 덮어쓰지 않도록 충돌 미리보기를 제공한다.

로컬 API는 loopback Host, exact Origin, 세션 capability, no-CORS, body/query 상한을 기존 업데이트·오버레이 API와 같은 수준으로 검증한다.

---

# 6. M2 - 위키 resolver·위치·보상 비교

## 6.1 데이터 흐름

위키 데이터는 앱 기준 데이터를 즉시 바꾸는 입력이 아니라 검토 증거다.

```text
앱 canonical 데이터
        +
위키 evidence snapshot
        -> comparison report
        -> reviewed patch proposal
        -> 사람이 검토한 패치만 적용
```

현재 `refresh-wiki-rewards.mjs`와 새 resolver 역할이 중복되지 않도록 하나의 canonical page resolver를 가이드·위치·보상이 공유한다. 갱신 스크립트가 `Object.assign()`으로 기준 퀘스트를 바로 덮어쓰는 구조는 제거하거나 명시적 검토 단계 뒤로 옮긴다.

## 6.2 증거 레코드

```ts
interface WikiEvidence {
  sourceSite: "escapefromtarkov.fandom.com";
  snapshotGenerationId: string;
  pageId: number;
  canonicalTitle: string;
  redirectFrom: string[];
  revisionId: number;
  revisionTimestamp: string;
  pageUrl: string;
  fetchedAt: string;
  contentHashAlgorithm: "sha256";
  contentHash: string;
  licenseName: string;
  licenseUrl: string;
  attributionUrl: string;
}
```

- `fetchedAt`만으로 최신 검증이라고 표시하지 않는다.
- resolver에서 canonical page와 `revisionId`를 먼저 확정한 다음, 그 revision 자체를 ID로 지정해 본문·구조화 데이터를 가져온다. 응답 revision이 요청한 값과 다르면 해당 page 결과를 폐기한다.
- `revisionTimestamp`와 `fetchedAt`은 UTC RFC 3339로 저장한다. `pageUrl`과 attribution은 가능하면 해당 revision을 직접 여는 URL을 사용한다.
- `contentHash`는 비교에 실제 사용한 추출 결과를 key 정렬한 canonical JSON, UTF-8, 불필요한 공백 없음으로 직렬화한 값의 SHA-256 lowercase hex다. 원문 HTML이나 서로 다른 revision의 필드를 섞어 hash하지 않는다.
- 모든 비교 결과에 `snapshotGenerationId`, revision, content hash를 결속한다. generation manifest에는 포함 page의 pageId·revisionId·contentHash와 resolver version을 기록한다.
- 갱신 결과는 임시 generation에 모두 쓴 뒤 schema·revision·hash·라이선스를 재검증하고, 마지막에만 current generation pointer를 원자적으로 바꾼다. 일부 page 실패, 중단, 429·5xx에서는 이전 정상 generation을 유지하고 실패 보고서만 별도 저장한다.
- Fandom의 라이선스·표시 조건을 확인하고 attribution을 제공한다. 패키지에 위키에서 가져온 텍스트·이미지·표현물을 하나라도 포함하는 evidence는 `licenseName`, `licenseUrl`, `attributionUrl`이 모두 있어야 한다.
- 라이선스 또는 attribution을 확인하지 못한 page는 비교 실패 사유 `LICENSE_BLOCKED`로 기록하고 snapshot·패치·릴리스에 게시하지 않는다. 단순히 optional 필드를 비워 통과시키지 않는다.
- 긴 본문과 이미지를 패키지에 무단 복제하지 않는다.
- 런타임 앱은 Fandom을 실시간 호출하지 않는다.
- 갱신기는 제한된 동시성, timeout, 429·5xx backoff, 이전 정상 결과 보존을 사용한다.
- source host는 HTTPS allowlist에 고정하고 redirect 뒤 최종 host도 다시 검증한다. 사용자 입력 URL이나 응답 URL을 그대로 filesystem 경로 또는 다음 fetch 대상으로 사용하지 않는다.
- 단위 테스트는 고정 fixture, 네트워크 갱신은 별도 작업으로 분리한다.

기존 미확인 38개는 단순히 0개로 만들지 않고 다음 사유로 분류한다.

```text
redirect | renamed | deleted | ambiguous | unresolved
```

`A Big Loss`, `Small Things, Big Help`뿐 아니라 모든 기존 실패 제목과 과거 alias를 회귀 목록으로 만든다.

## 6.3 보상 비교 규칙

- 기본·조건부 보상을 분리한다.
- RUB·USD·EUR·GP 등 통화를 구분한다.
- 배열 정렬, 공백, 문장부호, 숫자 허용 오차의 canonical 규칙을 고정한다.
- itemId가 없는 위키 항목을 이름만으로 강제 연결하지 않는다.
- `VARIABLE`과 `DIFFERENT`가 동시에 해당할 때 우선순위를 정한다.
- fingerprint는 정렬된 canonical JSON으로 만든다.
- 위키 차이가 있어도 앱 데이터를 자동 덮어쓰지 않는다.

---

# 7. M3 - 현재 지도 퀘스트 창과 다중 오버레이

## 7.1 유지할 기술 결정

- 미니맵은 기존 Document PiP 한 개를 유지한다.
- 두 번째 Document PiP는 열지 않는다.
- Direct 퀘스트 창은 same-origin popup과 다중 네이티브 overlay record를 사용한다.
- 일반 웹은 popup, 차단 시 페이지 내부 도킹 fallback을 제공한다.
- popup 후보가 없거나 둘 이상이면 임의 HWND를 조작하지 않고 일반 창으로 유지한다.

## 7.2 다중 창 상태의 단일 작성자

`BroadcastChannel` 수신 창들이 각자 localStorage를 쓰면 마지막 창이 다른 변경을 덮어쓸 수 있다.

- `메인 창`이라는 UI 역할만으로 writer를 정하지 않는다. full-app 탭이 둘 이상이어도 정확히 하나만 진행도의 권위 있는 writer lease를 가져야 한다.
- 일반 웹·Chromium Direct UI는 Web Locks의 exclusive lock `tarkov-helper-progress-writer`를 탭 수명 동안 보유한 창만 writer로 인정한다. lock을 얻지 못한 full-app 탭은 진행도에 대해 읽기 전용이다.
- Web Locks를 사용할 수 없는 일반 웹에서는 진행도 편집을 활성화하지 않고 지원 브라우저에서 한 탭만 열도록 안내한다. Direct는 백엔드의 단일 writer API를 사용할 수 있다. 어느 경우에도 localStorage lease만으로 writer를 선출하지 않는다.
- writer가 lock을 얻을 때 durable `writerEpoch`을 증가시킨다. lock을 잃은 창은 즉시 쓰기를 멈추며 이전 epoch의 명령은 새 writer가 거부한다.
- popup은 검증 가능한 변경 명령만 보낸다.
- 현재 writer가 저장을 검증한 뒤 revision을 방송한다.
- popup은 최신 revision을 읽어 렌더링한다.
- `baseRevision !== currentRevision`인 명령은 `STALE_REVISION`으로 거부한다. popup은 최신 snapshot을 다시 읽어 사용자에게 변경 결과를 보여 주며, 서로 다른 상태를 만드는 명령을 자동 재생하지 않는다.
- opener가 끊기거나 writer lease가 없으면 popup은 읽기 전용 `연결 끊김` 상태가 된다. 새 writer 선출 뒤 새 epoch와 capability를 받은 경우에만 편집을 다시 활성화한다.

```ts
interface OverlayEnvelope {
  schemaVersion: 1;
  sessionId: string;
  capability: string;
  sourceWindowId: string;
  eventId: string;
  writerEpoch: number;
  baseRevision: number;
}

type OverlayCommand = OverlayEnvelope & (
  | {
      kind: "SET_QUEST_STATUS";
      payload: { questId: string; status: "inProgress" | "done" | "failed" | null };
    }
  | {
      kind: "SET_OBJECTIVE_PROGRESS";
      payload: { questId: string; objectiveId: string; completed: boolean };
    }
  | {
      kind: "SELECT_ACTIVE_TARGET";
      payload: { questId: string; objectiveId?: string };
    }
);

interface OverlayResponseEnvelope {
  schemaVersion: 1;
  sessionId: string;
  writerEpoch: number;
}

type OverlayResponse = OverlayResponseEnvelope & (
  | {
      kind: "COMMAND_ACCEPTED";
      eventId: string;
      revision: number;
    }
  | {
      kind: "COMMAND_REJECTED";
      eventId: string;
      currentRevision: number;
      reason:
        | "STALE_REVISION"
        | "STALE_WRITER_EPOCH"
        | "INVALID_CAPABILITY"
        | "INVALID_PAYLOAD"
        | "READ_ONLY";
    }
  | {
      kind: "REVISION_PUBLISHED";
      revision: number;
    }
);
```

검증:

- command의 schema·session·capability·writerEpoch·baseRevision·명령별 payload를 검증하고, response도 session·epoch·revision을 검증함
- 직렬화한 메시지는 16 KiB, 각 ID는 256 Unicode code point 이하로 제한함
- capability는 세션마다 암호학적으로 안전하게 만들고 URL·localStorage·로그에 기록하지 않음. writer가 exact-origin `postMessage`로 승인된 popup에 한 번 전달하고 예측 불가능한 세션별 channel 이름을 사용함
- eventId 중복 한 번만 적용
- 전체 상태를 메시지에 넣지 않음
- `postMessage` fallback은 exact origin 검증
- 두 full-app 탭 동시 시작·동시 변경, non-writer 쓰기 거부, writer 종료·승계, 이전 epoch 명령 거부
- stale baseRevision reject 뒤 snapshot 재조회, opener 종료, popup 새로고침, 앱 업데이트 재연결
- 미니맵과 퀘스트 창의 style·region·rect 독립 복원
- 100/125/150/175/200% DPI와 서로 다른 DPI 모니터 이동
- 클릭 통과 상태를 메인 앱에서 항상 해제 가능

---

# 8. 명시적 제외 기능

- 퀘스트 추천·난이도 점수·우선순위 자동 판단
- 현재 레이드에 쉽다는 AI 판단
- 로그로 목표별 카운터·은신처·레벨 추정
- 스크린샷 좌표만으로 목표 자동 완료
- 자동 최단 경로·안전 경로
- 두 번째 Document PiP
- 위키 결과의 무검토 자동 덮어쓰기
- 모드 문자열만 보고 서로 다른 프로필 진행도 자동 병합

`objectiveType`은 방문·설치·처치·기타의 사실 기반 필터에만 사용하며 추천 문구를 만들지 않는다.

---

# 9. 데이터 무결성 정책

오류와 경고를 구분한다.

```text
ERROR: 앱 canonical ID 참조 파손, 중복 ID, 손상 schema, 릴리스 불가능
WARN : 위키 미매핑 이름, 좌표 검토, 번역 검토, 외부 페이지 변경
```

- 앱 canonical 보상의 깨진 itemId는 ERROR다.
- 위키 snapshot의 미매핑 원문 아이템은 WARN이다.
- 여러 퀘스트가 같은 canonical page에 매핑되면 명시적 alias가 아닌 한 ERROR다.
- 좌표가 필요 없는 목표의 좌표 없음은 오류로 세지 않는다.
- 보고서는 JSON과 사람이 읽는 Markdown을 함께 만든다.
- 이전 경고 기준선을 저장하고 새 경고 증가를 CI에 표시한다.
- 문서에 적힌 데이터 개수는 수동 숫자가 아니라 현재 생성된 meta에서 검증한다.

---

# 10. 공통 테스트 매트릭스

## 10.1 데이터·상태

- 상태 버전 직접 건너뛰기와 멱등 migration
- 신버전 저장 후 구버전 롤백
- quota·저장 차단·손상 JSON·부분 쓰기
- 한글 사용자명·한글 폴더·공백·쉼표·괄호·다른 드라이브
- 읽기 전용 폴더와 백신 파일 잠금

## 10.2 탐색·UI

- Back·Forward·새로고침·직접 링크
- 정확한 비기본 퀘스트·시설·레벨
- 완료·실패·진영 불일치 상세 출처
- P0-A는 직전 메뉴와 상세 ID를 복원한다.
- P0-B는 3.5의 `AppHistoryStateV1 { schemaVersion, appEntryId, appDepth, route, view }`를 사용해 검색어·필터·목록 scrollTop까지 복원한다.
- 키보드 포커스, visible focus, `aria-current`/`aria-pressed`
- 작은 화면과 긴 한글·영문 제목

## 10.3 Direct·외부 연동

- 임시 상태 폴더만 사용하고 사용자 서버·데이터를 건드리지 않음
- loopback·Host·Origin·capability·CORS 회귀
- watcher rotation·truncate·권한 오류
- overlay 독립 복원과 DPI
- 오프라인 시작과 이전 정상 데이터 보존

## 10.4 필수 명령

```bash
pnpm typecheck
pnpm lint
pnpm test --run
pnpm build
pnpm test:release
pnpm test:portable
pnpm test:e2e:direct
```

Windows 전용 테스트가 skip되면 완료로 처리하지 않는다. 가시 GUI 검증이 금지된 환경에서는 headless/jsdom/off-screen synthetic 테스트 결과와 미실행 범위를 명시한다.

---

# 11. 릴리스 완료의 정의

다음 단계는 서로 다르다.

1. 로컬 코드 수정
2. 테스트 통과
3. Git commit
4. 원격 push
5. Git tag 생성
6. GitHub Actions 품질·패키징·서명
7. immutable GitHub Release 공개
8. 실제 direct ZIP의 manifest·서명·해시 재검증
9. 이전 설치본에서 업데이트·자동 적용·롤백 smoke test

커밋이나 push만 끝난 상태를 사용자 업데이트 가능 상태라고 표시하지 않는다. 버전 표시, `package.json`, ZIP 내부 version, 태그, manifest가 모두 같아야 한다.

## 11.1 공통 구현 경계

- 기존 자동 업데이트의 서명·immutable release·원자 교체·롤백 코드를 불필요하게 바꾸지 않는다.
- Windows PowerShell 5.1, 한글·공백 경로, 다른 드라이브를 유지한다.
- `any`나 무검증 type assertion으로 타입 오류를 숨기지 않는다.
- 로그·프로필·보유 아이템을 외부 서비스로 전송하지 않는다.
- 기존 미니맵·지도·시세·업데이트 테스트를 삭제하거나 약화하지 않는다.
- 완료 보고에는 변경 파일, migration, 테스트, 미실행 범위, 공개 릴리스 여부를 구분해 적는다.
- GUI 검증은 headless·off-screen synthetic을 우선하며 메인 모니터에 가시 테스트 창을 띄우지 않는다. 실제 창 검증이 꼭 필요하면 먼저 사용자 승인을 받는다.

## 11.2 외부 증거 관리

원문 13장의 URL은 참고 시작점이며, 실제 구현 보고서에는 사용한 commit SHA·파일 경로·확인 날짜를 고정한다. 위키는 page revision과 함께, Document PiP·브라우저 API는 사용한 명세 revision 또는 조회 날짜와 함께 기록한다. 외부 구현 코드를 복사하기 전에 라이선스를 확인하고 가능하면 동작 규칙과 fixture만 독립 구현한다.

---

# 12. 권장 작업 단위와 선행 관계

1. **P0-A** 중앙 라우트, 아이템→정확한 퀘스트·은신처 레벨, Back·Forward·딥링크 통합 테스트
2. **P0-B** 검색어·필터·스크롤 history snapshot
3. **P0-C** 선택형 앱 뒤로가기 UI와 잘못된 target 안내
4. **M0-A** 버전별 저장 키와 migration engine
5. **M0-B** export/import와 last-known-good
6. **M1-A** MarketMode/EftProgressMode/profile schema
7. **M1-B** 로그 parser fixture와 preview
8. **M1-C** Direct watcher·cursor·local API
9. **M2-A** 공통 wiki resolver·evidence·alias audit
10. **M2-B** canonical reward schema·comparison report·UI
11. **M3-A** native overlay v2 다중 record feasibility
12. **M3-B** quest popup/dock와 single-writer channel
13. **M3-C** 지도·프로필·목표 동기화와 DPI/복구

각 작업은 독립적으로 실패 테스트를 먼저 만들고, 한 작업의 완료를 다음 작업의 전제로 명시한다.

---

# 13. 이번 검토의 결론

기존 정정본의 기능 방향은 유지할 수 있지만 다음 네 가지를 먼저 바로잡아야 한다.

1. 상세 ID와 history가 없는 상태에서 새 연결 기능을 더 만들지 않는다.
2. 상태 schema 변경은 실행 파일 롤백과 함께 설계한다.
3. 로그·위키는 추정값이 아니라 revision·event·profile 근거를 보존한다.
4. popup과 다중 탭은 localStorage 다중 writer가 되지 않게 한다.

가장 먼저 배포할 가치가 있는 것은 P0 탐색 수정이다. 이 중앙 계약이 있어야 보상 아이템, 선행·후속 퀘스트, 지도 마커, 향후 퀘스트 popup도 동일한 방식으로 정확히 이동하고 뒤로갈 수 있다.
