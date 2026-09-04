import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_STATE_STORAGE_KEY,
  AppStoreProvider,
  createDefaultState,
  useAppStore,
} from "../../src/app/store";
import { MapPage } from "../../src/features/map/MapPage";
import {
  clearClientDiagnostics,
  getClientDiagnosticSnapshot,
} from "../../src/services/client-diagnostics";
import type { MapConfig, QuestData, TarkovData } from "../../src/types/data";

const mapNames = [
  ["Woods", "Woods"],
  ["Customs", "Customs"],
  ["Shoreline", "Shoreline"],
  ["Interchange", "Interchange"],
  ["Reserve", "Reserve"],
  ["Lighthouse", "Lighthouse"],
  ["StreetsOfTarkov", "Streets of Tarkov"],
  ["Factory", "Factory"],
  ["GroundZero", "Ground Zero"],
  ["Labs", "The Lab"],
  ["Labyrinth", "The Labyrinth"],
  ["Terminal", "Terminal"],
] as const;

const mapConfigs: MapConfig[] = mapNames.map(([key, displayName]) => ({
  key,
  displayName,
  svgFileName: `${key}.svg`,
  imageWidth: 1000,
  imageHeight: 800,
  aliases: [],
  playerMarkerTransform: [1, 0, 0, 1, 0, 0],
  svgBounds: [0, 1000, 0, 800],
  floors:
    key === "Customs"
      ? [
          { layerId: "basement", displayName: "Basement", order: 0, isDefault: false },
          { layerId: "main", displayName: "Ground Floor", order: 1, isDefault: true },
          { layerId: "level2", displayName: "Level 2", order: 2, isDefault: false },
        ]
      : [],
}));

const quest: QuestData = {
  id: "quest-customs",
  normalizedName: "water-room",
  name: "Water Room",
  nameEn: "Water Room",
  nameKo: "물방 찾기",
  wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Water_Room",
  trader: "Therapist",
  locations: ["Customs"],
  kappaRequired: false,
  requirements: [],
  alternativeQuestIds: [],
  followUpQuestIds: [],
  objectives: [
    {
      id: "objective-main",
      sortOrder: 0,
      objectiveType: "Visit",
      description: "기숙사 물방 방문",
      requiresFir: false,
      mapName: "Customs",
      locationPoints: [{ x: 200, y: 1, z: 240, floorId: "main" }],
      optionalPoints: [
        { x: 210, y: 1, z: 250, floorId: "main" },
        { x: 220, y: 1, z: 260, floorId: "main" },
      ],
    },
    {
      id: "objective-upper",
      sortOrder: 1,
      objectiveType: "Collect",
      description: "2층 문서 획득",
      requiresFir: false,
      mapName: "Customs",
      locationPoints: [{ x: 250, y: 7, z: 280, floorId: "level2" }],
      optionalPoints: [],
    },
  ],
  requiredItems: [],
};

const woodsQuest: QuestData = {
  id: "quest-woods",
  normalizedName: "woods-route",
  name: "Woods Route",
  nameEn: "Woods Route",
  nameKo: "숲길 확인",
  wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Woods_Route",
  trader: "Jaeger",
  locations: ["Woods"],
  kappaRequired: false,
  requirements: [],
  alternativeQuestIds: [],
  followUpQuestIds: [],
  objectives: [
    {
      id: "objective-woods",
      sortOrder: 0,
      objectiveType: "Mark",
      description: "벌목장 표시",
      requiresFir: false,
      mapName: "Woods",
      locationPoints: [{ x: 340, y: 2, z: 360 }],
      optionalPoints: [],
    },
  ],
  requiredItems: [],
};

const data: TarkovData = {
  meta: {
    originalCommit: "original",
    modifiedCommit: "modified",
    exportedAt: "2026-08-07T00:00:00Z",
    counts: { quests: 2, items: 0, hideoutStations: 0, maps: 12, mapMarkers: 6 },
  },
  quests: [quest, woodsQuest],
  items: [],
  hideoutStations: [],
  traders: [],
  mapConfigs,
  mapMarkers: [
    {
      id: "boss-main",
      name: "Reshala",
      markerType: "BossSpawn",
      mapKey: "Customs",
      x: 120,
      y: 1,
      z: 130,
      floorId: "main",
    },
    {
      id: "spawn-main",
      name: "Trailer Park",
      markerType: "PmcSpawn",
      mapKey: "Customs",
      x: 150,
      y: 1,
      z: 160,
      floorId: "main",
    },
    {
      id: "extract-main",
      name: "Crossroads",
      markerType: "PmcExtraction",
      mapKey: "Customs",
      x: 180,
      y: 1,
      z: 190,
      floorId: "main",
    },
    {
      id: "extract-upper",
      name: "Upper exit",
      markerType: "ScavExtraction",
      mapKey: "Customs",
      x: 280,
      y: 7,
      z: 290,
      floorId: "level2",
    },
    {
      id: "extract-shared",
      name: "Co-op exit",
      markerType: "SharedExtraction",
      mapKey: "Customs",
      x: 300,
      y: 1,
      z: 300,
      floorId: "main",
    },
    {
      id: "extract-transit",
      name: "Transit to Factory",
      markerType: "Transit",
      mapKey: "Customs",
      x: 320,
      y: 1,
      z: 320,
      floorId: "main",
    },
  ],
  mapFloorLocations: [
    {
      id: "customs-main",
      mapKey: "Customs",
      floorId: "main",
      minY: -1,
      maxY: 4,
      priority: 1,
    },
    {
      id: "customs-level2",
      mapKey: "Customs",
      floorId: "level2",
      minY: 5,
      maxY: 10,
      priority: 1,
    },
  ],
};

function StoreHarness() {
  const { activeProfile, profile, settings, setActiveProfile } = useAppStore();
  return (
    <div>
      <button type="button" onClick={() => setActiveProfile("pvp")}>PVP 테스트 프로필</button>
      <button type="button" onClick={() => setActiveProfile("pve")}>PVE 테스트 프로필</button>
      <output data-testid="active-profile">{activeProfile}</output>
      <output data-testid="profile-state">{JSON.stringify(profile)}</output>
      <output data-testid="settings-state">{JSON.stringify(settings)}</output>
    </div>
  );
}

function renderPage(
  props: Partial<React.ComponentProps<typeof MapPage>> = {},
  includeHarness = false,
  pageData: TarkovData = data,
) {
  return render(
    <AppStoreProvider>
      <MapPage data={pageData} {...props} />
      {includeHarness ? <StoreHarness /> : null}
    </AppStoreProvider>,
  );
}

function profileState() {
  return JSON.parse(screen.getByTestId("profile-state").textContent ?? "{}");
}

function settingsState() {
  return JSON.parse(screen.getByTestId("settings-state").textContent ?? "{}");
}

function trackerResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockMapViewport(initialWidth: number, initialHeight: number) {
  let width = initialWidth;
  let height = initialHeight;
  let resizeCallback: ResizeObserverCallback | undefined;
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

  const rectSpy = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function getBoundingClientRect(this: HTMLElement) {
      if (this.dataset.testid !== "map-viewport") {
        return originalGetBoundingClientRect.call(this);
      }
      return {
        bottom: height,
        height,
        left: 0,
        right: width,
        top: 0,
        width,
        x: 0,
        y: 0,
        toJSON: () => undefined,
      };
    });

  class ResizeObserverStub {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
    }

    disconnect() {}
    observe() {}
    unobserve() {}
  }

  vi.stubGlobal("ResizeObserver", ResizeObserverStub);

  return {
    setSize(nextWidth: number, nextHeight: number) {
      width = nextWidth;
      height = nextHeight;
    },
    resize(nextWidth: number, nextHeight: number) {
      width = nextWidth;
      height = nextHeight;
      act(() => resizeCallback?.([], {} as ResizeObserver));
    },
    restore() {
      rectSpy.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

describe("MapPage", () => {
  it("searches every quest across maps and filters the quest reward item index", () => {
    const rewardItem = {
      id: "reward-item",
      name: "Golden Keycard",
      nameEn: "Golden Keycard",
      nameKo: "황금 키카드",
      categories: ["Keys"],
      isDogtagItem: false,
    };
    const woodsRewardQuest = {
      ...woodsQuest,
      id: "quest-woods-reward",
      name: "Woods Reward",
      nameEn: "Woods Reward",
      nameKo: "숲 보상",
      rewardItems: [
        {
          id: "reward-link",
          itemId: rewardItem.id,
          itemName: rewardItem.name,
          count: 1,
          requiresFir: false,
          requirementType: "Reward",
          sortOrder: 0,
        },
      ],
    } as QuestData;
    const pageData: TarkovData = {
      ...data,
      quests: [...data.quests, woodsRewardQuest],
      items: [rewardItem],
      meta: {
        ...data.meta,
        counts: { ...data.meta.counts, quests: data.quests.length + 1, items: 1 },
      },
    };
    renderPage({}, false, pageData);

    const allQuestSearch = screen.getByRole("searchbox", { name: "전체 퀘스트 검색" });
    fireEvent.change(allQuestSearch, { target: { value: "Woods Reward" } });
    const allQuestResult = screen.getByRole("button", { name: "숲 보상 지도 목표로 이동" });
    expect(allQuestResult).toBeInTheDocument();
    fireEvent.click(allQuestResult);
    expect(screen.getByRole("combobox", { name: "지도 선택" })).toHaveValue("Woods");

    const rewardSearch = screen.getByRole("searchbox", { name: "보상 아이템 검색" });
    fireEvent.change(rewardSearch, { target: { value: "Golden Keycard" } });
    expect(screen.getByRole("button", { name: "황금 키카드 숲 보상" })).toBeInTheDocument();
  });

  it("registers a key location once and keeps its checkbox synchronized with the mini-map", async () => {
    const keyItem = {
      id: "customs-key",
      name: "Dorm room key",
      nameEn: "Dorm room key",
      nameKo: "기숙사 열쇠",
      shortNameEn: "Dorm 103",
      shortNameKo: "기숙사 103",
      category: "Keys",
      categories: ["Keys"],
      isDogtagItem: false,
    };
    const pageData: TarkovData = {
      ...data,
      items: [keyItem],
      mapKeyItemIds: { Customs: [keyItem.id] },
      meta: { ...data.meta, counts: { ...data.meta.counts, items: 1 } },
    };
    renderPage({}, true, pageData);
    fireEvent.change(screen.getByRole("combobox", { name: "지도 선택" }), {
      target: { value: "Customs" },
    });

    const keyToggle = screen.getByRole("checkbox", { name: "키 기숙사 103 표시" });
    expect(keyToggle).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "키 위치 등록" }));
    fireEvent.click(screen.getByTestId("map-viewport"), { clientX: 500, clientY: 400 });

    const dialog = await screen.findByRole("dialog", { name: "키 위치 등록" });
    expect(within(dialog).getByRole("combobox", { name: "키 또는 키카드" })).toHaveValue(keyItem.id);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "방 또는 건물 이름" }), {
      target: { value: "기숙사 103호" },
    });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "귀중품 방 여부" }), {
      target: { value: "high" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "위치 저장" }));

    expect(profileState().keyMarkers).toHaveLength(1);
    expect(screen.getByRole("button", { name: /키 마커 기숙사 열쇠/ })).toBeInTheDocument();

    const originalCoordinates = profileState().keyMarkers?.[0];
    fireEvent.click(screen.getByRole("button", { name: "기숙사 103 위치 편집" }));
    const editDialog = await screen.findByRole("dialog", { name: "키 위치 수정" });
    fireEvent.click(within(editDialog).getByRole("button", { name: "지도에서 위치 다시 지정" }));
    fireEvent.click(screen.getByTestId("map-viewport"), { clientX: 560, clientY: 430 });
    const repositionDialog = await screen.findByRole("dialog", { name: "키 위치 수정" });
    fireEvent.click(within(repositionDialog).getByRole("button", { name: "위치 저장" }));
    expect(profileState().keyMarkers?.[0]?.x).not.toBe(originalCoordinates?.x);

    const viewport = screen.getByTestId("map-viewport");
    fireEvent.keyDown(viewport, { key: "k", shiftKey: true });
    expect(screen.getByRole("button", { name: "지도에서 위치를 클릭하세요" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.keyDown(viewport, { key: "Escape" });

    fireEvent.click(keyToggle);
    expect(screen.queryByRole("button", { name: /키 마커 기숙사 열쇠/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "키 기숙사 103 표시" }));
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    const miniMap = await screen.findByTestId("map-minimap-fallback");
    expect(within(miniMap).getByRole("img", { name: /키 위치 · 기숙사 열쇠/ })).toBeInTheDocument();
  });

  it("opens independent mini-map settings from the map selector and searches every quest in the selected region", () => {
    const onOpenMiniMapSettings = vi.fn();
    const onOpenQuest = vi.fn();

    renderPage({ onOpenQuest, onOpenMiniMapSettings });

    expect(screen.getByRole("button", { name: "미니맵 설정 열기" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 설정 열기" }));
    expect(onOpenMiniMapSettings).toHaveBeenCalledOnce();

    fireEvent.change(screen.getByRole("combobox", { name: "지도 선택" }), {
      target: { value: "Customs" },
    });
    expect(screen.getByRole("heading", { name: "지역 퀘스트 검색" })).toBeInTheDocument();
    const regionSearch = screen.getByRole("searchbox", { name: "현재 지역 퀘스트 검색" });
    expect(screen.getByRole("button", { name: /물방 찾기/ })).toBeInTheDocument();

    fireEvent.change(regionSearch, { target: { value: "문서" } });
    expect(screen.getByRole("button", { name: /물방 찾기/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /물방 찾기/ }));
    expect(onOpenQuest).toHaveBeenCalledWith("quest-customs");
    expect(screen.getByRole("button", { name: "퀘스트 마커 기숙사 물방 방문" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows quest markers only after an explicit quest focus or route selection", async () => {
    const state = createDefaultState();
    state.settings.map.lastMapKey = "Customs";
    // Old releases persisted these switches. They must not revive automatic
    // quest markers after the feature is removed.
    state.settings.map.showQuestMarkers = true;
    state.settings.map.miniMapShowQuestMarkers = true;
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));

    renderPage();

    expect(screen.queryAllByRole("button", { name: /퀘스트 마커/ })).toHaveLength(0);
    expect(screen.queryAllByRole("checkbox", {
      name: "일반 퀘스트 마커 (선택 경로 제외)",
    })).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "활성 퀘스트 목표" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    const miniMap = await screen.findByTestId("map-minimap-fallback");
    expect(within(miniMap).queryByRole("img", { name: /퀘스트 목표/ }))
      .not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "물방 찾기 지도 경로 표시" }));
    expect(screen.getAllByRole("button", { name: /퀘스트 마커 기숙사 물방 방문/ }))
      .toHaveLength(3);
    expect(within(miniMap).getAllByRole("img", {
      name: /퀘스트 목표 · 물방 찾기 · 기숙사 물방 방문/,
    })).toHaveLength(3);
  });

  it("sorts and filters regional quests using profile status, trader, and objective progress", () => {
    const availableQuest: QuestData = {
      ...quest,
      id: "quest-available-customs",
      normalizedName: "available-customs",
      name: "Zulu Available",
      nameEn: "Zulu Available",
      nameKo: "후순위 이름 진행 가능",
      objectives: quest.objectives.map((objective, index) => ({
        ...objective,
        id: `objective-available-${index}`,
        optionalPoints: [],
      })),
    };
    const lockedQuest: QuestData = {
      ...quest,
      id: "quest-locked-customs",
      normalizedName: "locked-customs",
      name: "Alpha Locked",
      nameEn: "Alpha Locked",
      nameKo: "가나다 잠긴 퀘스트",
      trader: "Jaeger",
      requirements: [{ questId: woodsQuest.id, requirementType: "complete", groupId: 0 }],
      objectives: [{
        ...quest.objectives[0],
        id: "objective-locked",
        description: "잠긴 목표",
        optionalPoints: [],
      }],
    };
    const completedQuest: QuestData = {
      ...quest,
      id: "quest-completed-customs",
      normalizedName: "completed-customs",
      name: "Bravo Completed",
      nameEn: "Bravo Completed",
      nameKo: "라마바 완료 퀘스트",
      trader: "Prapor",
      objectives: [{
        ...quest.objectives[0],
        id: "objective-completed",
        description: "완료된 목표",
        optionalPoints: [],
      }],
    };
    const pageData: TarkovData = {
      ...data,
      quests: [completedQuest, lockedQuest, availableQuest, woodsQuest],
      traders: [
        {
          id: "therapist",
          name: "Therapist",
          nameKo: "테라피스트",
          normalizedName: "therapist",
        },
        {
          id: "jaeger",
          name: "Jaeger",
          nameKo: "예거",
          normalizedName: "jaeger",
        },
        {
          id: "prapor",
          name: "Prapor",
          nameKo: "프라퍼",
          normalizedName: "prapor",
        },
      ],
    };
    const state = createDefaultState();
    state.settings.map.lastMapKey = "Customs";
    state.profiles.pvp.questProgress[completedQuest.id] = "done";
    state.profiles.pvp.objectiveProgress[availableQuest.objectives[0].id] = true;
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));

    renderPage({}, true, pageData);

    const region = screen.getByRole("region", { name: "지역 퀘스트 검색" });
    expect(within(region).getByText("완료 1/3")).toBeInTheDocument();
    expect(within(region).getByText("진행 가능 1")).toBeInTheDocument();
    expect(within(region).getByText("미완료 2")).toBeInTheDocument();

    let items = within(region).getAllByTestId("map-region-quest-item");
    expect(items.map((item) => within(item).getByRole("strong").textContent)).toEqual([
      "후순위 이름 진행 가능",
      "가나다 잠긴 퀘스트",
      "라마바 완료 퀘스트",
    ]);
    expect(within(items[0]).getByText("진행 가능")).toBeInTheDocument();
    expect(within(items[0]).getByText("목표 1/2")).toBeInTheDocument();
    expect(within(items[0]).getByRole("progressbar", {
      name: "후순위 이름 진행 가능 목표 진행률",
    })).toHaveAttribute("value", "1");
    expect(within(items[1]).getByText("잠김")).toBeInTheDocument();
    expect(within(items[2]).getByText("목표 1/1")).toBeInTheDocument();
    expect(items[2]).toHaveClass("is-completed");

    fireEvent.change(within(region).getByRole("combobox", {
      name: "지역 퀘스트 상인 필터",
    }), { target: { value: "Jaeger" } });
    items = within(region).getAllByTestId("map-region-quest-item");
    expect(items).toHaveLength(1);
    expect(within(items[0]).getByRole("strong")).toHaveTextContent("가나다 잠긴 퀘스트");

    fireEvent.change(within(region).getByRole("combobox", {
      name: "지역 퀘스트 상인 필터",
    }), { target: { value: "all" } });
    fireEvent.change(within(region).getByRole("combobox", {
      name: "지역 퀘스트 상태 필터",
    }), { target: { value: "completed" } });
    items = within(region).getAllByTestId("map-region-quest-item");
    expect(items).toHaveLength(1);
    expect(within(items[0]).getByRole("strong")).toHaveTextContent("라마바 완료 퀘스트");

    fireEvent.change(within(region).getByRole("combobox", {
      name: "지역 퀘스트 상태 필터",
    }), { target: { value: "all" } });

    fireEvent.change(within(region).getByRole("searchbox", {
      name: "현재 지역 퀘스트 검색",
    }), { target: { value: "예거" } });
    items = within(region).getAllByTestId("map-region-quest-item");
    expect(items).toHaveLength(1);
    expect(within(items[0]).getByRole("strong")).toHaveTextContent("가나다 잠긴 퀘스트");
    fireEvent.change(within(region).getByRole("searchbox", {
      name: "현재 지역 퀘스트 검색",
    }), { target: { value: "" } });

    fireEvent.change(within(region).getByRole("combobox", {
      name: "지역 퀘스트 상인 필터",
    }), { target: { value: "Jaeger" } });
    const mapPicker = screen.getByRole("combobox", { name: "지도 선택" });
    fireEvent.change(mapPicker, { target: { value: "Terminal" } });
    expect(within(region).getByRole("combobox", {
      name: "지역 퀘스트 상인 필터",
    })).toHaveValue("all");
    fireEvent.change(mapPicker, { target: { value: "Customs" } });
    expect(within(region).getByRole("combobox", {
      name: "지역 퀘스트 상인 필터",
    })).toHaveValue("all");

    fireEvent.click(screen.getByRole("button", { name: "PVE 테스트 프로필" }));
    expect(within(region).getByText("완료 0/3")).toBeInTheDocument();
  });

  it("selects a region quest route and connects its visible objectives to the current position", async () => {
    renderPage({ focusQuestId: "quest-customs" }, true);

    const routeToggle = screen.getByRole("checkbox", {
      name: "물방 찾기 지도 경로 표시",
    });
    expect(routeToggle).not.toBeChecked();
    expect(screen.queryByTestId("map-quest-route-line")).not.toBeInTheDocument();

    fireEvent.click(routeToggle);
    expect(profileState().mapRouteQuestIds).toEqual(["quest-customs"]);
    expect(screen.queryByTestId("map-quest-route-line")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("스크린샷 파일 선택"), {
      target: {
        files: [new File([], "2026-08-07[10-20]_100, 1, 200_0, 0, 0, 1_16.74.png")],
      },
    });

    const fullMapLines = screen.getAllByTestId("map-quest-route-line");
    expect(fullMapLines).toHaveLength(3);
    expect(fullMapLines[0]).toHaveAttribute("x1", "100");
    expect(fullMapLines[0]).toHaveAttribute("y1", "200");
    expect(fullMapLines[0]).toHaveAttribute("x2", "200");
    expect(fullMapLines[0]).toHaveAttribute("y2", "240");

    const screenshotInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(screenshotInput).not.toBeNull();
    fireEvent.change(screenshotInput!, {
      target: {
        files: [new File([], "2026-08-07[10-21]_140, 1, 220_0, 0, 0, 1_16.74.png")],
      },
    });
    const updatedFullMapLines = screen.getAllByTestId("map-quest-route-line");
    expect(updatedFullMapLines[0]).toHaveAttribute("x1", "140");
    expect(updatedFullMapLines[0]).toHaveAttribute("y1", "220");

    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    const miniMapLines = await screen.findAllByTestId("map-minimap-quest-route-line");
    expect(miniMapLines).toHaveLength(3);
    expect(miniMapLines[0]).toHaveAttribute("x1", "140");
    expect(miniMapLines[0]).toHaveAttribute("y1", "220");

    const mapPicker = document.querySelector<HTMLSelectElement>("#map-picker");
    expect(mapPicker).not.toBeNull();
    fireEvent.change(mapPicker!, { target: { value: "Woods" } });
    expect(screen.queryByTestId("map-quest-route-line")).not.toBeInTheDocument();
    expect(screen.queryByTestId("map-minimap-quest-route-line")).not.toBeInTheDocument();
    fireEvent.change(mapPicker!, { target: { value: "Customs" } });
    expect(profileState().mapRouteQuestIds).toEqual(["quest-customs"]);
    expect(screen.queryByTestId("map-quest-route-line")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "PVE 테스트 프로필" }));
    expect(screen.getByRole("checkbox", { name: "물방 찾기 지도 경로 표시" }))
      .not.toBeChecked();
    expect(screen.queryByTestId("map-quest-route-line")).not.toBeInTheDocument();
  });

  it("does not connect a player to selected quest objectives on another floor", () => {
    const state = createDefaultState();
    state.profiles.pvp.mapRouteQuestIds = [quest.id];
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
    renderPage({ focusQuestId: "quest-customs" });

    fireEvent.change(screen.getByLabelText("스크린샷 파일 선택"), {
      target: {
        files: [new File([], "2026-08-07[10-20]_100, 7, 200_0, 0, 0, 1_16.74.png")],
      },
    });

    const lines = screen.getAllByTestId("map-quest-route-line");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveAttribute("x2", "250");
    expect(lines[0]).toHaveAttribute("y2", "280");
  });

  it("lets the user explicitly assign an unknown player floor before drawing a route", async () => {
    const factoryQuest: QuestData = {
      ...quest,
      id: "quest-factory-upper",
      normalizedName: "factory-upper",
      name: "Factory upper route",
      nameEn: "Factory upper route",
      nameKo: "팩토리 2층 경로",
      locations: ["Factory"],
      objectives: [{
        ...quest.objectives[1],
        id: "objective-factory-upper",
        mapName: "Factory",
        locationPoints: [{ x: 250, y: 7, z: 280, floorId: "level2" }],
      }],
    };
    const pageData: TarkovData = {
      ...data,
      quests: [factoryQuest, woodsQuest],
      mapConfigs: data.mapConfigs.map((map) => map.key === "Factory"
        ? {
            ...map,
            floors: [
              { layerId: "main", displayName: "Ground Floor", order: 0, isDefault: true },
              { layerId: "level2", displayName: "Level 2", order: 1, isDefault: false },
            ],
          }
        : map),
    };
    const state = createDefaultState();
    state.settings.map.lastMapKey = "Factory";
    state.profiles.pvp.mapRouteQuestIds = [factoryQuest.id];
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
    renderPage({}, false, pageData);

    await waitFor(() => expect(screen.getByRole("button", { name: "Level 2" }))
      .toHaveAttribute("aria-pressed", "true"));
    fireEvent.change(screen.getByLabelText("스크린샷 파일 선택"), {
      target: {
        files: [new File([], "2026-08-07[10-20]_100, 7, 200_0, 0, 0, 1_16.74.png")],
      },
    });

    expect(screen.getByText(/층 미확인 \(연결선 숨김\)/)).toBeInTheDocument();
    expect(screen.queryByTestId("map-quest-route-line")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {
      name: "현재 위치를 Level 2 층으로 지정",
    }));
    expect(screen.getByTestId("map-quest-route-line")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("스크린샷 파일 선택"), {
      target: {
        files: [new File([], "2026-08-07[10-21]_120, 7, 220_0, 0, 0, 1_16.74.png")],
      },
    });
    expect(screen.getByTestId("map-quest-route-line")).toBeInTheDocument();
    expect(screen.queryByText(/층 미확인 \(연결선 숨김\)/)).not.toBeInTheDocument();
  });

  it("shows selected route markers even when a completed quest and both generic marker layers are hidden", async () => {
    const state = createDefaultState();
    state.settings.map.lastMapKey = "Customs";
    state.settings.map.showQuestMarkers = false;
    state.settings.map.miniMapShowQuestMarkers = false;
    state.profiles.pvp.questProgress[quest.id] = "done";
    state.profiles.pvp.mapRouteQuestIds = [quest.id];
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));

    renderPage();

    expect(screen.getAllByRole("button", { name: /퀘스트 마커 기숙사 물방 방문/ }))
      .toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    const miniMap = await screen.findByRole("dialog", { name: "Customs 미니맵" });
    expect(within(miniMap).getAllByRole("img", {
      name: /퀘스트 목표 · 물방 찾기 · 기숙사 물방 방문 · Visit/,
    }))
      .toHaveLength(3);
  });

  it("does not switch floors for a completed route hidden by marker settings", () => {
    const state = createDefaultState();
    state.settings.map.lastMapKey = "Customs";
    state.settings.map.showCompletedObjectives = false;
    state.profiles.pvp.questProgress[quest.id] = "done";
    state.profiles.pvp.mapRouteQuestIds = [quest.id];
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));

    renderPage();

    expect(screen.getByRole("button", { name: "Ground Floor" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/층으로 전환했습니다/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /퀘스트 마커/ })).not.toBeInTheDocument();
  });

  it("clears completed-route markers and floor guidance when completed objectives are hidden", async () => {
    const state = createDefaultState();
    state.settings.map.lastMapKey = "Customs";
    state.settings.map.showCompletedObjectives = true;
    state.profiles.pvp.questProgress[quest.id] = "done";
    state.profiles.pvp.mapRouteQuestIds = [quest.id];
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
    renderPage();

    await waitFor(() => expect(screen.getByText(/목표 일부는 Level 2 층에 있습니다/))
      .toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: /퀘스트 마커/ }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("checkbox", { name: "완료한 목표 포함" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: /퀘스트 마커/ }))
      .not.toBeInTheDocument());
    expect(screen.queryByText(/목표 일부는 Level 2 층에 있습니다/))
      .not.toBeInTheDocument();
  });

  it("recomputes a selected-route notice when a later screenshot changes the player floor", async () => {
    const upperQuest: QuestData = {
      ...quest,
      id: "quest-upper-later-player",
      normalizedName: "upper-later-player",
      name: "Upper later player",
      nameEn: "Upper later player",
      nameKo: "나중 위치 2층 퀘스트",
      objectives: [{ ...quest.objectives[1], id: "objective-upper-later-player" }],
    };
    const state = createDefaultState();
    state.settings.map.lastMapKey = "Customs";
    state.profiles.pvp.mapRouteQuestIds = [upperQuest.id];
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
    renderPage({}, false, { ...data, quests: [upperQuest, woodsQuest] });

    await waitFor(() => expect(screen.getByText(
      "나중 위치 2층 퀘스트 목표가 있는 Level 2 층으로 전환했습니다.",
    )).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("스크린샷 파일 선택"), {
      target: {
        files: [new File([], "2026-08-07[10-20]_100, 1, 200_0, 0, 0, 1_16.74.png")],
      },
    });

    expect(screen.getByRole("button", { name: "Ground Floor" }))
      .toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(screen.getByText(
      /나중 위치 2층 퀘스트 목표 일부는 Level 2 층에 있습니다.*현재 위치는 Ground Floor 층입니다/,
    )).toHaveAttribute("role", "status"));
    expect(screen.queryByText(/목표가 있는 Level 2 층으로 전환했습니다/))
      .not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "플레이어 경로 지우기" }));
    expect(screen.queryByText(/현재 위치는 Ground Floor 층입니다/))
      .not.toBeInTheDocument();
  });

  it("handles a selected multi-map quest separately when each map is visited", async () => {
    const multiMapQuest: QuestData = {
      ...quest,
      id: "quest-multi-map",
      normalizedName: "multi-map-route",
      name: "Multi-map route",
      nameEn: "Multi-map route",
      nameKo: "여러 지도 경로",
      locations: ["Customs", "Reserve"],
      objectives: [
        {
          ...quest.objectives[0],
          id: "objective-multi-customs",
          mapName: "Customs",
          locationPoints: [{ x: 120, y: 1, z: 140, floorId: "main" }],
          optionalPoints: [],
        },
        {
          ...quest.objectives[1],
          id: "objective-multi-reserve",
          mapName: "Reserve",
          locationPoints: [{ x: 410, y: 7, z: 420, floorId: "level2" }],
          optionalPoints: [],
        },
      ],
    };
    const reserve = mapConfigs.find((map) => map.key === "Reserve")!;
    const pageData: TarkovData = {
      ...data,
      quests: [...data.quests, multiMapQuest],
      mapConfigs: data.mapConfigs.map((map) => map.key === "Reserve"
        ? {
            ...reserve,
            floors: [
              { layerId: "main", displayName: "Ground Floor", order: 0, isDefault: true },
              { layerId: "level2", displayName: "Level 2", order: 1, isDefault: false },
            ],
          }
        : map),
      mapFloorLocations: [
        ...data.mapFloorLocations,
        {
          id: "reserve-level2",
          mapKey: "Reserve",
          floorId: "level2",
          minY: 5,
          maxY: 10,
          priority: 1,
        },
      ],
    };
    const state = createDefaultState();
    state.settings.map.lastMapKey = "Customs";
    state.profiles.pvp.mapRouteQuestIds = [multiMapQuest.id];
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));

    renderPage({}, false, pageData);
    expect(screen.getByRole("button", { name: "Ground Floor" }))
      .toHaveAttribute("aria-pressed", "true");
    // Leave the previous map on the same layer id as the target objective. The
    // next map must reset its own floor before evaluating selected routes.
    fireEvent.click(screen.getByRole("button", { name: "Level 2" }));
    expect(screen.getByRole("button", { name: "Level 2" }))
      .toHaveAttribute("aria-pressed", "true");

    fireEvent.change(screen.getByRole("combobox", { name: "지도 선택" }), {
      target: { value: "Reserve" },
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Level 2" }))
      .toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByText("여러 지도 경로 목표가 있는 Level 2 층으로 전환했습니다."))
      .toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "퀘스트 마커 2층 문서 획득" }))
      .toBeInTheDocument();
  });

  it("keeps an explanation for selected quest routes hidden on another floor", async () => {
    const mainQuest: QuestData = {
      ...quest,
      id: "quest-main-only",
      normalizedName: "main-only",
      name: "Ground route",
      nameEn: "Ground route",
      nameKo: "1층 퀘스트",
      objectives: [{ ...quest.objectives[0], id: "objective-main-only" }],
    };
    const upperQuest: QuestData = {
      ...quest,
      id: "quest-upper-only",
      normalizedName: "upper-only",
      name: "Upper route",
      nameEn: "Upper route",
      nameKo: "2층 퀘스트",
      objectives: [{ ...quest.objectives[1], id: "objective-upper-only" }],
    };
    const pageData: TarkovData = {
      ...data,
      quests: [mainQuest, upperQuest, woodsQuest],
    };
    const state = createDefaultState();
    state.settings.map.lastMapKey = "Customs";
    // Keep the visible-floor quest last to catch accidental "last selection wins" handling.
    state.profiles.pvp.mapRouteQuestIds = [upperQuest.id, mainQuest.id];
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));

    renderPage({}, false, pageData);

    await waitFor(() => expect(screen.getByText(
      /2층 퀘스트 목표 일부는 Level 2 층에 있습니다/,
    )).toHaveAttribute("role", "status"));
    expect(screen.getByRole("button", { name: "Ground Floor" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("disables route selection when a region quest has no safe map coordinates", () => {
    const noCoordinatesQuest: QuestData = {
      ...quest,
      id: "quest-no-coordinates",
      normalizedName: "quest-no-coordinates",
      name: "No Coordinates",
      nameEn: "No Coordinates",
      nameKo: "좌표 없는 퀘스트",
      objectives: [{
        ...quest.objectives[0],
        id: "objective-no-coordinates",
        locationPoints: [],
        optionalPoints: [],
      }],
    };
    const pageData: TarkovData = {
      ...data,
      quests: [...data.quests, noCoordinatesQuest],
    };
    renderPage({}, true, pageData);
    fireEvent.change(screen.getByRole("combobox", { name: "지도 선택" }), {
      target: { value: "Customs" },
    });

    const toggle = screen.getByRole("checkbox", {
      name: /^좌표 없는 퀘스트 지도 경로 표시/,
    });
    expect(toggle).toBeDisabled();
    expect(toggle.closest("li")).toHaveTextContent("지도 좌표 없음");
    fireEvent.click(toggle);
    expect(profileState().mapRouteQuestIds).toEqual([]);
  });

  it("never projects a mapless multi-region objective onto an arbitrary map", () => {
    const ambiguousQuest: QuestData = {
      ...quest,
      id: "quest-ambiguous-map",
      normalizedName: "ambiguous-map",
      name: "Ambiguous Map Quest",
      nameEn: "Ambiguous Map Quest",
      nameKo: "여러 지역 좌표 미확정 퀘스트",
      locations: ["Shoreline", "Interchange"],
      objectives: [{
        ...quest.objectives[0],
        id: "objective-ambiguous-map",
        mapName: undefined,
        locationPoints: [{ x: 200, y: 1, z: 240 }],
        optionalPoints: [],
      }],
    };
    const pageData: TarkovData = {
      ...data,
      quests: [...data.quests, ambiguousQuest],
    };
    const state = createDefaultState();
    state.settings.map.lastMapKey = "Shoreline";
    state.profiles.pvp.mapRouteQuestIds = [ambiguousQuest.id];
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));

    renderPage({ focusQuestId: ambiguousQuest.id }, false, pageData);

    const routeToggle = screen.getByRole("checkbox", {
      name: /^여러 지역 좌표 미확정 퀘스트 지도 경로 표시/,
    });
    expect(routeToggle).toBeChecked();
    expect(routeToggle.closest("li")).toHaveTextContent("지도 좌표 없음");
    expect(screen.queryByRole("button", {
      name: /퀘스트 마커 여러 지역 좌표 미확정 퀘스트/,
    })).not.toBeInTheDocument();
  });

  it("toggles a region marker off and exposes wiki and cross-map actions with tooltips", () => {
    const onOpenQuest = vi.fn();
    renderPage({ onOpenQuest });

    fireEvent.change(screen.getByRole("combobox", { name: "지도 선택" }), {
      target: { value: "Customs" },
    });
    const regionSearch = screen.getByRole("searchbox", { name: "현재 지역 퀘스트 검색" });
    fireEvent.change(regionSearch, { target: { value: "물방" } });
    const regionItem = screen.getByTestId("map-region-quest-item");
    const regionFocus = within(regionItem).getByRole("button", { name: /물방 찾기/ });
    const wikiLink = within(regionItem).getByRole("link", { name: /위키에서 퀘스트 열기/ });

    expect(wikiLink).toHaveAttribute(
      "href",
      "https://escapefromtarkov.fandom.com/wiki/Water_Room",
    );
    expect(wikiLink).toHaveAttribute("title", "위키에서 퀘스트 열기");

    fireEvent.click(regionFocus);
    expect(screen.getByRole("button", { name: "퀘스트 마커 기숙사 물방 방문" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(regionFocus);
    expect(screen.queryByRole("button", { name: "퀘스트 마커 기숙사 물방 방문" }))
      .not.toBeInTheDocument();
    expect(onOpenQuest).toHaveBeenCalledTimes(1);

    const allSearch = screen.getByRole("searchbox", { name: "전체 퀘스트 검색" });
    fireEvent.change(allSearch, { target: { value: "Woods Route" } });
    const allItem = screen.getByTestId("map-global-quest-item");
    const mapLink = within(allItem).getByRole("button", { name: /Woods 지도 목표 마커/ });
    expect(mapLink).toHaveAttribute("title", "Woods 지도 목표 마커로 이동");
    fireEvent.click(mapLink);
    expect(screen.getByRole("combobox", { name: "지도 선택" })).toHaveValue("Woods");
    expect(onOpenQuest).toHaveBeenCalledWith("quest-woods");
  });

  beforeEach(() => {
    window.localStorage.clear();
    clearClientDiagnostics();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("offers all 12 packaged maps, renders their SVG, and consumes a quest focus", () => {
    const onQuestFocusConsumed = vi.fn();
    renderPage({ focusQuestId: "quest-customs", onQuestFocusConsumed });

    const picker = screen.getByRole("combobox", { name: "지도 선택" });
    expect(within(picker).getAllByRole("option")).toHaveLength(12);
    expect(within(picker).getByRole("option", { name: "Terminal" })).toBeInTheDocument();
    expect(picker).toHaveValue("Customs");
    expect(screen.getByRole("img", { name: "Customs 지도" })).toHaveAttribute(
      "data",
      "/assets/maps/Customs.svg",
    );
    expect(onQuestFocusConsumed).toHaveBeenCalledOnce();

    fireEvent.change(picker, { target: { value: "Terminal" } });
    expect(screen.getByRole("img", { name: "Terminal 지도" })).toHaveAttribute(
      "data",
      "/assets/maps/Terminal.svg",
    );
  });

  it("filters floor-aware quest, extraction, and basic markers", () => {
    renderPage({ focusQuestId: "quest-customs" });

    expect(screen.getByRole("button", { name: "보스 마커 Reshala" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "탈출구 마커 Crossroads" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "퀘스트 마커 기숙사 물방 방문" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "퀘스트 마커 2층 문서 획득" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Level 2" }));
    expect(screen.queryByRole("button", { name: "보스 마커 Reshala" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "퀘스트 마커 2층 문서 획득" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "탈출구 표시" }));
    expect(screen.queryByRole("button", { name: "탈출구 마커 Upper exit" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Ground Floor" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "보스 표시" }));
    expect(screen.queryByRole("button", { name: "보스 마커 Reshala" })).not.toBeInTheDocument();
  });

  it("filters PMC, Scav/shared, and transit extractions independently", () => {
    renderPage({ focusQuestId: "quest-customs" });

    expect(screen.getByRole("button", { name: "탈출구 마커 Crossroads" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "탈출구 마커 Co-op exit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "탈출구 마커 Transit to Factory" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "PMC 탈출구 표시" }));
    expect(screen.queryByRole("button", { name: "탈출구 마커 Crossroads" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "탈출구 마커 Co-op exit" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Scav 탈출구 표시" }));
    expect(screen.queryByRole("button", { name: "탈출구 마커 Co-op exit" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "트랜짓 탈출구 표시" }));
    expect(screen.queryByRole("button", { name: "탈출구 마커 Transit to Factory" })).not.toBeInTheDocument();
  });

  it("zooms around the pointer, pans, resets, and requests fullscreen", () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    renderPage();

    const viewport = screen.getByTestId("map-viewport");
    fireEvent.wheel(viewport, { deltaY: -100, clientX: 120, clientY: 80 });
    expect(screen.getByTestId("zoom-value")).toHaveTextContent("120%");
    expect(screen.getByTestId("map-world")).toHaveStyle({
      "--map-inverse-scale": `${1 / 1.2}`,
    });

    fireEvent.click(screen.getByRole("button", { name: "지도 보기 초기화" }));

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 150, clientY: 125 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 150, clientY: 125 });
    expect(screen.getByTestId("map-world")).toHaveAttribute("data-pan", "50,25");

    fireEvent.click(screen.getByRole("button", { name: "지도 보기 초기화" }));
    expect(screen.getByTestId("zoom-value")).toHaveTextContent("100%");
    expect(screen.getByTestId("map-world")).toHaveAttribute("data-pan", "0,0");

    fireEvent.click(screen.getByRole("button", { name: "전체 화면 열기" }));
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it("passes the current map scale to marker labels so they shrink with zoom", () => {
    const viewport = mockMapViewport(600, 500);
    renderPage();
    fireEvent.change(screen.getByRole("combobox", { name: "지도 선택" }), {
      target: { value: "Customs" },
    });

    const world = screen.getByTestId("map-world");
    const extraction = screen.getByRole("button", { name: "탈출구 마커 Crossroads" });
    expect(extraction.querySelector(".map-marker-label")).toHaveTextContent("Crossroads");
    expect(world).toHaveStyle({ "--map-scale": "0.6" });

    fireEvent.wheel(screen.getByTestId("map-viewport"), {
      clientX: 120,
      clientY: 80,
      deltaY: 100,
    });

    expect(world).toHaveStyle({ "--map-scale": "0.5" });
    viewport.restore();
  });

  it("fits and centers the selected map using the measured viewport", () => {
    const viewport = mockMapViewport(600, 500);
    renderPage();

    expect(screen.getByTestId("map-world")).toHaveAttribute("data-pan", "0,10");
    expect(screen.getByTestId("map-world")).toHaveStyle({
      transform: "translate3d(0px, 10px, 0) scale(0.6)",
    });

    fireEvent.pointerDown(screen.getByTestId("map-viewport"), {
      pointerId: 1,
      clientX: 100,
      clientY: 100,
      button: 0,
    });
    fireEvent.pointerMove(screen.getByTestId("map-viewport"), {
      pointerId: 1,
      clientX: 150,
      clientY: 125,
    });
    fireEvent.pointerUp(screen.getByTestId("map-viewport"), {
      pointerId: 1,
      clientX: 150,
      clientY: 125,
    });
    fireEvent.change(screen.getByRole("combobox", { name: "지도 선택" }), {
      target: { value: "Customs" },
    });
    expect(screen.getByTestId("map-world")).toHaveAttribute("data-pan", "0,10");

    viewport.restore();
  });

  it("centers the first focused quest point at the fitted map scale", () => {
    const viewport = mockMapViewport(600, 500);
    renderPage({ focusQuestId: "quest-customs" });

    expect(screen.getByTestId("map-world")).toHaveAttribute("data-pan", "180,106");
    expect(screen.getByTestId("map-world")).toHaveStyle({
      transform: "translate3d(180px, 106px, 0) scale(0.6)",
    });

    viewport.restore();
  });

  it("centers a quest point when focus arrives after the map page mounted", async () => {
    const viewport = mockMapViewport(600, 500);
    const rendered = renderPage();

    rendered.rerender(
      <AppStoreProvider>
        <MapPage data={data} focusQuestId="quest-customs" />
      </AppStoreProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "지도 선택" })).toHaveValue("Customs");
      expect(screen.getByTestId("map-world")).toHaveAttribute("data-pan", "180,106");
    });

    viewport.restore();
  });

  it("reapplies fit or quest focus after SVG load and viewport resize", () => {
    const viewport = mockMapViewport(0, 0);
    renderPage({ focusQuestId: "quest-customs" });

    expect(screen.getByTestId("map-world")).toHaveAttribute("data-pan", "0,0");

    viewport.setSize(600, 500);
    fireEvent.load(screen.getByRole("img", { name: "Customs 지도" }));
    expect(screen.getByTestId("map-world")).toHaveAttribute("data-pan", "180,106");

    viewport.resize(800, 600);
    expect(screen.getByTestId("map-world")).toHaveAttribute("data-pan", "250,120");
    expect(screen.getByTestId("map-world")).toHaveStyle({
      transform: "translate3d(250px, 120px, 0) scale(0.75)",
    });

    viewport.restore();
  });

  it("uses document landmarks and supports keyboard pan, zoom, and reset", () => {
    renderPage({ focusQuestId: "quest-customs" });

    const viewport = screen.getByTestId("map-viewport");
    expect(viewport).not.toHaveAttribute("role", "application");
    expect(viewport.parentElement?.tagName).toBe("SECTION");
    expect(screen.getByText(/방향키: 이동/)).toBeInTheDocument();
    expect(screen.getByText(/\+\/-: 확대·축소/)).toBeInTheDocument();
    expect(screen.getByText(/0: 보기 초기화/)).toBeInTheDocument();

    viewport.focus();
    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    fireEvent.keyDown(viewport, { key: "ArrowDown" });
    expect(screen.getByTestId("map-world")).toHaveAttribute("data-pan", "-40,-40");

    fireEvent.keyDown(viewport, { key: "+" });
    expect(screen.getByTestId("zoom-value")).toHaveTextContent("120%");
    fireEvent.keyDown(viewport, { key: "-" });
    expect(screen.getByTestId("zoom-value")).toHaveTextContent("100%");

    fireEvent.keyDown(viewport, { key: "0" });
    expect(screen.getByTestId("map-world")).toHaveAttribute("data-pan", "0,0");
  });

  it("uses only a screenshot filename for player position, direction, trail, and floor detection", () => {
    renderPage({ focusQuestId: "quest-customs" });

    const input = screen.getByLabelText("스크린샷 파일 선택");
    fireEvent.change(input, {
      target: {
        files: [
          new File(
            [],
            "2026-08-07[10-20]_100, 7, 200_0, 0.7071068, 0, 0.7071068_16.74.png",
          ),
        ],
      },
    });

    expect(screen.getByRole("button", { name: /플레이어 위치 X 100.*Y 7.*Z 200.*방향 270/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Level 2" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.change(input, {
      target: {
        files: [
          new File(
            [],
            "2026-08-07[10-21]_120, 7, 220_0, 0.7071068, 0, 0.7071068_16.74.png",
          ),
        ],
      },
    });
    expect(screen.getByTestId("player-trail")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "플레이어 자동 중앙 맞춤 고정" }));
    fireEvent.click(screen.getByRole("button", { name: "지도 보기 초기화" }));
    const before = screen.getByTestId("map-world").getAttribute("style");
    fireEvent.change(input, {
      target: {
        files: [
          new File(
            [],
            "2026-08-07[10-22]_140, 7, 240_0, 0.7071068, 0, 0.7071068_16.74.png",
          ),
        ],
      },
    });
    expect(screen.getByTestId("map-world").getAttribute("style")).toBe(before);

    expect(screen.getByText(/브라우저는 게임 로그나 스크린샷 폴더를 백그라운드에서 감시할 수 없습니다/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "플레이어 경로 지우기" }));
    expect(screen.queryByRole("button", { name: /플레이어 위치/ })).not.toBeInTheDocument();
  });

  it("automatically selects a Factory floor from screenshot height without floor-location rows", () => {
    const pageData: TarkovData = {
      ...data,
      mapConfigs: data.mapConfigs.map((map) => map.key === "Factory"
        ? {
            ...map,
            floors: [
              { layerId: "basement", displayName: "Basement", order: -1, isDefault: false },
              { layerId: "main", displayName: "Ground Floor", order: 0, isDefault: true },
              { layerId: "level2", displayName: "Level 2", order: 1, isDefault: false },
              { layerId: "level3", displayName: "Level 3", order: 2, isDefault: false },
            ],
          }
        : map),
      mapFloorLocations: [],
    };
    const state = createDefaultState();
    state.settings.map.lastMapKey = "Factory";
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
    renderPage({}, false, pageData);

    fireEvent.change(screen.getByLabelText("스크린샷 파일 선택"), {
      target: {
        files: [new File([], "2026-08-07[10-20]_0, 4, 0_0, 0, 0, 1_16.74.png")],
      },
    });

    expect(screen.getByRole("button", { name: "Level 2" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/방향 180° · Level 2 · Factory 선택 기준/)).toBeInTheDocument();
  });

  it("automatically applies new screenshot events through the manual coordinate pipeline", async () => {
    let eventRequestCount = 0;
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/native-overlay/session")) {
        return trackerResponse({ error: "Not found" }, 404);
      }
      if (url.endsWith("/api/v1/local-tracker/status")) {
        return trackerResponse({
          protocolVersion: 1,
          screenshotWatcher: {
            state: "WATCHING",
            folderPath: "C:\\Users\\Tester\\Documents\\Escape from Tarkov\\Screenshots",
          },
          latestCursor: 3,
        });
      }

      eventRequestCount += 1;
      if (eventRequestCount === 1) {
        const event = {
          type: "SCREENSHOT_CREATED",
          sequence: 4,
          mapKey: "Customs",
          fileName: "2026-08-07[10-20]_100, 7, 200_0, 0.7071068, 0, 0.7071068_16.74.png",
          detectedAt: "2026-08-07T01:20:00.000Z",
        };
        return trackerResponse({
          protocolVersion: 1,
          data: [event, event],
          pagination: { afterCursor: 2, nextCursor: 4, hasMore: false },
        });
      }
      return trackerResponse({
        protocolVersion: 1,
        data: [],
        pagination: { afterCursor: 4, nextCursor: 4, hasMore: false },
      });
    });
    vi.stubGlobal("fetch", request);

    renderPage({ focusQuestId: "quest-customs" });

    expect(await screen.findByText("자동 위치 추적 중")).toBeInTheDocument();
    expect(screen.getByText("C:\\Users\\Tester\\Documents\\Escape from Tarkov\\Screenshots"))
      .toBeInTheDocument();
    expect(screen.getByText(/새 EFT 스크린샷 파일을 자동 감지합니다/)).toBeInTheDocument();
    expect(
      await screen.findByRole("button", {
        name: /플레이어 위치 X 100.*Y 7.*Z 200.*방향 270/,
      }, { timeout: 2_000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Level 2" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("player-trail")).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(
      "/api/v1/local-tracker/events?afterCursor=2&pageSize=100",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("restores the latest screenshot already detected before the map tab mounted", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/local-tracker/status")) {
        return trackerResponse({
          protocolVersion: 1,
          screenshotWatcher: { state: "WATCHING", folderPath: "C:\\Screenshots" },
          latestCursor: 9,
        });
      }
      if (url.includes("afterCursor=8")) {
        return trackerResponse({
          protocolVersion: 1,
          data: [{
            type: "SCREENSHOT_CREATED",
            sequence: 9,
            mapKey: "Customs",
            fileName: "2026-08-07[10-20]_88, 7, 144_0, 0, 0, 1_0.png",
            detectedAt: "2026-08-07T01:20:00.000Z",
          }],
          pagination: { afterCursor: 8, nextCursor: 9, hasMore: false },
        });
      }
      return trackerResponse({
        protocolVersion: 1,
        data: [],
        pagination: { afterCursor: 9, nextCursor: 9, hasMore: false },
      });
    });
    vi.stubGlobal("fetch", request);

    renderPage({ focusQuestId: "quest-customs" });

    expect(
      await screen.findByRole("button", { name: /플레이어 위치 X 88.*Z 144/ }),
    ).toBeInTheDocument();
  });

  it("applies a mapless automatic screenshot to the current map without confirmation", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/local-tracker/status")) {
        return trackerResponse({
          protocolVersion: 1,
          screenshotWatcher: { state: "WATCHING", folderPath: "C:\\Screenshots" },
          latestCursor: 9,
        });
      }
      if (url.includes("afterCursor=8")) {
        return trackerResponse({
          protocolVersion: 1,
          data: [{
            type: "SCREENSHOT_CREATED",
            sequence: 9,
            fileName: "2026-08-07[10-20]_88, 7, 144_0, 0, 0, 1_0.png",
            detectedAt: "2026-08-07T01:20:00.000Z",
          }],
          pagination: { afterCursor: 8, nextCursor: 9, hasMore: false },
        });
      }
      return trackerResponse({
        protocolVersion: 1,
        data: [],
        pagination: { afterCursor: 9, nextCursor: 9, hasMore: false },
      });
    });
    vi.stubGlobal("fetch", request);

    renderPage({ focusQuestId: "quest-customs" });

    expect(await screen.findByRole("button", { name: /플레이어 위치 X 88.*Z 144/ }))
      .toBeInTheDocument();
    expect(screen.queryByText(/자동 감지된 스크린샷에는 지도 이름이 없습니다/))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /자동 위치 연결/ }))
      .not.toBeInTheDocument();
  });

  it("does not reuse a mapless screenshot after changing maps", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/local-tracker/status")) {
        return trackerResponse({
          protocolVersion: 1,
          screenshotWatcher: { state: "WATCHING", folderPath: "C:\\Screenshots" },
          latestCursor: 1,
        });
      }
      if (url.includes("afterCursor=0")) {
        return trackerResponse({
          protocolVersion: 1,
          data: [{
            type: "SCREENSHOT_CREATED",
            sequence: 1,
            fileName: "2026-08-07[10-20]_88, 7, 144_0, 0, 0, 1_0.png",
            detectedAt: "2026-08-07T01:20:00.000Z",
          }],
          pagination: { afterCursor: 0, nextCursor: 1, hasMore: false },
        });
      }
      return trackerResponse({
        protocolVersion: 1,
        data: [],
        pagination: { afterCursor: 1, nextCursor: 1, hasMore: false },
      });
    });
    vi.stubGlobal("fetch", request);
    renderPage({ focusQuestId: "quest-customs" });

    await screen.findByRole("button", { name: /플레이어 위치 X 88/ });
    fireEvent.change(screen.getByRole("combobox", { name: "지도 선택" }), {
      target: { value: "Woods" },
    });
    expect(screen.queryByRole("button", { name: /플레이어 위치 X 88/ }))
      .not.toBeInTheDocument();
  });

  it("does not project a mapless screenshot onto a newly selected map", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/local-tracker/status")) {
        return trackerResponse({
          protocolVersion: 1,
          screenshotWatcher: { state: "WATCHING", folderPath: "C:\\Screenshots" },
          latestCursor: 1,
        });
      }
      if (url.includes("afterCursor=0")) {
        return trackerResponse({
          protocolVersion: 1,
          data: [{
            type: "SCREENSHOT_CREATED",
            sequence: 1,
            fileName: "2026-08-07[10-20]_88, 7, 144_0, 0, 0, 1_0.png",
            detectedAt: "2026-08-07T01:20:00.000Z",
          }],
          pagination: { afterCursor: 0, nextCursor: 1, hasMore: false },
        });
      }
      return trackerResponse({
        protocolVersion: 1,
        data: [],
        pagination: { afterCursor: 1, nextCursor: 1, hasMore: false },
      });
    });
    vi.stubGlobal("fetch", request);
    renderPage({ focusQuestId: "quest-customs" });

    await screen.findByRole("button", { name: /플레이어 위치 X 88/ });
    fireEvent.change(screen.getByRole("combobox", { name: "지도 선택" }), {
      target: { value: "Woods" },
    });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "지도 선택" }))
      .toHaveValue("Woods"));
    expect(screen.queryByRole("button", { name: /플레이어 위치 X 88/ }))
      .not.toBeInTheDocument();
  });

  it("automatically switches to a map-identified screenshot and persists the detected map", async () => {
    const requestedUrls: string[] = [];
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith("/api/v1/local-tracker/status")) {
        return trackerResponse({
          protocolVersion: 1,
          screenshotWatcher: { state: "WATCHING", folderPath: "C:\\Screenshots" },
          latestCursor: 9,
        });
      }
      if (url.includes("afterCursor=8")) {
        return trackerResponse({
          protocolVersion: 1,
          data: [{
            type: "SCREENSHOT_CREATED",
            sequence: 9,
            mapKey: "Woods",
            fileName: "2026-08-07[10-20]_66, 2, 122_0, 0, 0, 1_0.png",
            detectedAt: "2026-08-07T01:20:00.000Z",
          }],
          pagination: { afterCursor: 8, nextCursor: 9, hasMore: false },
        });
      }
      return trackerResponse({
        protocolVersion: 1,
        data: [],
        pagination: { afterCursor: 9, nextCursor: 9, hasMore: false },
      });
    });
    vi.stubGlobal("fetch", request);

    renderPage({ focusQuestId: "quest-customs" }, true);
    await waitFor(() => expect(requestedUrls.some((url) => url.includes("afterCursor=8")))
      .toBe(true));
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "지도 선택" })).toHaveValue("Woods");
      expect(settingsState().map.lastMapKey).toBe("Woods");
    });
    expect(await screen.findByRole("button", { name: /플레이어 위치 X 66.*Z 122/ }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /자동 위치 연결/ }))
      .not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "플레이어 경로 지우기" }));
    expect(screen.queryByRole("button", { name: /플레이어 위치 X 66/ }))
      .not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "지도 선택" }), {
      target: { value: "Customs" },
    });
    await screen.findByRole("button", { name: "Ground Floor" });
    fireEvent.change(screen.getByRole("combobox", { name: "지도 선택" }), {
      target: { value: "Woods" },
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Ground Floor" })).not.toBeInTheDocument();
    });
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 50)));
    expect(screen.queryByRole("button", { name: /플레이어 위치 X 66/ }))
      .not.toBeInTheDocument();
  });

  it("does not cache or restore a malformed map-identified screenshot", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/local-tracker/status")) {
        return trackerResponse({
          protocolVersion: 1,
          screenshotWatcher: { state: "WATCHING", folderPath: "C:\\Screenshots" },
          latestCursor: 1,
        });
      }
      if (url.includes("afterCursor=0")) {
        return trackerResponse({
          protocolVersion: 1,
          data: [{
            type: "SCREENSHOT_CREATED",
            sequence: 1,
            mapKey: "Woods",
            fileName: "ordinary-screenshot.png",
            detectedAt: "2026-08-07T01:20:00.000Z",
          }],
          pagination: { afterCursor: 0, nextCursor: 1, hasMore: false },
        });
      }
      return trackerResponse({
        protocolVersion: 1,
        data: [],
        pagination: { afterCursor: 1, nextCursor: 1, hasMore: false },
      });
    });
    vi.stubGlobal("fetch", request);
    renderPage({ focusQuestId: "quest-customs" });

    await waitFor(() => expect(request).toHaveBeenCalledWith(
      "/api/v1/local-tracker/events?afterCursor=0&pageSize=100",
      expect.anything(),
    ));
    fireEvent.change(screen.getByRole("combobox", { name: "지도 선택" }), {
      target: { value: "Woods" },
    });
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 50)));

    expect(screen.queryByRole("button", { name: /플레이어 위치/ }))
      .not.toBeInTheDocument();
  });

  it("keeps only the latest map-identified screenshot across aliases", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/local-tracker/status")) {
        return trackerResponse({
          protocolVersion: 1,
          screenshotWatcher: { state: "WATCHING", folderPath: "C:\\Screenshots" },
          latestCursor: 2,
        });
      }
      if (url.includes("afterCursor=1")) {
        return trackerResponse({
          protocolVersion: 1,
          data: [
            {
              type: "SCREENSHOT_CREATED",
              sequence: 1,
              mapKey: "Woods",
              fileName: "2026-08-07[10-20]_10, 2, 20_0, 0, 0, 1_0.png",
              detectedAt: "2026-08-07T01:20:00.000Z",
            },
            {
              type: "SCREENSHOT_CREATED",
              sequence: 2,
              mapKey: "woods_preset",
              fileName: "2026-08-07[10-21]_66, 2, 122_0, 0, 0, 1_0.png",
              detectedAt: "2026-08-07T01:21:00.000Z",
            },
          ],
          pagination: { afterCursor: 1, nextCursor: 2, hasMore: false },
        });
      }
      return trackerResponse({
        protocolVersion: 1,
        data: [],
        pagination: { afterCursor: 2, nextCursor: 2, hasMore: false },
      });
    });
    vi.stubGlobal("fetch", request);
    renderPage({ focusQuestId: "quest-customs" });

    await waitFor(() => expect(request).toHaveBeenCalledWith(
      "/api/v1/local-tracker/events?afterCursor=1&pageSize=100",
      expect.anything(),
    ));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "지도 선택" }))
      .toHaveValue("Woods"));
    expect(await screen.findByRole("button", { name: /플레이어 위치 X 66.*Z 122/ }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /플레이어 위치 X 10.*Z 20/ }))
      .not.toBeInTheDocument();
  });

  it.each([
    {
      label: "unsupported-map",
      latest: {
        type: "SCREENSHOT_CREATED",
        sequence: 2,
        mapKey: "brand_new_map",
        fileName: "2026-08-07[10-21]_88, 7, 144_0, 0, 0, 1_0.png",
        detectedAt: "2026-08-07T01:21:00.000Z",
      },
      message: "감지된 지도를 지원하지 않아 위치를 표시하지 못했습니다.",
    },
    {
      label: "malformed",
      latest: {
        type: "SCREENSHOT_CREATED",
        sequence: 2,
        mapKey: "Woods",
        fileName: "ordinary-screenshot.png",
        detectedAt: "2026-08-07T01:21:00.000Z",
      },
      message: "감지된 스크린샷의 위치를 해석하지 못했습니다.",
    },
  ])("lets the newest $label event prevent an older known-map auto switch", async ({ latest, message }) => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/local-tracker/status")) {
        return trackerResponse({
          protocolVersion: 1,
          screenshotWatcher: { state: "WATCHING", folderPath: "C:\\Screenshots" },
          latestCursor: 0,
        });
      }
      if (url.includes("afterCursor=0")) {
        return trackerResponse({
          protocolVersion: 1,
          data: [
            {
              type: "SCREENSHOT_CREATED",
              sequence: 1,
              mapKey: "Woods",
              fileName: "2026-08-07[10-20]_66, 2, 122_0, 0, 0, 1_0.png",
              detectedAt: "2026-08-07T01:20:00.000Z",
            },
            latest,
          ],
          pagination: { afterCursor: 0, nextCursor: 2, hasMore: false },
        });
      }
      return trackerResponse({
        protocolVersion: 1,
        data: [],
        pagination: { afterCursor: 2, nextCursor: 2, hasMore: false },
      });
    });
    vi.stubGlobal("fetch", request);
    renderPage({ focusQuestId: "quest-customs" });

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "지도 선택" })).toHaveValue("Customs");
    expect(screen.queryByRole("button", { name: /플레이어 위치 X 66/ }))
      .not.toBeInTheDocument();
  });

  it("invalidates an older map cache even when a newer valid map is the active event", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/local-tracker/status")) {
        return trackerResponse({
          protocolVersion: 1,
          screenshotWatcher: { state: "WATCHING", folderPath: "C:\\Screenshots" },
          latestCursor: 0,
        });
      }
      if (url.includes("afterCursor=0")) {
        return trackerResponse({
          protocolVersion: 1,
          data: [
            {
              type: "SCREENSHOT_CREATED",
              sequence: 1,
              mapKey: "Woods",
              fileName: "2026-08-07[10-20]_66, 2, 122_0, 0, 0, 1_0.png",
              detectedAt: "2026-08-07T01:20:00.000Z",
            },
            {
              type: "SCREENSHOT_CREATED",
              sequence: 2,
              mapKey: "Woods",
              fileName: "ordinary-screenshot.png",
              detectedAt: "2026-08-07T01:21:00.000Z",
            },
            {
              type: "SCREENSHOT_CREATED",
              sequence: 3,
              mapKey: "Customs",
              fileName: "2026-08-07[10-22]_77, 7, 133_0, 0, 0, 1_0.png",
              detectedAt: "2026-08-07T01:22:00.000Z",
            },
          ],
          pagination: { afterCursor: 0, nextCursor: 3, hasMore: false },
        });
      }
      return trackerResponse({
        protocolVersion: 1,
        data: [],
        pagination: { afterCursor: 3, nextCursor: 3, hasMore: false },
      });
    });
    vi.stubGlobal("fetch", request);
    renderPage({ focusQuestId: "quest-customs" });

    await screen.findByRole("button", { name: /플레이어 위치 X 77.*Z 133/ });
    fireEvent.change(screen.getByRole("combobox", { name: "지도 선택" }), {
      target: { value: "Woods" },
    });
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 50)));
    expect(screen.queryByRole("button", { name: /플레이어 위치 X 66/ }))
      .not.toBeInTheDocument();
  });

  it("shows folder-not-found and watcher-error states while keeping manual selection", async () => {
    const notFound = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      String(input).endsWith("/api/v1/native-overlay/session")
        ? trackerResponse({ error: "Not found" }, 404)
        : trackerResponse({
            protocolVersion: 1,
            screenshotWatcher: { state: "NOT_FOUND" },
            latestCursor: 0,
          }));
    vi.stubGlobal("fetch", notFound);
    const first = renderPage({ focusQuestId: "quest-customs" });

    expect(await screen.findByText("스크린샷 폴더를 찾지 못했습니다")).toBeInTheDocument();
    expect(screen.getByLabelText("스크린샷 파일 선택")).toBeInTheDocument();
    first.unmount();

    const failed = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      String(input).endsWith("/api/v1/native-overlay/session")
        ? trackerResponse({ error: "Not found" }, 404)
        : trackerResponse({
            protocolVersion: 1,
            screenshotWatcher: { state: "ERROR", message: "스크린샷 폴더 접근이 거부되었습니다." },
            latestCursor: 0,
          }));
    vi.stubGlobal("fetch", failed);
    renderPage({ focusQuestId: "quest-customs" });

    expect(await screen.findByText("자동 위치 추적 오류")).toBeInTheDocument();
    expect(screen.getByText("스크린샷 폴더 접근이 거부되었습니다.")).toBeInTheDocument();
    expect(screen.getByLabelText("스크린샷 파일 선택")).toBeInTheDocument();
  });

  it("falls back to browser-only instructions for an unavailable bridge", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(trackerResponse({ error: "Not found" }, 404)),
    );
    renderPage({ focusQuestId: "quest-customs" });

    expect(await screen.findByText("브라우저 수동 모드")).toBeInTheDocument();
    expect(screen.getByText(/브라우저는 게임 로그나 스크린샷 폴더를 백그라운드에서 감시할 수 없습니다/))
      .toBeInTheDocument();
    expect(getClientDiagnosticSnapshot().entries.filter(
      (entry) => entry.operation === "local-tracker-poll",
    )).toHaveLength(0);
  });

  it("resets an expired cursor without dropping the newest retained position and aborts on unmount", async () => {
    let capturedSignal: AbortSignal | undefined;
    const requestedUrls: string[] = [];
    const request = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      requestedUrls.push(url);
      capturedSignal = init?.signal ?? undefined;
      if (url.endsWith("/api/v1/local-tracker/status")) {
        return trackerResponse({
          protocolVersion: 1,
          screenshotWatcher: { state: "WATCHING", folderPath: "C:\\Screenshots" },
          latestCursor: 0,
        });
      }
      if (url.includes("afterCursor=0")) {
        return trackerResponse({
          protocolVersion: 1,
          data: [{
            type: "SCREENSHOT_CREATED",
            sequence: 1,
            mapKey: "Woods",
            fileName: "2026-08-07[10-19]_55, 2, 66_0, 0, 0, 1_0.png",
            detectedAt: "2026-08-07T01:19:00.000Z",
          }],
          pagination: { afterCursor: 0, nextCursor: 1, hasMore: false },
        });
      }
      if (url.includes("afterCursor=1")) {
        return trackerResponse({
          protocolVersion: 1,
          data: [{
            type: "SCREENSHOT_CREATED",
            sequence: 2,
            mapKey: "Customs",
            fileName: "2026-08-07[10-20]_99, 7, 99_0, 0, 0, 1_0.png",
            detectedAt: "2026-08-07T01:20:00.000Z",
          }],
          pagination: {
            afterCursor: 1,
            nextCursor: 8,
            hasMore: false,
            isResetRequired: true,
          },
        });
      }
      return trackerResponse({
        protocolVersion: 1,
        data: [],
        pagination: { afterCursor: 8, nextCursor: 8, hasMore: false },
      });
    });
    vi.stubGlobal("fetch", request);

    const rendered = renderPage({ focusQuestId: "quest-customs" });
    expect(await screen.findByText("자동 위치 추적 중")).toBeInTheDocument();
    await waitFor(
      () => expect(requestedUrls.some((url) => url.includes("afterCursor=8"))).toBe(true),
      { timeout: 4_000 },
    );
    expect(screen.getByRole("button", { name: /플레이어 위치 X 99/ })).toBeInTheDocument();
    expect(screen.queryByTestId("player-trail")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "지도 선택" }), {
      target: { value: "Woods" },
    });
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 50)));
    expect(screen.queryByRole("button", { name: /플레이어 위치 X 55/ }))
      .not.toBeInTheDocument();

    rendered.unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("resets an equal cursor after a launcher restart and replays every retained position", async () => {
    let statusCalls = 0;
    let eventCalls = 0;
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/local-tracker/status")) {
        statusCalls += 1;
        if (statusCalls === 2) throw new TypeError("server still restarting");
        return trackerResponse({
          protocolVersion: 1,
          instanceId: statusCalls === 1
            ? "11111111111111111111111111111111"
            : "22222222222222222222222222222222",
          screenshotWatcher: { state: "WATCHING", folderPath: "C:\\Screenshots" },
          latestCursor: 5,
        });
      }
      if (url.includes("/native-overlay/")) {
        return trackerResponse({ error: "Not found" }, 404);
      }
      eventCalls += 1;
      if (eventCalls === 1) throw new TypeError("server restarted");
      if (url.includes("afterCursor=0")) {
        return trackerResponse({
          protocolVersion: 1,
          instanceId: "22222222222222222222222222222222",
          data: [
            {
              type: "SCREENSHOT_CREATED",
              sequence: 4,
              mapKey: "Woods",
              fileName: "2026-08-07[10-19]_55, 2, 66_0, 0, 0, 1_0.png",
              detectedAt: "2026-08-07T01:19:00.000Z",
            },
            {
              type: "SCREENSHOT_CREATED",
              sequence: 5,
              mapKey: "Customs",
              fileName: "2026-08-07[10-20]_77, 7, 133_0, 0, 0, 1_0.png",
              detectedAt: "2026-08-07T01:20:00.000Z",
            },
          ],
          pagination: { afterCursor: 0, nextCursor: 5, hasMore: false },
        });
      }
      return trackerResponse({
        protocolVersion: 1,
        data: [],
        pagination: { afterCursor: 5, nextCursor: 5, hasMore: false },
      });
    });
    vi.stubGlobal("fetch", request);

    renderPage({ focusQuestId: "quest-customs" });

    expect(
      await screen.findByRole(
        "button",
        { name: /플레이어 위치 X 77.*Z 133/ },
        { timeout: 5_000 },
      ),
    ).toBeInTheDocument();
    expect(statusCalls).toBeGreaterThanOrEqual(3);
    fireEvent.change(screen.getByRole("combobox", { name: "지도 선택" }), {
      target: { value: "Woods" },
    });
    expect(await screen.findByRole("button", { name: /플레이어 위치 X 55.*Z 66/ }))
      .toBeInTheDocument();
    expect(getClientDiagnosticSnapshot().entries.filter(
      (entry) => entry.operation === "local-tracker-poll",
    )).toEqual([
      expect.objectContaining({
        code: "LOCAL_TRACKER_NETWORK_ERROR",
        count: 1,
        operation: "local-tracker-poll",
        source: "optional-resource",
      }),
    ]);
  });

  it("discards an event page from a replaced launcher instance and refetches from cursor zero", async () => {
    const requestedCursors: number[] = [];
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/local-tracker/status")) {
        return trackerResponse({
          protocolVersion: 1,
          instanceId: "11111111111111111111111111111111",
          screenshotWatcher: { state: "WATCHING", folderPath: "C:\\Screenshots" },
          latestCursor: 5,
        });
      }
      if (url.includes("/native-overlay/")) return trackerResponse({}, 404);
      const cursor = Number(new URL(url, "http://localhost").searchParams.get("afterCursor"));
      requestedCursors.push(cursor);
      if (requestedCursors.length === 1) {
        return trackerResponse({
          protocolVersion: 1,
          instanceId: "22222222222222222222222222222222",
          data: [{
            type: "SCREENSHOT_CREATED",
            sequence: 5,
            mapKey: "Woods",
            fileName: "2026-08-07[10-19]_55, 2, 66_0, 0, 0, 1_0.png",
            detectedAt: "2026-08-07T01:19:00.000Z",
          }],
          pagination: { afterCursor: 4, nextCursor: 5, hasMore: false },
        });
      }
      if (cursor === 0) {
        return trackerResponse({
          protocolVersion: 1,
          instanceId: "22222222222222222222222222222222",
          data: [{
            type: "SCREENSHOT_CREATED",
            sequence: 1,
            mapKey: "Customs",
            fileName: "2026-08-07[10-20]_77, 7, 133_0, 0, 0, 1_0.png",
            detectedAt: "2026-08-07T01:20:00.000Z",
          }],
          pagination: { afterCursor: 0, nextCursor: 1, hasMore: false },
        });
      }
      return trackerResponse({
        protocolVersion: 1,
        instanceId: "22222222222222222222222222222222",
        data: [],
        pagination: { afterCursor: cursor, nextCursor: cursor, hasMore: false },
      });
    });
    vi.stubGlobal("fetch", request);
    renderPage({ focusQuestId: "quest-customs" });

    expect(await screen.findByRole("button", { name: /플레이어 위치 X 77.*Z 133/ }))
      .toBeInTheDocument();
    expect(requestedCursors.slice(0, 2)).toEqual([4, 0]);
    expect(screen.getByRole("combobox", { name: "지도 선택" })).toHaveValue("Customs");
  });

  it("refreshes watcher status within five seconds and resumes from the existing cursor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));

    let statusCalls = 0;
    const statusCallTimes: number[] = [];
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/local-tracker/status")) {
        statusCalls += 1;
        statusCallTimes.push(Date.now());
        if (statusCalls === 1) {
          return trackerResponse({
            protocolVersion: 1,
            screenshotWatcher: { state: "WATCHING", folderPath: "C:\\Screenshots-A" },
            latestCursor: 0,
          });
        }
        if (statusCalls === 2) {
          return trackerResponse({
            protocolVersion: 1,
            screenshotWatcher: { state: "NOT_FOUND" },
            latestCursor: 1,
          });
        }
        if (statusCalls === 3) {
          return trackerResponse({
            protocolVersion: 1,
            screenshotWatcher: { state: "ERROR", message: "watcher failed" },
            latestCursor: 1,
          });
        }
        return trackerResponse({
          protocolVersion: 1,
          screenshotWatcher: { state: "WATCHING", folderPath: "C:\\Screenshots-B" },
          latestCursor: 1,
        });
      }

      const afterCursor = Number(new URL(url, "http://localhost").searchParams.get("afterCursor"));
      if (afterCursor === 0) {
        return trackerResponse({
          protocolVersion: 1,
          data: [{
            type: "SCREENSHOT_CREATED",
            sequence: 1,
            mapKey: "Customs",
            fileName: "2026-08-08[09-00]_10, 1, 10_0, 0, 0, 1_0.png",
            detectedAt: "2026-08-08T00:00:01.000Z",
          }],
          pagination: { afterCursor: 0, nextCursor: 1, hasMore: false },
        });
      }
      if (afterCursor === 1 && statusCalls >= 4) {
        return trackerResponse({
          protocolVersion: 1,
          data: [{
            type: "SCREENSHOT_CREATED",
            sequence: 2,
            mapKey: "Customs",
            fileName: "2026-08-08[09-01]_20, 1, 20_0, 0, 0, 1_0.png",
            detectedAt: "2026-08-08T00:00:02.000Z",
          }],
          pagination: { afterCursor: 1, nextCursor: 2, hasMore: false },
        });
      }
      return trackerResponse({
        protocolVersion: 1,
        data: [],
        pagination: { afterCursor, nextCursor: afterCursor, hasMore: false },
      });
    });
    vi.stubGlobal("fetch", request);

    const rendered = renderPage({ focusQuestId: "quest-customs" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(screen.getByRole("button", { name: /X 10.*Z 10/ }))
      .toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_300);
    });
    expect(statusCalls).toBeGreaterThanOrEqual(2);
    expect(statusCallTimes[1] - statusCallTimes[0]).toBeLessThanOrEqual(5_000);
    expect(document.querySelector(".map-tracker-status"))
      .toHaveAttribute("data-state", "not_found");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(document.querySelector(".map-tracker-status"))
      .toHaveAttribute("data-state", "error");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_400);
    });
    expect(screen.getByText("C:\\Screenshots-B")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(screen.getByRole("button", { name: /X 20.*Z 20/ }))
      .toBeInTheDocument();
    const trailPoints = screen.getByTestId("player-trail")
      .querySelector("polyline")
      ?.getAttribute("points")
      ?.split(" ") ?? [];
    expect(trailPoints).toHaveLength(2);

    rendered.unmount();
  });

  it("keeps only the most recent 50 player trail positions", () => {
    renderPage({ focusQuestId: "quest-customs" });
    const input = screen.getByLabelText("스크린샷 파일 선택");

    for (let index = 0; index < 52; index += 1) {
      fireEvent.change(input, {
        target: {
          files: [
            new File(
              [],
              `2026-08-07[10-20]_${index}, 1, ${index}_0, 0, 0, 1_16.74.png`,
            ),
          ],
        },
      });
    }

    const trail = screen.getByTestId("player-trail");
    const points = trail.querySelector("polyline")?.getAttribute("points")?.split(" ") ?? [];
    expect(points).toHaveLength(50);
    expect(trail.querySelectorAll("circle")).toHaveLength(49);
    expect(screen.getByRole("button", { name: /플레이어 위치 X 51.*Z 51/ })).toBeInTheDocument();
  });

  it("persists hidden basic marker types as profile-shared map settings", async () => {
    const { unmount } = renderPage({ focusQuestId: "quest-customs" }, true);
    const bossToggle = screen.getByRole("checkbox", { name: "보스 표시" });
    expect(bossToggle).toBeChecked();

    fireEvent.click(bossToggle);
    expect(screen.queryByRole("button", { name: "보스 마커 Reshala" })).not.toBeInTheDocument();
    expect(settingsState().map.hiddenMarkerTypes).toEqual(["BossSpawn"]);

    fireEvent.click(screen.getByRole("button", { name: "PVE 테스트 프로필" }));
    expect(screen.getByRole("checkbox", { name: "보스 표시" })).not.toBeChecked();
    expect(screen.queryByRole("button", { name: "보스 마커 Reshala" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(APP_STATE_STORAGE_KEY) ?? "{}").settings.map
          .hiddenMarkerTypes,
      ).toEqual(["BossSpawn"]),
    );

    unmount();
    renderPage({ focusQuestId: "quest-customs" });
    expect(screen.getByRole("checkbox", { name: "보스 표시" })).not.toBeChecked();
    expect(screen.queryByRole("button", { name: "보스 마커 Reshala" })).not.toBeInTheDocument();
  });

  it("offers a separate full-map marker settings menu", () => {
    renderPage({ focusQuestId: "quest-customs" }, true);

    fireEvent.click(screen.getByRole("button", { name: "전체 지도 마커 설정" }));
    const panel = screen.getByRole("group", { name: "전체 지도 마커 표시 설정" });
    expect(panel).toHaveClass("map-marker-layer-panel");
    expect(within(panel).getByText("전체 지도 레이어")).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: "마커 표시" })).toBeInTheDocument();
    expect(panel.querySelector(".map-marker-layer-grid")).toBeInTheDocument();
    expect(within(panel).queryByRole("checkbox", {
      name: "일반 퀘스트 마커 (선택 경로 제외)",
    })).not.toBeInTheDocument();
    expect(within(panel).getByRole("checkbox", { name: "PMC 탈출구 표시" })).toBeChecked();

    fireEvent.click(within(panel).getByRole("checkbox", { name: "PMC 탈출구 표시" }));
    expect(settingsState().map.showPmcExtracts).toBe(false);
    expect(settingsState().map.miniMapShowPmcExtracts).toBe(true);
  });

  it("shows extraction names on the mini-map by default", async () => {
    renderPage({ focusQuestId: "quest-customs" });

    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    const miniMap = await screen.findByTestId("map-minimap-fallback");
    const labels = within(miniMap).getAllByTestId("map-minimap-marker-label");

    expect(labels.map((label) => label.textContent)).toEqual(
      expect.arrayContaining(["Crossroads", "Co-op exit", "Transit to Factory"]),
    );
  });

  it("selects explicitly focused quest and extraction markers", () => {
    renderPage({ focusQuestId: "quest-customs" }, true);

    const marker = screen.getByRole("button", { name: "퀘스트 마커 기숙사 물방 방문" });
    expect(within(marker).queryByText("기숙사 물방 방문")).not.toBeInTheDocument();

    fireEvent.click(marker);
    expect(marker).toHaveAttribute("aria-pressed", "true");
    expect(within(marker).getByText("기숙사 물방 방문")).toBeInTheDocument();

    fireEvent.click(marker);
    expect(marker).toHaveAttribute("aria-pressed", "false");
    expect(within(marker).queryByText("기숙사 물방 방문")).not.toBeInTheDocument();

    const extraction = screen.getByRole("button", { name: "탈출구 마커 Crossroads" });
    fireEvent.click(extraction);
    expect(extraction).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(extraction);
    expect(extraction).toHaveAttribute("aria-pressed", "false");
  });

  it("does not render the removed active objective panel", () => {
    renderPage({ focusQuestId: "quest-customs" }, true);
    expect(screen.queryByRole("region", { name: "활성 퀘스트 목표" })).not.toBeInTheDocument();
  });

  it("renders optional quest points as numbered orange choices with distinct tooltips", () => {
    renderPage({ focusQuestId: "quest-customs" });

    const regularMarker = screen.getByRole("button", {
      name: "퀘스트 마커 기숙사 물방 방문",
    });
    const firstChoice = screen.getByRole("button", {
      name: "선택 1 퀘스트 마커 기숙사 물방 방문",
    });
    const secondChoice = screen.getByRole("button", {
      name: "선택 2 퀘스트 마커 기숙사 물방 방문",
    });

    expect(regularMarker).not.toHaveClass("optional");
    expect(firstChoice).toHaveClass("optional");
    expect(secondChoice).toHaveClass("optional");
    expect(within(firstChoice).getByText("선택 1")).toBeInTheDocument();
    expect(within(secondChoice).getByText("선택 2")).toBeInTheDocument();
    expect(firstChoice).toHaveAttribute(
      "title",
      "[선택 1] 물방 찾기 · 기숙사 물방 방문",
    );
  });

  it("creates, edits, and deletes profile-specific custom markers", () => {
    renderPage({ focusQuestId: "quest-customs" }, true);

    fireEvent.click(screen.getByRole("button", { name: "커스텀 마커 추가" }));
    const dialog = screen.getByRole("dialog", { name: "커스텀 마커 추가" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "마커 이름" }), {
      target: { value: "팀 집결지" },
    });
    expect(within(dialog).getAllByRole("radio", { name: /마커 색상/ })).toHaveLength(8);
    fireEvent.click(within(dialog).getByRole("radio", { name: "마커 색상 파랑" }));
    fireEvent.change(within(dialog).getByRole("slider", { name: "마커 크기" }), {
      target: { value: "40" },
    });
    fireEvent.change(within(dialog).getByRole("slider", { name: "마커 투명도" }), {
      target: { value: "0.6" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "마커 저장" }));

    const customMarker = screen.getByRole("button", { name: "커스텀 마커 팀 집결지" });
    expect(customMarker).toHaveStyle({ opacity: "0.6" });
    expect(profileState().customMarkers[0]).toMatchObject({
      mapKey: "Customs",
      name: "팀 집결지",
      color: "#4f8cff",
      size: 40,
      opacity: 0.6,
      floorId: "main",
    });

    fireEvent.click(customMarker);
    const editDialog = screen.getByRole("dialog", { name: "커스텀 마커 수정" });
    fireEvent.change(within(editDialog).getByRole("textbox", { name: "마커 이름" }), {
      target: { value: "새 집결지" },
    });
    fireEvent.click(within(editDialog).getByRole("button", { name: "마커 저장" }));
    expect(screen.getByRole("button", { name: "커스텀 마커 새 집결지" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "PVE 테스트 프로필" }));
    expect(screen.queryByRole("button", { name: "커스텀 마커 새 집결지" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "PVP 테스트 프로필" }));
    fireEvent.click(screen.getByRole("button", { name: "커스텀 마커 새 집결지" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "커스텀 마커 수정" })).getByRole("button", { name: "마커 삭제" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "커스텀 마커 삭제" })).getByRole("button", { name: "삭제 확인" }));
    expect(screen.queryByRole("button", { name: "커스텀 마커 새 집결지" })).not.toBeInTheDocument();
  });

  it("uses one tabbable native color radio and supports arrow-key selection", () => {
    renderPage({ focusQuestId: "quest-customs" }, true);
    fireEvent.click(screen.getByRole("button", { name: "커스텀 마커 추가" }));

    const dialog = screen.getByRole("dialog", { name: "커스텀 마커 추가" });
    const colorGroup = within(dialog).getByRole("group", { name: "마커 색상" });
    const radios = within(colorGroup).getAllByRole("radio");
    const gold = within(colorGroup).getByRole("radio", { name: "마커 색상 금색" });
    const red = within(colorGroup).getByRole("radio", { name: "마커 색상 빨강" });

    expect(radios).toHaveLength(8);
    expect(radios.every((radio) => radio.tagName === "INPUT")).toBe(true);
    expect(gold).toBeChecked();
    expect(radios.filter((radio) => radio.tabIndex === 0)).toEqual([gold]);

    gold.focus();
    fireEvent.keyDown(gold, { key: "ArrowRight" });
    expect(red).toBeChecked();
    expect(red).toHaveFocus();
    expect(radios.filter((radio) => radio.tabIndex === 0)).toEqual([red]);

    fireEvent.change(within(dialog).getByRole("textbox", { name: "마커 이름" }), {
      target: { value: "키보드 색상" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "마커 저장" }));
    expect(profileState().customMarkers[0]).toMatchObject({
      name: "키보드 색상",
      color: "#ef5350",
    });
  });

  it("uses native dialogs, restores opener focus, and confirms marker deletion", async () => {
    const state = createDefaultState();
    state.settings.map.lastMapKey = "Customs";
    state.profiles.pvp.customMarkers = [
      {
        id: "dialog-marker",
        mapKey: "Customs",
        name: "삭제 확인 지점",
        x: 200,
        y: 1,
        z: 240,
        floorId: "main",
        color: "#d9b83f",
        size: 24,
        opacity: 1,
        createdAt: "2026-08-07T00:00:00.000Z",
      },
    ];
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
    renderPage({}, true);

    const addButton = screen.getByRole("button", { name: "커스텀 마커 추가" });
    addButton.focus();
    fireEvent.click(addButton);
    const createDialog = screen.getByRole("dialog", { name: "커스텀 마커 추가" });
    expect(createDialog.tagName).toBe("DIALOG");
    expect(createDialog).toHaveAttribute("open");
    fireEvent.click(within(createDialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(addButton).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "커스텀 마커 삭제 확인 지점" }));
    const editDialog = screen.getByRole("dialog", { name: "커스텀 마커 수정" });
    fireEvent.click(within(editDialog).getByRole("button", { name: "마커 삭제" }));

    const confirmDialog = screen.getByRole("dialog", { name: "커스텀 마커 삭제" });
    expect(confirmDialog.tagName).toBe("DIALOG");
    expect(screen.getByRole("button", { name: "커스텀 마커 삭제 확인 지점" })).toBeInTheDocument();
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "취소" }));
    await waitFor(() =>
      expect(within(editDialog).getByRole("button", { name: "마커 삭제" })).toHaveFocus(),
    );

    fireEvent.click(within(editDialog).getByRole("button", { name: "마커 삭제" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "커스텀 마커 삭제" })).getByRole(
        "button",
        { name: "삭제 확인" },
      ),
    );
    expect(screen.queryByRole("button", { name: "커스텀 마커 삭제 확인 지점" })).not.toBeInTheDocument();
    expect(profileState().customMarkers).toEqual([]);
  });

  it("lists profile markers from every map and navigates, edits, and deletes them", async () => {
    const state = createDefaultState();
    state.settings.map.lastMapKey = "Customs";
    state.profiles.pvp.customMarkers = [
      {
        id: "customs-list-marker",
        mapKey: "Customs",
        name: "기숙사 집결",
        x: 250,
        y: 7,
        z: 280,
        floorId: "level2",
        color: "#d9b83f",
        size: 24,
        opacity: 1,
        createdAt: "2026-08-07T00:00:00.000Z",
      },
      {
        id: "woods-list-marker",
        mapKey: "Woods",
        name: "숲 은닉처",
        x: 340,
        y: 2,
        z: 360,
        color: "#4fc27d",
        size: 24,
        opacity: 1,
        createdAt: "2026-08-07T00:01:00.000Z",
      },
    ];
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
    renderPage({}, true);

    const markerList = screen.getByRole("region", { name: "커스텀 마커 목록" });
    expect(within(markerList).getByText("기숙사 집결")).toBeInTheDocument();
    expect(within(markerList).getByText(/Customs · Level 2/)).toBeInTheDocument();
    expect(within(markerList).getByText("숲 은닉처")).toBeInTheDocument();
    expect(within(markerList).getByText(/Woods · 단일 층/)).toBeInTheDocument();

    fireEvent.click(within(markerList).getByRole("button", { name: "숲 은닉처 위치로 이동" }));
    expect(screen.getByRole("combobox", { name: "지도 선택" })).toHaveValue("Woods");
    expect(screen.getByRole("button", { name: "커스텀 마커 숲 은닉처" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("map-world")).not.toHaveAttribute("data-pan", "0,0");

    fireEvent.click(within(markerList).getByRole("button", { name: "기숙사 집결 위치로 이동" }));
    expect(screen.getByRole("combobox", { name: "지도 선택" })).toHaveValue("Customs");
    expect(screen.getByRole("button", { name: "Level 2" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "커스텀 마커 기숙사 집결" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const editButton = within(markerList).getByRole("button", { name: "숲 은닉처 편집" });
    editButton.focus();
    fireEvent.click(editButton);
    const editDialog = screen.getByRole("dialog", { name: "커스텀 마커 수정" });
    expect(within(editDialog).getByRole("textbox", { name: "마커 이름" })).toHaveValue("숲 은닉처");
    fireEvent.click(within(editDialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(editButton).toHaveFocus());

    const deleteButton = within(markerList).getByRole("button", { name: "숲 은닉처 삭제" });
    deleteButton.focus();
    fireEvent.click(deleteButton);
    const confirmDialog = screen.getByRole("dialog", { name: "커스텀 마커 삭제" });
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(deleteButton).toHaveFocus());
    expect(within(markerList).getByText("숲 은닉처")).toBeInTheDocument();
  });

  it("opens marker creation at an empty double-click position", () => {
    renderPage({ focusQuestId: "quest-customs" });
    fireEvent.doubleClick(screen.getByTestId("map-viewport"), {
      clientX: 320,
      clientY: 240,
    });
    expect(screen.getByRole("dialog", { name: "커스텀 마커 추가" })).toBeInTheDocument();
  });

  it("honors persisted fixed-view state without auto-centering a new player position", () => {
    const state = createDefaultState();
    state.settings.map.lastMapKey = "Customs";
    state.settings.map.fixedView = true;
    window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
    renderPage();

    const before = screen.getByTestId("map-world").getAttribute("style");
    fireEvent.change(screen.getByLabelText("스크린샷 파일 선택"), {
      target: {
        files: [
          new File(
            [],
            "2026-08-07[10-20]_300, 7, 350_0, 0.7071068, 0, 0.7071068_16.74.png",
          ),
        ],
      },
    });
    expect(screen.getByTestId("map-world").getAttribute("style")).toBe(before);
  });
});
