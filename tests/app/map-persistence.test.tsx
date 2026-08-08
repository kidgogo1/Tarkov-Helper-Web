import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/app/App";
import { AppStoreProvider } from "../../src/app/store";
import type { TarkovData } from "../../src/types/data";

const fixtures = vi.hoisted(() => ({
  loadTarkovData: vi.fn(),
  mapMounts: 0,
  mapUnmounts: 0,
}));

vi.mock("../../src/app/data", () => ({
  loadTarkovData: fixtures.loadTarkovData,
}));

vi.mock("../../src/features/map/MapPage", () => ({
  MapPage: () => {
    useEffect(() => {
      fixtures.mapMounts += 1;
      return () => {
        fixtures.mapUnmounts += 1;
      };
    }, []);
    return <div data-testid="persistent-map-page" />;
  },
}));

vi.mock("../../src/features/quests/QuestsPage", () => ({
  QuestsPage: () => <div data-testid="quests-page" />,
}));
vi.mock("../../src/features/hideout/HideoutPage", () => ({
  HideoutPage: () => <div data-testid="hideout-page" />,
}));
vi.mock("../../src/features/items/ItemsPage", () => ({
  ItemsPage: () => <div data-testid="items-page" />,
}));
vi.mock("../../src/features/collector/CollectorPage", () => ({
  CollectorPage: () => <div data-testid="collector-page" />,
}));

const data: TarkovData = {
  meta: {
    originalCommit: "original",
    modifiedCommit: "modified",
    exportedAt: "2026-08-09T00:00:00Z",
    counts: { quests: 0, items: 0, hideoutStations: 0, maps: 0, mapMarkers: 0 },
  },
  quests: [],
  items: [],
  hideoutStations: [],
  traders: [],
  mapConfigs: [],
  mapMarkers: [],
  mapFloorLocations: [],
};

describe("map mini-map persistence across app tabs", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "#/quests");
    fixtures.loadTarkovData.mockReset();
    fixtures.loadTarkovData.mockResolvedValue(data);
    fixtures.mapMounts = 0;
    fixtures.mapUnmounts = 0;
  });

  it("keeps MapPage mounted when moving from map to another menu", async () => {
    render(
      <AppStoreProvider>
        <App />
      </AppStoreProvider>,
    );

    await waitFor(() => expect(document.getElementById("app-tab-map")).toBeInTheDocument());
    fireEvent.click(document.getElementById("app-tab-map")!);
    expect(await screen.findByTestId("persistent-map-page")).toBeInTheDocument();
    expect(fixtures.mapMounts).toBe(1);

    fireEvent.click(document.getElementById("app-tab-items")!);
    expect(screen.getByTestId("persistent-map-page")).toBeInTheDocument();
    expect(screen.getByTestId("items-page")).toBeInTheDocument();
    expect(fixtures.mapMounts).toBe(1);
    expect(fixtures.mapUnmounts).toBe(0);
  });
});
