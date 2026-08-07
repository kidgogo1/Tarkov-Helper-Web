import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_STATE_STORAGE_KEY,
  AppStoreProvider,
  createDefaultState,
  useAppStore,
} from "../../src/app/store";
import { QuestsPage } from "../../src/features/quests/QuestsPage";
import type { QuestData, TarkovData } from "../../src/types/data";

function quest(id: string, overrides: Partial<QuestData> = {}): QuestData {
  return {
    id,
    normalizedName: id,
    name: id,
    nameEn: id,
    trader: "Prapor",
    locations: [],
    kappaRequired: false,
    requirements: [],
    alternativeQuestIds: [],
    followUpQuestIds: [],
    objectives: [],
    requiredItems: [],
    ...overrides,
  };
}

const mainQuest = quest("q-main", {
  normalizedName: "operation-aquarius",
  name: "Operation Aquarius",
  nameEn: "Operation Aquarius",
  nameKo: "물병자리 작전",
  wikiPageLink: "https://example.test/wiki/operation-aquarius",
  trader: "Therapist",
  locations: ["Customs"],
  faction: "usec",
  kappaRequired: true,
  requirements: [
    { questId: "q-prep", requirementType: "complete", groupId: 0 },
    { questId: "q-alt", requirementType: "complete", groupId: 1 },
    { questId: "q-choice", requirementType: "complete", groupId: 1 },
  ],
  alternativeQuestIds: ["q-alt"],
  followUpQuestIds: ["q-follow"],
  objectives: [
    {
      id: "objective-water",
      sortOrder: 0,
      objectiveType: "visit",
      description: "기숙사에서 물 찾기",
      requiresFir: false,
      mapName: "Customs",
      locationPoints: [{ x: 10, y: 0, z: 20 }],
      optionalPoints: [],
    },
  ],
  requiredItems: [
    {
      id: "requirement-salewa",
      itemId: "item-salewa",
      itemName: "Salewa first aid kit",
      count: 2,
      requiresFir: true,
      requirementType: "handover",
      sortOrder: 0,
    },
  ],
});

const testData: TarkovData = {
  meta: {
    originalCommit: "original",
    modifiedCommit: "modified",
    exportedAt: "2026-08-07T00:00:00.000Z",
    counts: {
      quests: 7,
      items: 1,
      hideoutStations: 0,
      maps: 1,
      mapMarkers: 0,
    },
  },
  quests: [
    mainQuest,
    quest("q-prep", { nameKo: "사전 작업", nameEn: "Preparation" }),
    quest("q-alt", {
      nameKo: "대안 임무",
      nameEn: "Alternative",
      alternativeQuestIds: ["q-choice"],
    }),
    quest("q-choice", {
      nameKo: "선택 임무",
      nameEn: "Choice",
      alternativeQuestIds: ["q-alt"],
    }),
    quest("q-follow", { nameKo: "후속 임무", nameEn: "Follow up" }),
    quest("q-easy-a", { nameKo: "쉬운 임무 A", nameEn: "Easy A" }),
    quest("q-easy-b", {
      nameKo: "쉬운 임무 B",
      nameEn: "Easy B",
      trader: "Skier",
      objectives: [
        {
          id: "objective-woods",
          sortOrder: 0,
          objectiveType: "visit",
          description: "숲 방문",
          requiresFir: false,
          mapName: "Woods",
          locationPoints: [],
          optionalPoints: [],
        },
      ],
    }),
  ],
  items: [
    {
      id: "item-salewa",
      name: "Salewa first aid kit",
      nameEn: "Salewa first aid kit",
      nameKo: "살레와 구급낭",
      categories: ["Medical"],
      isDogtagItem: false,
    },
  ],
  hideoutStations: [],
  traders: [
    { id: "therapist", name: "Therapist", nameKo: "테라피스트", normalizedName: "therapist" },
    { id: "prapor", name: "Prapor", nameKo: "프라퍼", normalizedName: "prapor" },
    { id: "skier", name: "Skier", nameKo: "스키어", normalizedName: "skier" },
  ],
  mapConfigs: [
    {
      key: "customs",
      displayName: "Customs",
      svgFileName: "customs.svg",
      imageWidth: 1000,
      imageHeight: 1000,
      aliases: ["세관"],
      floors: [],
    },
  ],
  mapMarkers: [],
  mapFloorLocations: [],
};

function StoreProbe() {
  const { profile } = useAppStore();
  return <output data-testid="profile-state">{JSON.stringify(profile)}</output>;
}

function renderPage(onOpenMap = vi.fn()) {
  render(
    <AppStoreProvider>
      <QuestsPage data={testData} onOpenMap={onOpenMap} />
      <StoreProbe />
    </AppStoreProvider>,
  );
  return onOpenMap;
}

function readProfile() {
  return JSON.parse(screen.getByTestId("profile-state").textContent ?? "{}");
}

describe("QuestsPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("shows recommendations and statistics, then filters the dense quest list", () => {
    renderPage();

    expect(screen.getByRole("heading", { level: 1, name: "퀘스트" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("article", { name: "퀘스트 상세" })).getByText(
        "Operation Aquarius",
      ),
    ).toBeInTheDocument();

    const recommendations = screen.getByRole("region", { name: "추천 퀘스트" });
    expect(within(recommendations).getAllByRole("button")).toHaveLength(5);

    const statistics = screen.getByRole("region", { name: "전체 퀘스트 통계" });
    expect(within(statistics).getByText("전체")).toBeInTheDocument();
    expect(within(statistics).getByText("7")).toBeInTheDocument();

    const list = screen.getByRole("region", { name: "퀘스트 목록" });
    fireEvent.change(screen.getByRole("searchbox", { name: "퀘스트 검색" }), {
      target: { value: "물병자리" },
    });
    expect(within(list).getByRole("button", { name: /물병자리 작전/ })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /쉬운 임무 A/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "퀘스트 검색" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "카파 필수" }));
    expect(within(list).getAllByRole("button")).toHaveLength(1);

    fireEvent.click(screen.getByRole("checkbox", { name: "카파 필수" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "아이템 필요" }));
    expect(within(list).getAllByRole("button")).toHaveLength(1);

    fireEvent.click(screen.getByRole("checkbox", { name: "아이템 필요" }));
    fireEvent.change(screen.getByRole("combobox", { name: "상인" }), {
      target: { value: "Therapist" },
    });
    expect(within(list).getAllByRole("button")).toHaveLength(1);

    fireEvent.change(screen.getByRole("combobox", { name: "상인" }), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "지도" }), {
      target: { value: "Customs" },
    });
    expect(within(list).getAllByRole("button")).toHaveLength(1);

    fireEvent.change(screen.getByRole("combobox", { name: "지도" }), {
      target: { value: "Woods" },
    });
    expect(within(list).getByRole("button", { name: /쉬운 임무 B/ })).toBeInTheDocument();
  });

  it("connects quest details, inventory, progress, faction, wiki, and map actions", () => {
    const state = createDefaultState();
    state.profiles.pvp.inventory["item-salewa"] = { fir: 2, nonFir: 0 };
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
    const onOpenMap = renderPage();

    expect(screen.getByRole("heading", { name: "물병자리 작전" })).toBeInTheDocument();
    expect(screen.getByText("살레와 구급낭")).toBeInTheDocument();
    expect(screen.getByText("보유 2 / 필요 2")).toBeInTheDocument();
    expect(screen.getByText("충족")).toBeInTheDocument();
    expect(screen.getByText("선행 퀘스트")).toBeInTheDocument();
    expect(screen.getByText("선택 선행 조건 (OR)" )).toBeInTheDocument();
    expect(screen.getByText("대안 퀘스트")).toBeInTheDocument();
    expect(screen.getByText("후속 퀘스트")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "기숙사에서 물 찾기" }));
    expect(readProfile().objectiveProgress["objective-water"]).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "퀘스트 완료" }));
    expect(readProfile().questProgress).toMatchObject({
      "q-main": "done",
      "q-prep": "done",
      "q-alt": "failed",
    });
    expect(
      within(screen.getByRole("article", { name: "퀘스트 상세" })).getByText(
        "완료",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "완료 초기화" }));
    expect(readProfile().questProgress["q-main"]).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "BEAR" }));
    expect(readProfile().faction).toBe("bear");

    expect(screen.getByRole("link", { name: "위키 열기" })).toHaveAttribute(
      "href",
      "https://example.test/wiki/operation-aquarius",
    );
    fireEvent.click(screen.getByRole("button", { name: "지도에서 보기" }));
    expect(onOpenMap).toHaveBeenCalledWith("customs", "q-main");
  });
});
