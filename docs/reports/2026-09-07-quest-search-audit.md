# 퀘스트 검색 누락 점검 — 2026-09-07

## 확인된 원인

사용자 제공 v1.0.41 화면에서 두 검색 모두 `카파 필수`가 선택되어 있었다.
`사냥꾼의 길 - 구역 확보`와 `Forester's Duty`는 번들에 존재하지만,
현재 카파 필수 값이 false이므로 이름과 카파 조건을 동시에 적용하면 0건이다.
일반/PVE/시즌 목록 모두 두 퀘스트가 있으며, 필터를 해제한 정확한 이름 검색은 동작한다.
프로필 기록이나 업데이트 데이터가 사라진 문제가 아니다.

기존 화면은 필터로 가려진 경우와 실제 검색 불일치를 구별하지 않아
사용자가 데이터 누락으로 이해할 수 있었다.

## 수정

- 검색어와 일치하지만 부가 필터로 가려진 결과 수, 적용 중인 필터 이름을 표시한다.
- `다른 필터 해제`는 이름 검색어를 보존하고 제출 아이템/보상/카파/아이템/상인/지도/상태 필터만 해제한다.
- 진영 조건이나 완료 상태 등 프로필 자체를 수정하지 않는다.
- 일반 퀘스트, 지도 지역/전체 퀘스트, 진행 중 퀘스트 입력에서 공백·따옴표·대시 등 구두점 차이를 동일하게 처리한다.
- 진행 중 퀘스트 입력에서도 기존 이름 별칭을 검색한다. 완료된 퀘스트 제외와 상인 필터는 유지한다.

## 유사 문제 조사

복사한 곡선 따옴표와 띄어쓰기로 `Forester’s Duty`, `구역확보` 등이 검색되지 않는 문제를
수정 전 테스트로 재현했다. 같은 문제는 Keeper's Word, You've Got Mail,
Pets Won't Need It, Pets Won't Need It - Part 2, Hot Wheels - Let's Try Again 등에도 적용된다.

현재 공급 API의 퀘스트 ID와 번들 ID/이전 ID를 대조한 결과:

| 목록 | 번들 | 현재 공급 목록 | 공급 목록 중 번들에 없는 ID |
| --- | ---: | ---: | ---: |
| regular (현재 PVP 사용) | 517 | 515 | 0 |
| pve | 514 | 512 | 0 |
| pvp-season (보관 목록) | 491 | 489 | 0 |

공급 응답 수정 시각은 2026-09-06 13:43 UTC, 확인일은 2026-09-07 KST다.
출처: [regular](https://json.tarkov.dev/regular/tasks),
[PVE](https://json.tarkov.dev/pve/tasks), [시즌](https://json.tarkov.dev/pvp-season/tasks).
이 결과는 해당 공급 목록 대비 누락이 없다는 뜻이며, 게임 내 모든 퀘스트의 정확성 보증은 아니다.
이번 수정에서는 데이터 전체 갱신/삭제나 진행도 마이그레이션을 하지 않았다.

## 출처 차이와 별도 확인 항목

- 현재 regular 공급 데이터도 두 퀘스트의 `kappaRequired`가 false다.
  [구역 확보 위키](https://escapefromtarkov.fandom.com/wiki/The_Huntsman_Path_-_Secured_Perimeter)의 카파 Yes 및 사무실 처치 설명은 공급 데이터와 다르다.
  [Forester's Duty 위키](https://escapefromtarkov.fandom.com/wiki/Forester%27s_Duty)는 카파 No다.
  검색 노출을 위해 카파 값을 임의로 바꾸거나 구버전 선행 조건을 덮어쓰지 않았다.
- 지도에서는 세 목록 각각 동일한 11개 퀘스트/19개 목표에 기존 좌표와 빈 신규 맵별 좌표가 공존한다.
  대상: Beneath The Streets, Burning Rubber, Choose Your Friends Wisely, Dangerous Road,
  Information Source, Pest Control, Secrets of Polikhim, Seizing the Initiative,
  The Huntsman Path - Crooked Cop, The Huntsman Path - Secured Perimeter, The Price of Independence.
  기존 좌표가 현재 목표에도 유효한지 검증 없이 복구하면 잘못된 위치가 표시될 수 있어 이번 검색 수정에 섞지 않았다.
- Forester's Duty 이동 목표는 퀘스트 좌표가 없고 지도에는 Lighthouse의 Transit to Shoreline 마커가 있다.
  현재 게임 위치 검증을 거친 뒤 연결할 별도 대상이다. 전역 Scav 처치에 임의 좌표를 붙이지 않는다.

## 검증

- 검색 표기 차이, 필터 제외 안내, 검색어 유지 해제에 대한 실패 재현 후 회귀 테스트.
- 실제 번들 전체를 불러오는 앱 통합 테스트에서 두 퀘스트의 정확한 이름/공백 생략/곡선 따옴표 검색과 PVP→PVE 전환 검증.
- 브라우저에서 사용자와 동일한 `카파 필수` 조건의 안내와 해제 후 결과 표시 확인.
- 전체 Vitest 59개 파일/692개 테스트 통과. 이후 테스트 파일의 타입 수정에 해당하는 두 파일 재검증.
- 타입 검사 포함 프로덕션 빌드 및 전체 ESLint 통과. 기존 500 kB 번들 크기 경고는 남아 있다.
- 수정 화면의 브라우저 오류/경고 로그 0건.
- 저장 데이터, 카파 분류, 릴리즈 버전은 변경하지 않음.
