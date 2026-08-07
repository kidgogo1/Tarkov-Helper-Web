import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { AppStoreProvider } from "../../src/app/store";
import { HideoutPage } from "../../src/features/hideout/HideoutPage";
import type { TarkovData } from "../../src/types/data";

const data: TarkovData = {
  meta: {
    originalCommit: "original",
    modifiedCommit: "modified",
    exportedAt: "2026-08-07T00:00:00Z",
    counts: { quests: 0, items: 1, hideoutStations: 1, maps: 0, mapMarkers: 0 },
  },
  quests: [],
  items: [
    {
      id: "bolts",
      name: "Bolts",
      nameEn: "Bolts",
      nameKo: "볼트",
      categories: ["Building materials"],
      isDogtagItem: false,
    },
  ],
  hideoutStations: [
    {
      id: "workbench",
      name: "Workbench",
      nameKo: "작업대",
      normalizedName: "workbench",
      maxLevel: 2,
      levels: [
        {
          id: "workbench-1",
          level: 1,
          constructionTime: 60,
          items: [
            {
              id: "bolt-req",
              itemId: "bolts",
              itemName: "Bolts",
              itemNameKo: "볼트",
              count: 2,
              foundInRaid: false,
              sortOrder: 0,
            },
          ],
          stations: [],
          traders: [],
          skills: [],
        },
        {
          id: "workbench-2",
          level: 2,
          constructionTime: 120,
          items: [],
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

describe("HideoutPage", () => {
  beforeEach(() => window.localStorage.clear());

  it("tracks station levels and reflects future requirements", () => {
    render(
      <AppStoreProvider>
        <HideoutPage data={data} />
      </AppStoreProvider>,
    );

    expect(screen.getByText("볼트")).toBeInTheDocument();
    const stationList = screen.getByLabelText("은신처 시설 목록");
    expect(within(stationList).getByText("0 / 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "작업대 레벨 증가" }));
    expect(within(stationList).getByText("1 / 2")).toBeInTheDocument();
    expect(screen.queryByText("볼트")).not.toBeInTheDocument();
  });

  it("edits the shared inventory from an item requirement", () => {
    render(
      <AppStoreProvider>
        <HideoutPage data={data} />
      </AppStoreProvider>,
    );

    const requirement = screen.getByTestId("hideout-item-bolts");
    fireEvent.click(within(requirement).getByRole("button", { name: "볼트 보유량 증가" }));
    expect(within(requirement).getByText("1 / 2 보유")).toBeInTheDocument();
  });
});
