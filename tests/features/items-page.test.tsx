import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_STATE_STORAGE_KEY,
  AppStoreProvider,
  createDefaultState,
} from "../../src/app/store";
import { ItemsPage } from "../../src/features/items/ItemsPage";
import type { TarkovData } from "../../src/types/data";

const data: TarkovData = {
  meta: {
    originalCommit: "original",
    modifiedCommit: "modified",
    exportedAt: "2026-08-07T00:00:00Z",
    counts: { quests: 1, items: 1, hideoutStations: 0, maps: 0, mapMarkers: 0 },
  },
  quests: [
    {
      id: "quest",
      normalizedName: "quest",
      name: "Supply Run",
      nameEn: "Supply Run",
      nameKo: "보급 작전",
      trader: "Prapor",
      locations: [],
      kappaRequired: true,
      requirements: [],
      alternativeQuestIds: [],
      followUpQuestIds: [],
      objectives: [],
      requiredItems: [
        {
          id: "bolt-requirement",
          itemId: "bolts",
          itemName: "Bolts",
          count: 2,
          requiresFir: true,
          requirementType: "handover",
          sortOrder: 0,
        },
        {
          id: "bolt-general-requirement",
          itemId: "bolts",
          itemName: "Bolts",
          count: 4,
          requiresFir: false,
          requirementType: "handover",
          sortOrder: 1,
        },
      ],
    },
  ],
  items: [
    {
      id: "bolts",
      name: "Bolts",
      nameEn: "Bolts",
      nameKo: "볼트",
      category: "Building materials",
      categories: ["Building materials"],
      isDogtagItem: false,
    },
  ],
  hideoutStations: [],
  traders: [],
  mapConfigs: [],
  mapMarkers: [],
  mapFloorLocations: [],
};

describe("ItemsPage", () => {
  beforeEach(() => window.localStorage.clear());

  it("shows Korean item names first and searches both Korean and English", () => {
    const localizedData: TarkovData = {
      ...data,
      items: data.items.map((item) => ({
        ...item,
        nameKo: "\uBCFC\uD2B8",
        nameEn: "Bolts",
      })),
    };

    render(
      <AppStoreProvider>
        <ItemsPage data={localizedData} />
      </AppStoreProvider>,
    );

    expect(screen.getAllByText("\uBCFC\uD2B8").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Bolts").length).toBeGreaterThan(0);
    expect(screen.getByRole("option", { name: "\uAD50\uD658 \uBB3C\uD488" })).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "\uC544\uC774\uD15C \uAC80\uC0C9" });

    fireEvent.change(search, { target: { value: "\uBCFC\uD2B8" } });
    expect(screen.getByRole("button", { name: "\uBCFC\uD2B8 \uC0C1\uC138 \uBCF4\uAE30" })).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "Bolts" } });
    expect(screen.getByRole("button", { name: "\uBCFC\uD2B8 \uC0C1\uC138 \uBCF4\uAE30" })).toBeInTheDocument();
  });

  it("shows aggregated sources and edits FIR inventory", () => {
    render(
      <AppStoreProvider>
        <ItemsPage data={data} />
      </AppStoreProvider>,
    );

    expect(screen.getAllByText("볼트").length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "시세 요약" })).toBeInTheDocument();
    expect(screen.getAllByText("Supply Run")).toHaveLength(2);
    expect(screen.getByText("2F+4 필요")).toBeInTheDocument();
    expect(screen.getAllByText("2F+4")).toHaveLength(2);

    const firEditor = screen.getByRole("group", { name: "볼트 FIR 보유량" });
    const generalEditor = screen.getByRole("group", { name: "볼트 일반 보유량" });
    expect(firEditor.closest("label")).toBeNull();
    expect(generalEditor.closest("label")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "볼트 FIR 보유량 증가" }));
    fireEvent.click(screen.getByRole("button", { name: "볼트 FIR 보유량 증가" }));
    for (let count = 0; count < 4; count += 1) {
      fireEvent.click(screen.getByRole("button", { name: "볼트 일반 보유량 증가" }));
    }

    expect(screen.getByText("보유 2F+4")).toBeInTheDocument();
    expect(screen.getByText("충족")).toBeInTheDocument();
  });

  it("opens the active quest or remaining hideout station from an item source", () => {
    const onOpenQuest = vi.fn();
    const onOpenHideout = vi.fn();
    const linkedData: TarkovData = {
      ...data,
      meta: {
        ...data.meta,
        counts: { ...data.meta.counts, hideoutStations: 1 },
      },
      hideoutStations: [
        {
          id: "workbench",
          name: "Workbench",
          normalizedName: "workbench",
          maxLevel: 1,
          levels: [
            {
              id: "workbench-level-1",
              level: 1,
              constructionTime: 0,
              items: [
                {
                  id: "workbench-bolts",
                  itemId: "bolts",
                  itemName: "Bolts",
                  count: 3,
                  foundInRaid: false,
                  sortOrder: 0,
                },
              ],
              stations: [],
              traders: [],
              skills: [],
            },
          ],
        },
      ],
    };

    render(
      <AppStoreProvider>
        <ItemsPage
          data={linkedData}
          onOpenHideout={onOpenHideout}
          onOpenQuest={onOpenQuest}
        />
      </AppStoreProvider>,
    );

    const detail = screen.getByRole("complementary", { name: "아이템 상세" });
    fireEvent.click(within(detail).getAllByRole("button", { name: "Supply Run 퀘스트 열기" })[0]!);
    expect(onOpenQuest).toHaveBeenCalledWith("quest");

    fireEvent.click(within(detail).getByRole("button", { name: "Workbench 은신처 열기" }));
    expect(onOpenHideout).toHaveBeenCalledWith("workbench");
  });

  it("shows completed quest and hideout item sources separately from remaining needs", () => {
    const onOpenQuest = vi.fn();
    const onOpenHideout = vi.fn();
    const state = createDefaultState();
    state.profiles.pvp.questProgress["completed-quest"] = "done";
    state.profiles.pvp.hideoutLevels.workbench = 1;
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
    const historyData: TarkovData = {
      ...data,
      meta: {
        ...data.meta,
        counts: { ...data.meta.counts, quests: 2, hideoutStations: 1 },
      },
      quests: [
        ...data.quests,
        {
          ...data.quests[0],
          id: "completed-quest",
          normalizedName: "completed-quest",
          name: "Completed Delivery",
          nameEn: "Completed Delivery",
          requiredItems: [
            {
              id: "completed-bolts",
              itemId: "bolts",
              itemName: "Bolts",
              count: 7,
              requiresFir: false,
              requirementType: "handover",
              sortOrder: 0,
            },
          ],
        },
      ],
      hideoutStations: [
        {
          id: "workbench",
          name: "Completed Workbench",
          normalizedName: "workbench",
          maxLevel: 2,
          levels: [
            {
              id: "workbench-level-1",
              level: 1,
              constructionTime: 0,
              items: [
                {
                  id: "completed-workbench-bolts",
                  itemId: "bolts",
                  itemName: "Bolts",
                  count: 9,
                  foundInRaid: false,
                  sortOrder: 0,
                },
              ],
              stations: [],
              traders: [],
              skills: [],
            },
            {
              id: "workbench-level-2",
              level: 2,
              constructionTime: 0,
              items: [
                {
                  id: "remaining-workbench-bolts",
                  itemId: "bolts",
                  itemName: "Bolts",
                  count: 3,
                  foundInRaid: false,
                  sortOrder: 0,
                },
              ],
              stations: [],
              traders: [],
              skills: [],
            },
          ],
        },
      ],
    };

    render(
      <AppStoreProvider>
        <ItemsPage
          data={historyData}
          onOpenHideout={onOpenHideout}
          onOpenQuest={onOpenQuest}
        />
      </AppStoreProvider>,
    );

    const detail = screen.getByRole("complementary", { name: "아이템 상세" });
    expect(within(detail).getByText("전체 필요")).toBeInTheDocument();
    expect(within(detail).getByText("완료 처리")).toBeInTheDocument();
    expect(within(detail).getByText("남은 필요")).toBeInTheDocument();
    const completedQuest = within(detail).getByText("Completed Delivery");
    const completedHideout = within(detail).getAllByRole("button", {
      name: "Completed Workbench 은신처 열기",
    })[1]!;
    expect(completedQuest).toBeInTheDocument();
    expect(completedHideout).toBeInTheDocument();

    fireEvent.click(completedQuest.closest("button")!);
    fireEvent.click(completedHideout);
    expect(onOpenQuest).toHaveBeenCalledWith("completed-quest");
    expect(onOpenHideout).toHaveBeenCalledWith("workbench");
  });

  it("filters by search without losing the full aggregate", () => {
    render(
      <AppStoreProvider>
        <ItemsPage data={data} />
      </AppStoreProvider>,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "아이템 검색" }), {
      target: { value: "없는 아이템" },
    });
    expect(screen.getByText("조건에 맞는 아이템이 없습니다")).toBeInTheDocument();
  });

  it("selects and focuses an item handed off by the app", async () => {
    const focusedData: TarkovData = {
      ...data,
      meta: {
        ...data.meta,
        counts: { ...data.meta.counts, quests: 2, items: 2 },
      },
      quests: [
        ...data.quests,
        {
          ...data.quests[0],
          id: "wire-quest",
          normalizedName: "wire-quest",
          name: "Wire Run",
          nameEn: "Wire Run",
          nameKo: "전선 작전",
          requiredItems: [
            {
              id: "wire-requirement",
              itemId: "wires",
              itemName: "Wires",
              count: 1,
              requiresFir: false,
              requirementType: "handover",
              sortOrder: 0,
            },
          ],
        },
      ],
      items: [
        ...data.items,
        {
          id: "wires",
          name: "Wires",
          nameEn: "Wires",
          nameKo: "전선",
          category: "Electronics",
          categories: ["Electronics"],
          isDogtagItem: false,
        },
      ],
    };
    const onItemFocusConsumed = vi.fn();

    const view = render(
      <AppStoreProvider>
        <ItemsPage data={focusedData} />
      </AppStoreProvider>,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "아이템 검색" }), {
      target: { value: "볼트" },
    });
    expect(screen.queryByRole("button", { name: "전선 상세 보기" })).not.toBeInTheDocument();

    view.rerender(
      <AppStoreProvider>
        <ItemsPage
          data={focusedData}
          focusItemId="wires"
          onItemFocusConsumed={onItemFocusConsumed}
        />
      </AppStoreProvider>,
    );

    expect(screen.getByRole("searchbox", { name: "아이템 검색" })).toHaveValue("");
    const detail = screen.getByRole("complementary", { name: "아이템 상세" });
    expect(within(detail).getByRole("heading", { name: "전선" })).toBeInTheDocument();
    const selectedItem = screen.getByRole("button", { name: "전선 상세 보기" });
    expect(selectedItem).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(selectedItem).toHaveFocus());
    expect(onItemFocusConsumed).toHaveBeenCalledOnce();
  });

  it("shows a handed-off reference item even when its quest is not in the remaining aggregate", async () => {
    const onItemFocusConsumed = vi.fn();
    const unavailableData: TarkovData = {
      ...data,
      quests: data.quests.map((quest) => ({
        ...quest,
        requiredEdition: "eod",
      })),
    };

    render(
      <AppStoreProvider>
        <ItemsPage
          data={unavailableData}
          focusItemId="bolts"
          onItemFocusConsumed={onItemFocusConsumed}
        />
      </AppStoreProvider>,
    );

    expect(screen.getAllByText("0종")).toHaveLength(2);
    expect(screen.getByRole("img", { name: "참조 아이템" })).toBeInTheDocument();
    const detail = screen.getByRole("complementary", { name: "아이템 상세" });
    expect(within(detail).getByRole("heading", { name: "볼트" })).toBeInTheDocument();
    expect(within(detail).getByText("참조")).toBeInTheDocument();
    expect(within(detail).getByText("현재 남은 요구 사항 없음")).toBeInTheDocument();
    await waitFor(() => expect(onItemFocusConsumed).toHaveBeenCalledOnce());
  });
});
