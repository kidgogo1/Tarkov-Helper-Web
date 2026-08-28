import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/app/App";
import { AppStoreProvider } from "../../src/app/store";
import type { QuestData, TarkovData } from "../../src/types/data";

const dataMocks = vi.hoisted(() => ({
  loadTarkovData: vi.fn(),
}));

vi.mock("../../src/app/data", () => ({
  loadTarkovData: dataMocks.loadTarkovData,
}));

function quest(id: string, nameKo: string, bsgId: string): QuestData {
  return {
    id,
    bsgId,
    normalizedName: id,
    name: id,
    nameEn: id,
    nameKo,
    trader: "Prapor",
    locations: [],
    kappaRequired: false,
    requirements: [],
    alternativeQuestIds: [],
    followUpQuestIds: [],
    objectives: [],
    requiredItems: [],
  };
}

const regularQuest = quest("regular-quest", "레귤러 임무", "bsg-regular");
const pvpSeasonQuest = quest("season-quest", "시즌 임무", "bsg-season");
const pveQuest = {
  ...quest("pve-quest", "PVE 임무", "bsg-pve"),
  bsgIdAliases: ["bsg-pve-old"],
};

function dataWithCatalogs(): TarkovData {
  return {
    meta: {
      originalCommit: "original",
      modifiedCommit: "modified",
      exportedAt: "2026-08-28T00:00:00Z",
      counts: { quests: 1, items: 0, hideoutStations: 0, maps: 0, mapMarkers: 0 },
    },
    quests: [regularQuest],
    questCatalogs: {
      pve: [pveQuest],
      pvpSeason: [pvpSeasonQuest],
    },
    items: [],
    hideoutStations: [],
    traders: [],
    mapConfigs: [],
    mapMarkers: [],
    mapFloorLocations: [],
  };
}

function renderApp(data: TarkovData) {
  dataMocks.loadTarkovData.mockResolvedValue(data);
  return render(
    <AppStoreProvider>
      <App />
    </AppStoreProvider>,
  );
}

function mockLogFile(questId: string): File {
  const file = new File([], "notifications.log", { type: "text/plain" });
  Object.defineProperty(file, "text", {
    configurable: true,
    value: vi.fn().mockResolvedValue(
      `{"type":"new_message","message":{"type":12,"templateId":"${questId} text","dt":1}}`,
    ),
  });
  return file;
}

describe("App quest catalogs", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "#/quests");
    dataMocks.loadTarkovData.mockReset();
  });

  it("keeps the existing PVP profile on regular quests and switches every quest view to PVE", async () => {
    renderApp(dataWithCatalogs());

    expect(await screen.findByRole("heading", { name: "레귤러 임무" })).toBeInTheDocument();
    expect(screen.queryByText("시즌 임무")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "PVE 프로필" }));

    expect(await screen.findByRole("heading", { name: "PVE 임무" })).toBeInTheDocument();
    expect(screen.queryByText("레귤러 임무")).not.toBeInTheDocument();
  });

  it("matches imported quest logs against the active profile catalog", async () => {
    renderApp(dataWithCatalogs());
    fireEvent.click(await screen.findByRole("button", { name: "PVE 프로필" }));
    await screen.findByRole("heading", { name: "PVE 임무" });

    fireEvent.click(screen.getByRole("button", { name: "설정" }));
    fireEvent.click(screen.getByRole("button", { name: "로그 동기화" }));
    fireEvent.change(screen.getByLabelText("로그 파일 선택"), {
      target: { files: [mockLogFile("bsg-pve-old")] },
    });

    await screen.findByRole("heading", { name: "로그 가져오기 미리보기" });
    expect(screen.getByText("PVE 임무", { selector: ".log-event strong" })).toBeVisible();
    expect(screen.queryByText("알 수 없는 ID")).not.toBeInTheDocument();
  });

  it("keeps an old single-catalog bundle working in both profiles", async () => {
    const legacy = dataWithCatalogs();
    delete legacy.questCatalogs;
    renderApp(legacy);

    expect(await screen.findByRole("heading", { name: "레귤러 임무" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "PVE 프로필" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "레귤러 임무" })).toBeInTheDocument();
    });
  });
});
