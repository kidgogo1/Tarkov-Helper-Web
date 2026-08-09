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
    counts: { quests: 2, items: 1, hideoutStations: 1, maps: 0, mapMarkers: 0 },
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
  ],
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
              id: "workbench-salewa",
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

  it("navigates from an item source to its quest or hideout station", async () => {
    renderApp();

    fireEvent.click(await screen.findByRole("tab", { name: "아이템" }));
    const itemDetail = await screen.findByRole("complementary", { name: "아이템 상세" });
    fireEvent.click(within(itemDetail).getByRole("button", { name: "Main Quest 퀘스트 열기" }));

    expect(screen.getByRole("tab", { name: "퀘스트" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("heading", { name: "주요 임무" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "아이템" }));
    const returnedItemDetail = await screen.findByRole("complementary", { name: "아이템 상세" });
    fireEvent.click(within(returnedItemDetail).getByRole("button", { name: "Workbench 은신처 열기" }));

    expect(screen.getByRole("tab", { name: "은신처" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("heading", { name: "Workbench" })).toBeInTheDocument();
  });

  it("selects a related quest without leaving the quests tab", async () => {
    renderApp();
    const detail = await screen.findByRole("article", { name: "퀘스트 상세" });

    fireEvent.click(within(detail).getByRole("button", { name: "후속 임무" }));

    await waitFor(() =>
      expect(within(detail).getByRole("heading", { name: "후속 임무" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: "퀘스트" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
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
