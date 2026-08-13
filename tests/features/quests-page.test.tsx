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
  nameAliases: ["Old Operation Aquarius"],
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
    quest("q-prep", {
      nameKo: "사전 작업",
      nameEn: "Preparation",
      rewardItems: [
        {
          id: "reward-salewa",
          itemId: "item-salewa",
          itemName: "Salewa first aid kit",
          count: 1,
          sortOrder: 0,
        },
      ],
    }),
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
    quest("q-easy-a", {
      nameKo: "쉬운 임무 A",
      nameEn: "Easy A",
      faction: "bear",
    }),
    quest("q-easy-b", {
      nameKo: "쉬운 임무 B",
      nameEn: "Easy B",
      trader: "Skier",
      faction: "usec",
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
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Salewa_first_aid_kit",
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

function QuestFailureControl({ questId }: { questId: string }) {
  const { setQuestStatus } = useAppStore();
  return (
    <button onClick={() => setQuestStatus(questId, "failed")} type="button">
      외부에서 실패 처리
    </button>
  );
}

function renderPage(onOpenMap = vi.fn(), focusQuestId?: string) {
  render(
    <AppStoreProvider>
      <QuestsPage
        data={testData}
        focusQuestId={focusQuestId}
        onOpenMap={onOpenMap}
      />
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

  it("shows statistics, then filters the dense quest list", () => {
    renderPage();

    expect(screen.getByRole("heading", { level: 1, name: "퀘스트" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("article", { name: "퀘스트 상세" })).getByText(
        "물병자리 작전",
      ),
    ).toBeInTheDocument();

    const statistics = screen.getByRole("region", { name: "전체 퀘스트 통계" });
    expect(within(statistics).getByText("전체")).toBeInTheDocument();
    expect(within(statistics).getByText("7")).toBeInTheDocument();

    const list = screen.getByRole("region", { name: "퀘스트 목록" });
    expect(screen.getByRole("combobox", { name: "상태" })).toHaveValue("all");
    fireEvent.change(screen.getByRole("combobox", { name: "상태" }), {
      target: { value: "all" },
    });
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

  it("switches quest names between Korean and English while searching both languages", () => {
    renderPage();

    const language = screen.getByRole("group", { name: "퀘스트 언어" });
    expect(within(language).getByRole("button", { name: "한국어" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(within(language).getByRole("button", { name: "English" }));

    expect(screen.getByRole("heading", { name: "Operation Aquarius" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "퀘스트 검색" }), {
      target: { value: "Preparation" },
    });
    expect(
      within(screen.getByRole("region", { name: "퀘스트 목록" })).getByRole(
        "button",
        { name: /Preparation/ },
      ),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "퀘스트 검색" }), {
      target: { value: "사전 작업" },
    });
    expect(
      within(screen.getByRole("region", { name: "퀘스트 목록" })).getByRole(
        "button",
        { name: /Preparation/ },
      ),
    ).toBeInTheDocument();
  });

  it("filters quests by Korean and English reward names below the quest name search", () => {
    renderPage();

    const list = screen.getByRole("region", { name: "퀘스트 목록" });
    const rewardSearch = screen.getByRole("searchbox", { name: "보상 검색" });

    fireEvent.change(rewardSearch, { target: { value: "살레와" } });
    expect(within(list).getByRole("button", { name: /사전 작업/ })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /물병자리 작전/ })).not.toBeInTheDocument();

    fireEvent.change(rewardSearch, { target: { value: "Salewa" } });
    expect(within(list).getByRole("button", { name: /사전 작업/ })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "퀘스트 검색" }), {
      target: { value: "물병자리" },
    });
    expect(within(list).queryByRole("button")).not.toBeInTheDocument();
  });

  it("filters quests by the items that must be submitted", () => {
    renderPage();

    const list = screen.getByRole("region", { name: "퀘스트 목록" });
    const itemSearch = screen.getByRole("searchbox", { name: "제출 아이템 검색" });

    fireEvent.change(itemSearch, { target: { value: "Salewa" } });
    expect(within(list).getByRole("button", { name: /Operation Aquarius/ })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /Preparation/ })).not.toBeInTheDocument();

    fireEvent.change(itemSearch, { target: { value: "does-not-exist" } });
    expect(within(list).queryByRole("button")).not.toBeInTheDocument();
  });

  it("finds quests by the stored legacy name and shows that alias in the result", () => {
    renderPage();

    fireEvent.change(screen.getByRole("searchbox", { name: "퀘스트 검색" }), {
      target: { value: "Old Operation Aquarius" },
    });

    expect(screen.getByRole("button", { name: /Operation Aquarius/ })).toBeInTheDocument();
    expect(screen.getAllByText(/Old Operation Aquarius/).length).toBeGreaterThan(0);
  });

  it("does not render the recommended quests section", () => {
    renderPage();

    expect(
      screen.queryByRole("region", { name: "추천 퀘스트" }),
    ).not.toBeInTheDocument();
  });

  it("connects quest details, inventory, progress, faction, wiki, and map actions", () => {
    const state = createDefaultState();
    state.profiles.pvp.inventory["item-salewa"] = { fir: 2, nonFir: 0 };
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
    const onOpenMap = vi.fn();
    renderPage(onOpenMap, "q-main");

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
    const confirmation = screen.getByRole("dialog", {
      name: "대안 퀘스트 실패 처리 확인",
    });
    expect(within(confirmation).getByText("대안 임무")).toBeInTheDocument();
    expect(readProfile().questProgress["q-main"]).toBeUndefined();
    fireEvent.click(within(confirmation).getByRole("button", { name: "취소" }));
    expect(readProfile().questProgress["q-main"]).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "퀘스트 완료" }));
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "대안 퀘스트 실패 처리 확인" }),
      ).getByRole("button", {
        name: "완료하고 대안 실패 처리",
      }),
    );
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

    expect(screen.getByRole("link", { name: "위키 열기" })).toHaveAttribute(
      "href",
      "https://example.test/wiki/operation-aquarius",
    );
    fireEvent.click(screen.getByRole("button", { name: "지도에서 보기" }));
    expect(onOpenMap).toHaveBeenCalledWith("customs", "q-main");

    fireEvent.click(screen.getByRole("button", { name: "BEAR" }));
    expect(readProfile().faction).toBe("bear");
  });

  it("starts with all quest statuses and hides only the opposite faction after a faction is selected", () => {
    renderPage();

    const list = screen.getByRole("region", { name: "퀘스트 목록" });
    expect(screen.getByRole("combobox", { name: "상태" })).toHaveValue("all");
    expect(within(list).getByRole("button", { name: /물병자리 작전/ })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /쉬운 임무 A/ })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /쉬운 임무 B/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "USEC" }));
    expect(within(list).queryByRole("button", { name: /쉬운 임무 A/ })).not.toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /쉬운 임무 B/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "BEAR" }));
    expect(within(list).getByRole("button", { name: /쉬운 임무 A/ })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /쉬운 임무 B/ })).not.toBeInTheDocument();
  });

  it("shows the first filtered quest instead of keeping a selection outside the result", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "물병자리 작전" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "퀘스트 검색" }), {
      target: { value: "결과 없음" },
    });
    expect(screen.queryByRole("article", { name: "퀘스트 상세" })).not.toBeInTheDocument();
    expect(screen.getByText("표시할 퀘스트가 없습니다.")).toBeInTheDocument();
  });

  it("includes opposite-faction quests when filtering unavailable quests", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "USEC" }));
    fireEvent.change(screen.getByRole("combobox", { name: "상태" }), {
      target: { value: "unavailable" },
    });

    expect(
      within(screen.getByRole("region", { name: "퀘스트 목록" })).getByRole(
        "button",
        { name: /쉬운 임무 A/ },
      ),
    ).toBeInTheDocument();
  });

  it.each(["done", "failed"] as const)(
    "does not warn again for an alternative quest that is already %s",
    (terminalStatus) => {
      const state = createDefaultState();
      state.profiles.pvp.questProgress["q-alt"] = terminalStatus;
      window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
      renderPage(vi.fn(), "q-main");

      fireEvent.click(screen.getByRole("button", { name: "퀘스트 완료" }));

      expect(
        screen.queryByRole("dialog", { name: "대안 퀘스트 실패 처리 확인" }),
      ).not.toBeInTheDocument();
      expect(readProfile().questProgress).toMatchObject({
        "q-alt": terminalStatus,
        "q-main": "done",
      });
    },
  );

  it("rechecks status before confirming a pending completion", () => {
    render(
      <AppStoreProvider>
        <QuestsPage
          data={testData}
          focusQuestId="q-main"
          onOpenMap={vi.fn()}
        />
        <QuestFailureControl questId="q-main" />
        <StoreProbe />
      </AppStoreProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "퀘스트 완료" }));
    const confirmation = screen.getByRole("dialog", {
      name: "대안 퀘스트 실패 처리 확인",
    });
    fireEvent.click(screen.getByRole("button", { name: "외부에서 실패 처리" }));
    fireEvent.click(
      within(confirmation).getByRole("button", {
        name: "완료하고 대안 실패 처리",
      }),
    );

    expect(readProfile().questProgress["q-main"]).toBe("failed");
  });

  it("shows scav karma and dogtag conditions and preserves unavailable item handoff", () => {
    const metadataQuest = quest("q-meta", {
      nameKo: "인식표 검사",
      minScavKarma: 2,
      requiredEdition: "eod",
      objectives: [
        {
          id: "objective-dogtag",
          sortOrder: 0,
          objectiveType: "handover",
          description: "인식표 제출",
          requiresFir: false,
          locationPoints: [],
          optionalPoints: [],
          dogtagMinLevel: 15,
          dogtagFaction: "usec",
        },
      ],
      requiredItems: [
        {
          id: "requirement-dogtag",
          itemId: "item-salewa",
          itemName: "Salewa first aid kit",
          count: 1,
          requiresFir: false,
          requirementType: "handover",
          sortOrder: 0,
          dogtagMinLevel: 20,
          dogtagFaction: "bear",
        },
      ],
    });
    const onOpenItem = vi.fn();
    render(
      <AppStoreProvider>
        <QuestsPage
          data={{ ...testData, quests: [metadataQuest] }}
          focusQuestId="q-meta"
          onOpenItem={onOpenItem}
          onOpenMap={vi.fn()}
        />
      </AppStoreProvider>,
    );

    expect(screen.getByText("요구 2.00 이상")).toBeInTheDocument();
    expect(screen.getByText("현재 1.00 · 미충족")).toBeInTheDocument();
    expect(screen.getByText("인식표 조건 · USEC · 레벨 15 이상")).toBeInTheDocument();
    expect(screen.getByText("인식표 조건 · BEAR · 레벨 20 이상")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "퀘스트 완료" })).toBeDisabled();
    const itemButton = screen.getByRole("button", { name: /살레와 구급낭/ });
    expect(itemButton).toBeEnabled();
    fireEvent.click(itemButton);
    expect(onOpenItem).toHaveBeenCalledWith("item-salewa");
  });

  it.each(["done", "failed"] as const)(
    "%s quest preserves its item handoff",
    (terminalStatus) => {
      const state = createDefaultState();
      state.profiles.pvp.questProgress["q-main"] = terminalStatus;
      window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
      const onOpenItem = vi.fn();
      render(
        <AppStoreProvider>
          <QuestsPage
            data={testData}
            focusQuestId="q-main"
            onOpenItem={onOpenItem}
            onOpenMap={vi.fn()}
          />
          <StoreProbe />
        </AppStoreProvider>,
      );

      const itemButton = screen.getByRole("button", { name: /살레와 구급낭/ });
      expect(itemButton).toBeEnabled();
      expect(screen.getByRole("button", { name: "퀘스트 완료" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "퀘스트 완료" }));
      expect(readProfile().questProgress["q-main"]).toBe(terminalStatus);
      fireEvent.click(itemButton);
      expect(onOpenItem).toHaveBeenCalledWith("item-salewa");
    },
  );

  it("allows a level-locked quest to be completed", () => {
    const levelLockedQuest = quest("q-level", {
      nameKo: "고레벨 임무",
      minLevel: 99,
    });
    render(
      <AppStoreProvider>
        <QuestsPage
          data={{ ...testData, quests: [levelLockedQuest] }}
          focusQuestId="q-level"
          onOpenMap={vi.fn()}
        />
        <StoreProbe />
      </AppStoreProvider>,
    );

    const completeButton = screen.getByRole("button", { name: "퀘스트 완료" });
    expect(completeButton).toBeEnabled();
    fireEvent.click(completeButton);
    expect(readProfile().questProgress["q-level"]).toBe("done");
  });

  it("exposes related quests and required items as navigation actions", () => {
    const onOpenQuest = vi.fn();
    const onOpenItem = vi.fn();
    render(
      <AppStoreProvider>
        <QuestsPage
          data={testData}
          focusQuestId="q-main"
          onOpenItem={onOpenItem}
          onOpenMap={vi.fn()}
          onOpenQuest={onOpenQuest}
        />
      </AppStoreProvider>,
    );

    const detail = screen.getByRole("article", { name: "퀘스트 상세" });
    fireEvent.click(within(detail).getByRole("button", { name: /사전 작업/ }));
    expect(onOpenQuest).toHaveBeenLastCalledWith("q-prep");

    const alternatives = within(detail).getByRole("heading", { name: "대안 퀘스트" })
      .closest("section")!;
    fireEvent.click(within(alternatives).getByRole("button", { name: /대안 임무/ }));
    expect(onOpenQuest).toHaveBeenLastCalledWith("q-alt");

    const followUps = within(detail).getByRole("heading", { name: "후속 퀘스트" })
      .closest("section")!;
    fireEvent.click(within(followUps).getByRole("button", { name: /후속 임무/ }));
    expect(onOpenQuest).toHaveBeenLastCalledWith("q-follow");

    fireEvent.click(within(detail).getByRole("button", { name: /살레와 구급낭/ }));
    expect(onOpenItem).toHaveBeenCalledWith("item-salewa");
  });

  it("opens a required item's exact Wiki page in a separate safe tab", () => {
    renderPage(vi.fn(), "q-main");

    const detail = screen.getByRole("article", { name: "퀘스트 상세" });
    const requiredItems = within(detail)
      .getByRole("heading", { name: "필수 아이템" })
      .closest("section")!;
    const wikiLink = within(requiredItems).getByRole("link", {
      name: "살레와 구급낭 위키 열기",
    });

    expect(wikiLink).toHaveAttribute(
      "href",
      "https://escapefromtarkov.fandom.com/wiki/Salewa_first_aid_kit",
    );
    expect(wikiLink).toHaveAttribute("target", "_blank");
    expect(wikiLink.getAttribute("rel")?.split(/\s+/)).toEqual(
      expect.arrayContaining(["noopener", "noreferrer"]),
    );
  });

  it("keeps required-item navigation without showing a made-up Wiki link", () => {
    const onOpenItem = vi.fn();
    render(
      <AppStoreProvider>
        <QuestsPage
          data={{
            ...testData,
            items: [{ ...testData.items[0], wikiPageLink: undefined }],
          }}
          focusQuestId="q-main"
          onOpenItem={onOpenItem}
          onOpenMap={vi.fn()}
        />
      </AppStoreProvider>,
    );

    const detail = screen.getByRole("article", { name: "퀘스트 상세" });
    const requiredItems = within(detail)
      .getByRole("heading", { name: "필수 아이템" })
      .closest("section")!;

    expect(
      within(requiredItems).queryByRole("link", { name: /살레와 구급낭 위키 열기/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(requiredItems).getByRole("button", { name: /살레와 구급낭/ }));
    expect(onOpenItem).toHaveBeenCalledWith("item-salewa");
  });

  it("lets the user choose quests for the independent quest window", () => {
    renderPage(vi.fn(), "q-main");

    const detail = screen.getByRole("article", { name: "퀘스트 상세" });
    const tracked = within(detail).getByRole("checkbox", { name: "퀘스트 창에 표시" });
    expect(tracked).not.toBeChecked();

    fireEvent.click(tracked);
    expect(readProfile().trackedQuestIds).toEqual(["q-main"]);
    expect(tracked).toBeChecked();

    fireEvent.click(tracked);
    expect(readProfile().trackedQuestIds).toEqual([]);
  });

  it("resets filters and selects a quest handed off by the app", () => {
    const onQuestFocusConsumed = vi.fn();
    const view = render(
      <AppStoreProvider>
        <QuestsPage data={testData} onOpenMap={vi.fn()} />
      </AppStoreProvider>,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "퀘스트 검색" }), {
      target: { value: "물병자리" },
    });
    const questList = screen.getByRole("region", { name: "퀘스트 목록" });
    expect(within(questList).queryByRole("button", { name: /후속 임무/ })).not.toBeInTheDocument();

    view.rerender(
      <AppStoreProvider>
        <QuestsPage
          data={testData}
          focusQuestId="q-follow"
          onOpenMap={vi.fn()}
          onQuestFocusConsumed={onQuestFocusConsumed}
        />
      </AppStoreProvider>,
    );

    expect(screen.getByRole("searchbox", { name: "퀘스트 검색" })).toHaveValue("");
    expect(screen.getByRole("heading", { name: "후속 임무" })).toBeInTheDocument();
    expect(within(questList).getByRole("button", { name: /후속 임무/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(onQuestFocusConsumed).toHaveBeenCalledOnce();
  });

  it("reveals a terminal quest handed off on the initial render", () => {
    const state = createDefaultState();
    state.profiles.pvp.questProgress["q-main"] = "done";
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));

    render(
      <AppStoreProvider>
        <QuestsPage
          data={testData}
          focusQuestId="q-main"
          onOpenMap={vi.fn()}
        />
      </AppStoreProvider>,
    );

    expect(screen.getByRole("combobox", { name: "상태" })).toHaveValue("all");
    expect(
      within(screen.getByRole("region", { name: "퀘스트 목록" })).getByRole(
        "button",
        { name: /물병자리 작전/ },
      ),
    ).toHaveAttribute("aria-current", "true");
  });
});
