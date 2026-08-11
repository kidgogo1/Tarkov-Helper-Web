import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/app/App";
import { AppStoreProvider } from "../../src/app/store";
import type { TarkovData } from "../../src/types/data";

const dataMocks = vi.hoisted(() => ({
  loadTarkovData: vi.fn(),
}));

vi.mock("../../src/app/data", () => ({
  loadTarkovData: dataMocks.loadTarkovData,
}));

const data: TarkovData = {
  meta: {
    originalCommit: "original",
    modifiedCommit: "modified",
    exportedAt: "2026-08-07T00:00:00Z",
    counts: { quests: 3, items: 2, hideoutStations: 2, maps: 0, mapMarkers: 0 },
  },
  quests: [
    {
      id: "main-quest",
      normalizedName: "main-quest",
      name: "Main Quest",
      nameEn: "Main Quest",
      nameKo: "주요 임무",
      trader: "Therapist",
      locations: [],
      kappaRequired: false,
      requirements: [],
      alternativeQuestIds: [],
      followUpQuestIds: ["follow-up"],
      objectives: [],
      requiredItems: [
        {
          id: "salewa-requirement",
          itemId: "salewa",
          itemName: "Salewa",
          count: 1,
          requiresFir: true,
          requirementType: "handover",
          sortOrder: 0,
        },
      ],
    },
    {
      id: "follow-up",
      normalizedName: "follow-up",
      name: "Follow Up",
      nameEn: "Follow Up",
      nameKo: "후속 임무",
      trader: "Therapist",
      locations: [],
      kappaRequired: false,
      requirements: [],
      alternativeQuestIds: [],
      followUpQuestIds: [],
      objectives: [],
      requiredItems: [],
    },
    {
      id: "target-quest",
      normalizedName: "target-quest",
      name: "Target Quest",
      nameEn: "Target Quest",
      nameKo: "목표 임무",
      trader: "Prapor",
      locations: [],
      kappaRequired: false,
      requirements: [],
      alternativeQuestIds: [],
      followUpQuestIds: [],
      objectives: [],
      requiredItems: [
        {
          id: "bolts-requirement",
          itemId: "bolts",
          itemName: "Bolts",
          count: 2,
          requiresFir: false,
          requirementType: "handover",
          sortOrder: 0,
        },
      ],
    },
  ],
  items: [
    {
      id: "salewa",
      name: "Salewa",
      nameEn: "Salewa",
      nameKo: "살레와 구급낭",
      category: "Medical supplies",
      categories: ["Medical supplies"],
      isDogtagItem: false,
    },
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
  hideoutStations: [
    {
      id: "medstation",
      name: "Medstation",
      normalizedName: "medstation",
      maxLevel: 1,
      levels: [
        {
          id: "medstation-level-1",
          level: 1,
          constructionTime: 0,
          items: [
            {
              id: "medstation-salewa",
              itemId: "salewa",
              itemName: "Salewa",
              count: 1,
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
    {
      id: "station-workbench-id",
      name: "Workbench",
      normalizedName: "workbench",
      maxLevel: 2,
      levels: [
        {
          id: "workbench-level-1",
          level: 1,
          constructionTime: 0,
          items: [],
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
  traders: [],
  mapConfigs: [],
  mapMarkers: [],
  mapFloorLocations: [],
};

function renderApp() {
  return render(
    <AppStoreProvider>
      <App />
    </AppStoreProvider>,
  );
}

describe("App related navigation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "#/quests");
    dataMocks.loadTarkovData.mockReset();
    dataMocks.loadTarkovData.mockResolvedValue(data);
  });

  it("restores the selected item from an item deep link", async () => {
    window.history.replaceState(null, "", "#/items?item=bolts");

    renderApp();

    expect(await screen.findByRole("tab", { name: "아이템" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const itemDetail = await screen.findByRole("complementary", { name: "아이템 상세" });
    expect(within(itemDetail).getByRole("heading", { name: "볼트" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "볼트 상세 보기" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("opens the exact non-default quest source and Back restores the originating item", async () => {
    renderApp();

    fireEvent.click(await screen.findByRole("tab", { name: "아이템" }));
    fireEvent.click(screen.getByRole("button", { name: "볼트 상세 보기" }));
    const itemDetail = await screen.findByRole("complementary", { name: "아이템 상세" });
    expect(within(itemDetail).getByRole("heading", { name: "볼트" })).toBeInTheDocument();
    fireEvent.click(
      within(itemDetail).getByRole("button", { name: "Target Quest 퀘스트 열기" }),
    );

    expect(screen.getByRole("tab", { name: "퀘스트" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const questDetail = await screen.findByRole("article", { name: "퀘스트 상세" });
    expect(within(questDetail).getByRole("heading", { name: "목표 임무" })).toBeInTheDocument();
    const targetQuestButton = within(screen.getByRole("region", { name: "퀘스트 목록" }))
      .getByText("목표 임무")
      .closest("button");
    expect(targetQuestButton).toHaveAttribute("aria-current", "true");
    expect(window.location.hash).toBe("#/quests?quest=target-quest");

    window.history.back();

    await waitFor(() => expect(window.location.hash).toBe("#/items?item=bolts"));
    expect(screen.getByRole("tab", { name: "아이템" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const restoredItemDetail = await screen.findByRole("complementary", {
      name: "아이템 상세",
    });
    expect(within(restoredItemDetail).getByRole("heading", { name: "볼트" }))
      .toBeInTheDocument();

    window.history.forward();

    await waitFor(() => expect(window.location.hash).toBe("#/quests?quest=target-quest"));
    const restoredQuestDetail = await screen.findByRole("article", { name: "퀘스트 상세" });
    expect(within(restoredQuestDetail).getByRole("heading", { name: "목표 임무" }))
      .toBeInTheDocument();
  });

  it("keeps the current item search when its selected row is reflected in the URL", async () => {
    window.history.replaceState(null, "", "#/items");
    renderApp();

    const search = await screen.findByRole("searchbox", { name: "아이템 검색" });
    search.focus();
    fireEvent.change(search, { target: { value: "볼트" } });
    fireEvent.click(screen.getByRole("button", { name: "볼트 상세 보기" }));

    expect(search).toHaveValue("볼트");
    expect(window.location.hash).toBe("#/items?item=bolts");
    expect(search).toHaveFocus();
  });

  it("keeps the visible fallback item and its URL synchronized after filtering", async () => {
    window.history.replaceState(null, "", "#/items?item=salewa");
    renderApp();

    const search = await screen.findByRole("searchbox", { name: "아이템 검색" });
    fireEvent.change(search, { target: { value: "볼트" } });

    const itemDetail = await screen.findByRole("complementary", { name: "아이템 상세" });
    expect(within(itemDetail).getByRole("heading", { name: "볼트" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe("#/items?item=bolts"));
  });

  it("keeps the prior item selection when a search temporarily has no results", async () => {
    window.history.replaceState(
      {
        schemaVersion: 1,
        navigationIntent: "selection",
        route: "#/items?item=salewa",
      },
      "",
      "#/items?item=salewa",
    );
    renderApp();

    const search = await screen.findByRole("searchbox", { name: "아이템 검색" });
    fireEvent.change(search, { target: { value: "검색 결과 없음" } });
    expect(window.location.hash).toBe("#/items?item=salewa");

    fireEvent.change(search, { target: { value: "" } });
    const itemDetail = await screen.findByRole("complementary", { name: "아이템 상세" });
    expect(within(itemDetail).getByRole("heading", { name: "살레와 구급낭" }))
      .toBeInTheDocument();
  });

  it("opens the exact non-default hideout station and source level", async () => {
    renderApp();

    fireEvent.click(await screen.findByRole("tab", { name: "아이템" }));
    fireEvent.click(screen.getByRole("button", { name: "볼트 상세 보기" }));
    const itemDetail = await screen.findByRole("complementary", { name: "아이템 상세" });
    expect(within(itemDetail).getByRole("heading", { name: "볼트" })).toBeInTheDocument();
    fireEvent.click(
      within(itemDetail).getByRole("button", { name: "Workbench 은신처 열기" }),
    );

    expect(screen.getByRole("tab", { name: "은신처" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await screen.findByRole("heading", { name: "Workbench" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Workbench" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("heading", { name: "레벨 2" })).toBeInTheDocument();
    expect(window.location.hash).toBe(
      "#/hideout?station=station-workbench-id&level=2",
    );
    expect(screen.getByRole("region", { name: "레벨 2" })).toHaveFocus();
  });

  it("canonicalizes a hideout slug without dropping its valid source level", async () => {
    window.history.replaceState(null, "", "#/hideout?station=workbench&level=2");
    renderApp();

    expect(await screen.findByRole("heading", { name: "Workbench" })).toBeInTheDocument();
    await waitFor(() =>
      expect(window.location.hash).toBe(
        "#/hideout?station=station-workbench-id&level=2",
      ),
    );
    expect(screen.getByRole("region", { name: "레벨 2" })).toHaveFocus();
  });

  it("removes an invalid hideout level while keeping the matched station", async () => {
    window.history.replaceState(null, "", "#/hideout?station=workbench&level=99");
    renderApp();

    expect(await screen.findByRole("heading", { name: "Workbench" })).toBeInTheDocument();
    await waitFor(() =>
      expect(window.location.hash).toBe("#/hideout?station=station-workbench-id"),
    );
  });

  it("selects a related quest without leaving the quests tab", async () => {
    renderApp();
    const detail = await screen.findByRole("article", { name: "퀘스트 상세" });
    await waitFor(() => expect(window.location.hash).toBe("#/quests?quest=main-quest"));
    const questList = screen.getByRole("region", { name: "퀘스트 목록" });
    const mainQuestButton = within(questList).getByText("주요 임무").closest("button")!;

    fireEvent.click(within(detail).getByRole("button", { name: "후속 임무" }));

    await waitFor(() =>
      expect(within(detail).getByRole("heading", { name: "후속 임무" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: "퀘스트" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    window.history.back();

    await waitFor(() => expect(window.location.hash).toBe("#/quests?quest=main-quest"));
    expect(within(detail).getByRole("heading", { name: "주요 임무" })).toBeInTheDocument();
    await waitFor(() => expect(mainQuestButton).toHaveFocus());
  });

  it("does not keep the selected quest as a false search result", async () => {
    renderApp();
    await waitFor(() => expect(window.location.hash).toBe("#/quests?quest=main-quest"));

    fireEvent.change(screen.getByRole("searchbox", { name: "퀘스트 검색" }), {
      target: { value: "존재하지 않는 퀘스트" },
    });

    const questList = screen.getByRole("region", { name: "퀘스트 목록" });
    await waitFor(() => expect(within(questList).queryAllByRole("button")).toHaveLength(0));
  });

  it("restores a non-default quest after a temporary zero-result search", async () => {
    window.history.replaceState(
      {
        schemaVersion: 1,
        navigationIntent: "selection",
        route: "#/quests?quest=target-quest",
      },
      "",
      "#/quests?quest=target-quest",
    );
    renderApp();

    const search = await screen.findByRole("searchbox", { name: "퀘스트 검색" });
    const detail = screen.getByRole("article", { name: "퀘스트 상세" });
    expect(within(detail).getByRole("heading", { name: "목표 임무" })).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "검색 결과 없음" } });
    expect(window.location.hash).toBe("#/quests?quest=target-quest");

    fireEvent.change(search, { target: { value: "" } });
    const restoredDetail = await screen.findByRole("article", { name: "퀘스트 상세" });
    expect(within(restoredDetail).getByRole("heading", { name: "목표 임무" }))
      .toBeInTheDocument();
    expect(window.location.hash).toBe("#/quests?quest=target-quest");
  });

  it("switches to Items and focuses a required item", async () => {
    renderApp();
    const detail = await screen.findByRole("article", { name: "퀘스트 상세" });

    fireEvent.click(within(detail).getByRole("button", { name: /살레와 구급낭/ }));

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "아이템" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    const itemDetail = screen.getByRole("complementary", { name: "아이템 상세" });
    expect(within(itemDetail).getByRole("heading", { name: "살레와 구급낭" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "살레와 구급낭 상세 보기" })).toHaveFocus();
  });
});
