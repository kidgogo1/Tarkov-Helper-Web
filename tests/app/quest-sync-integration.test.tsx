import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/app/App";
import {
  APP_STATE_STORAGE_KEY,
  AppStoreProvider,
  createDefaultState,
} from "../../src/app/store";
import type { QuestData, TarkovData } from "../../src/types/data";

const dataMocks = vi.hoisted(() => ({
  loadTarkovData: vi.fn(),
}));

vi.mock("../../src/app/data", () => ({
  loadTarkovData: dataMocks.loadTarkovData,
}));

function quest(id: string, nameKo: string, overrides: Partial<QuestData> = {}): QuestData {
  return {
    id,
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
    ...overrides,
  };
}

function dataWithQuests(quests: QuestData[]): TarkovData {
  return {
    meta: {
      originalCommit: "original",
      modifiedCommit: "modified",
      exportedAt: "2026-08-07T00:00:00Z",
      counts: { quests: quests.length, items: 0, hideoutStations: 0, maps: 0, mapMarkers: 0 },
    },
    quests,
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

function mockLogFile(content: string | Error): File {
  const file = new File([], "notifications.log", { type: "text/plain" });
  Object.defineProperty(file, "text", {
    configurable: true,
    value: content instanceof Error
      ? vi.fn().mockRejectedValue(content)
      : vi.fn().mockResolvedValue(content),
  });
  return file;
}

async function openLogSyncSettings() {
  fireEvent.click(await screen.findByRole("button", { name: "설정" }));
  fireEvent.click(screen.getByRole("button", { name: "로그 동기화" }));
}

function persistedProgress(): Record<string, string> {
  const state = JSON.parse(window.localStorage.getItem(APP_STATE_STORAGE_KEY) ?? "{}") as {
    profiles?: { pvp?: { questProgress?: Record<string, string> } };
  };
  return state.profiles?.pvp?.questProgress ?? {};
}

describe("App quest sync integration", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "#/quests");
    dataMocks.loadTarkovData.mockReset();
  });

  it("marks only recursive prerequisites done from manual in-progress input", async () => {
    const root = quest("root", "첫 번째 퀘스트");
    const branch = quest("branch", "두 번째 퀘스트", {
      requirements: [{ questId: "root", requirementType: "complete", groupId: 0 }],
    });
    const target = quest("target", "진행 중인 퀘스트", {
      requirements: [{ questId: "branch", requirementType: "complete", groupId: 0 }],
    });
    renderApp(dataWithQuests([root, branch, target]));

    await openLogSyncSettings();
    fireEvent.click(screen.getByRole("button", { name: "진행 중인 퀘스트 입력" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /진행 중인 퀘스트/ }));
    fireEvent.click(screen.getByRole("button", { name: "선행 퀘스트 완료 적용" }));

    await waitFor(() => {
      expect(persistedProgress()).toEqual({ root: "done", branch: "done" });
    });
    expect(persistedProgress()).not.toHaveProperty("target");
  });

  it("offers enabled alternative prerequisites and applies the chosen route", async () => {
    const routeA = quest("route-a", "경로 A", { alternativeQuestIds: ["route-b"] });
    const routeB = quest("route-b", "경로 B", { alternativeQuestIds: ["route-a"] });
    const middle = quest("middle", "중간 퀘스트", {
      requirements: [{ questId: "route-a", requirementType: "complete", groupId: 0 }],
    });
    const target = quest("target", "로그 완료 퀘스트", {
      requirements: [{ questId: "middle", requirementType: "complete", groupId: 0 }],
    });
    renderApp(dataWithQuests([routeA, routeB, middle, target]));

    await openLogSyncSettings();
    const file = mockLogFile(
      '{"type":"new_message","message":{"type":12,"templateId":"target text","dt":1}}',
    );
    fireEvent.change(screen.getByLabelText("로그 파일 선택"), {
      target: { files: [file] },
    });

    const alternatives = await screen.findByRole("radiogroup", {
      name: /상호 배타적 선행 퀘스트 선택/,
    });
    expect(within(alternatives).getByRole("radio", { name: /경로 A/ })).toBeChecked();
    fireEvent.click(within(alternatives).getByRole("radio", { name: /경로 B/ }));
    fireEvent.click(screen.getByRole("button", { name: "선택 변경 적용" }));

    await waitFor(() => {
      expect(persistedProgress()).toMatchObject({
        target: "done",
        "route-a": "failed",
        "route-b": "done",
      });
    });
  });

  it("does not ask again for an alternative group that is already completed", async () => {
    const routeA = quest("route-a", "경로 A", { alternativeQuestIds: ["route-b"] });
    const routeB = quest("route-b", "경로 B", { alternativeQuestIds: ["route-a"] });
    const target = quest("target", "로그 완료 퀘스트", {
      requirements: [{ questId: "route-a", requirementType: "complete", groupId: 0 }],
    });
    const state = createDefaultState();
    state.profiles.pvp.questProgress["route-b"] = "done";
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
    renderApp(dataWithQuests([routeA, routeB, target]));

    await openLogSyncSettings();
    fireEvent.change(screen.getByLabelText("로그 파일 선택"), {
      target: {
        files: [mockLogFile(
          '{"type":"new_message","message":{"type":12,"templateId":"target text","dt":1}}',
        )],
      },
    });

    await screen.findByRole("heading", { name: "로그 가져오기 미리보기" });
    expect(screen.queryByRole("radiogroup", {
      name: /상호 배타적 선행 퀘스트 선택/,
    })).not.toBeInTheDocument();
  });

  it("reports file read failures and always clears the busy state", async () => {
    renderApp(dataWithQuests([quest("target", "대상 퀘스트")]));

    await openLogSyncSettings();
    fireEvent.change(screen.getByLabelText("로그 파일 선택"), {
      target: { files: [mockLogFile(new Error("permission denied"))] },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("로그 파일을 읽지 못했습니다");
    await waitFor(() => {
      expect(screen.queryByText("로그 읽는 중…")).not.toBeInTheDocument();
    });
  });
});
