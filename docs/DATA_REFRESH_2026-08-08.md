# 퀘스트 데이터 팩 갱신 기록

갱신일: 2026-08-08

## 적용 내용

- 기존 웹 팩의 488개 퀘스트 레코드와 지도 좌표·진행 호환성을 보존했습니다.
- 최신 [TarkovData quests.json](https://raw.githubusercontent.com/TarkovLab/TarkovData/master/data/quests.json)의 생성 시각 `2026-08-02T09:43:19.569Z`를 기준으로, 기존 레코드와 ID/정규화 이름이 겹치지 않는 13개 퀘스트를 추가했습니다.
- 결과 웹 팩은 **501개 퀘스트**입니다.
- [Tarkov 위키 Quests 페이지](https://escapefromtarkov.fandom.com/wiki/Quests)의 고정 목록은 516개 링크로 기록하고, 원문 revision `2026-08-07T14:28:05Z`를 메타데이터에 보존했습니다.

## 병합 규칙

1. `bsgId`와 TarkovData의 `gameId`를 우선 비교합니다.
2. ID가 없으면 퀘스트 이름을 정규화해 비교합니다. `[PVP ZONE]`, USEC/BEAR 접미사는 식별 시 제외합니다.
3. 기존 레코드가 있으면 기존 지도 좌표, 선행조건, 아이템 요구량을 유지합니다.
4. 새로 추가된 TarkovData 레코드는 기본 선행조건·아이템 요구량을 비워 두고, 원격 목표 설명과 기본 지도명만 가져옵니다. 원격 x/y는 웹 팩의 월드 좌표와 단위가 달라 위치 마커로 변환하지 않았습니다.

## 현재 메타데이터

`public/data/tarkov-data.json`의 `meta.sources`에 다음 정보가 저장됩니다.

- `localExportedAt`: 기존 팩 생성 시각
- `tarkovDataGeneratedAt`: TarkovData 생성 시각
- `tarkovDataQuestCount`: 원격 퀘스트 수
- `wikiQuestCount`: 위키 고정 목록 수
- `wikiRevisionTimestamp`: 위키 원문 revision 시각
- `refreshMode`: 기존 데이터 보존 후 TarkovData 누락분 추가 방식

## 재갱신 방법

```powershell
pnpm data:refresh-quests
```

이 명령은 현재 웹 팩을 읽고 TarkovData와 위키 API를 다시 확인한 뒤, 임시 파일 검증 후 `public/data/tarkov-data.json`을 교체합니다.
