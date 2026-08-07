import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { AppStoreProvider } from "../../src/app/store";
import { CollectorPage } from "../../src/features/collector/CollectorPage";
import type { QuestData, TarkovData } from "../../src/types/data";

function quest(id: string, overrides: Partial<QuestData> = {}): QuestData {
  return {
    id,
    normalizedName: id,
    name: id,
    nameEn: id,
    trader: "Fence",
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

const collectorData: TarkovData = {
  meta: {
    originalCommit: "original",
    modifiedCommit: "modified",
    exportedAt: "2026-08-07T00:00:00Z",
    counts: { quests: 2, items: 2, hideoutStations: 0, maps: 0, mapMarkers: 0 },
  },
  quests: [
    quest("collector-id", {
      normalizedName: "collector",
      name: "Collector",
      nameEn: "Collector",
      nameKo: "컬렉터",
      kappaRequired: true,
      requirements: [
        { questId: "preparation", requirementType: "complete", groupId: 0 },
      ],
      requiredItems: [
        {
          id: "collector-item",
          itemId: "rare-item",
          itemName: "Rare collectible",
          count: 1,
          requiresFir: true,
          requirementType: "handover",
          sortOrder: 0,
        },
      ],
    }),
    quest("preparation", {
      name: "Preparation",
      nameEn: "Preparation",
      nameKo: "선행 준비",
      trader: "Ragman",
      requiredItems: [
        {
          id: "preparation-item",
          itemId: "prep-item",
          itemName: "Preparation item",
          count: 2,
          requiresFir: false,
          requirementType: "handover",
          sortOrder: 0,
        },
      ],
    }),
  ],
  items: [
    {
      id: "rare-item",
      name: "Rare collectible",
      nameEn: "Rare collectible",
      nameKo: "수집품",
      category: "Valuables",
      categories: ["Valuables"],
      isDogtagItem: false,
    },
    {
      id: "prep-item",
      name: "Preparation item",
      nameEn: "Preparation item",
      nameKo: "준비물",
      category: "Tools",
      categories: ["Tools"],
      isDogtagItem: false,
    },
  ],
  hideoutStations: [],
  traders: [],
  mapConfigs: [],
  mapMarkers: [],
  mapFloorLocations: [],
};

function renderCollector() {
  render(
    <AppStoreProvider>
      <CollectorPage data={collectorData} />
    </AppStoreProvider>,
  );
}

describe("CollectorPage", () => {
  beforeEach(() => window.localStorage.clear());

  it("starts with Collector-only items and optionally adds recursive prerequisites", () => {
    renderCollector();

    expect(screen.getAllByText("수집품").length).toBeGreaterThan(0);
    expect(screen.queryByText("준비물")).not.toBeInTheDocument();
    const detail = screen.getByRole("complementary", { name: "아이템 상세" });
    expect(within(detail).getByText("Collector")).toBeInTheDocument();
    expect(within(detail).getByText("카파 필수")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "선행 퀘스트 포함" }));
    expect(screen.getAllByText("준비물").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "준비물 상세 보기" }));
    expect(within(detail).getByText("Preparation")).toBeInTheDocument();
  });

  it("shares FIR inventory editing and fulfillment filters with the item tracker", () => {
    renderCollector();

    fireEvent.click(screen.getByRole("button", { name: "수집품 FIR 보유량 증가" }));
    expect(screen.getByText("보유 1F")).toBeInTheDocument();
    expect(screen.getByText("충족")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "충족 상태" }), {
      target: { value: "fulfilled" },
    });
    expect(screen.getByRole("button", { name: "수집품 상세 보기" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "충족 숨기기" }));
    expect(screen.getByText("조건에 맞는 아이템이 없습니다")).toBeInTheDocument();
  });
});
