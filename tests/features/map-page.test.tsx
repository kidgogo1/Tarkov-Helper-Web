import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_STATE_STORAGE_KEY,
  AppStoreProvider,
  createDefaultState,
  useAppStore,
} from "../../src/app/store";
import { MapPage } from "../../src/features/map/MapPage";
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
) {
  return render(
    <AppStoreProvider>
      <MapPage data={data} {...props} />
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

describe("MapPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
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

    fireEvent.click(screen.getByRole("checkbox", { name: "퀘스트 마커 표시" }));
    expect(screen.queryByRole("button", { name: /퀘스트 마커/ })).not.toBeInTheDocument();
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

  it("tracks objective progress and selects its corresponding marker", () => {
    renderPage({ focusQuestId: "quest-customs" }, true);

    const objective = screen.getByRole("checkbox", { name: "기숙사 물방 방문 완료" });
    fireEvent.click(objective);
    expect(profileState().objectiveProgress["objective-main"]).toBe(true);

    const marker = screen.getByRole("button", { name: "퀘스트 마커 기숙사 물방 방문" });
    fireEvent.click(marker);
    expect(marker).toHaveAttribute("aria-pressed", "true");
  });

  it("lists every active objective with progress, grouping, filters, and cross-map focus", () => {
    renderPage({ focusQuestId: "quest-customs" }, true);
    const drawer = screen.getByRole("region", { name: "활성 퀘스트 목표" });

    expect(within(drawer).getByRole("progressbar", { name: "전체 목표 진행률" })).toHaveAttribute(
      "value",
      "0",
    );
    expect(within(drawer).getByText("0/3 완료")).toBeInTheDocument();

    const currentMapOnly = within(drawer).getByRole("checkbox", { name: "현재 지도만" });
    expect(currentMapOnly).toBeChecked();
    expect(within(drawer).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "물방 찾기",
    ]);
    expect(within(drawer).queryByText("벌목장 표시")).not.toBeInTheDocument();

    fireEvent.click(currentMapOnly);
    expect(within(drawer).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "물방 찾기",
      "숲길 확인",
    ]);
    expect(within(drawer).getAllByTestId("map-objective-item").map((item) => item.textContent)).toEqual([
      expect.stringContaining("기숙사 물방 방문"),
      expect.stringContaining("2층 문서 획득"),
      expect.stringContaining("벌목장 표시"),
    ]);

    fireEvent.change(within(drawer).getByRole("combobox", { name: "목표 유형 필터" }), {
      target: { value: "visit" },
    });
    expect(within(drawer).getByText("기숙사 물방 방문")).toBeInTheDocument();
    expect(within(drawer).queryByText("2층 문서 획득")).not.toBeInTheDocument();
    expect(within(drawer).queryByText("벌목장 표시")).not.toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole("checkbox", { name: "기숙사 물방 방문 완료" }));
    expect(within(drawer).getByText("1/3 완료")).toBeInTheDocument();
    fireEvent.change(within(drawer).getByRole("combobox", { name: "완료 상태 필터" }), {
      target: { value: "completed" },
    });
    expect(within(drawer).getByText("기숙사 물방 방문")).toBeInTheDocument();

    fireEvent.change(within(drawer).getByRole("combobox", { name: "완료 상태 필터" }), {
      target: { value: "all" },
    });
    fireEvent.change(within(drawer).getByRole("combobox", { name: "목표 유형 필터" }), {
      target: { value: "all" },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "벌목장 표시 마커 선택" }));

    expect(screen.getByRole("combobox", { name: "지도 선택" })).toHaveValue("Woods");
    expect(screen.getByRole("img", { name: "Woods 지도" })).toHaveAttribute(
      "data",
      "/assets/maps/Woods.svg",
    );
    expect(screen.getByRole("button", { name: "퀘스트 마커 벌목장 표시" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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
