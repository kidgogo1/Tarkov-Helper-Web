import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from "react";
import {
  Crosshair,
  Focus,
  LocateFixed,
  Maximize2,
  Minimize2,
  Navigation,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Trash2,
  Upload,
} from "lucide-react";

import { useAppStore } from "../../app/store";
import { Dialog } from "../../components/Dialog";
import { MapMiniMap } from "./MapMiniMap";
import {
  applySvgFloorVisibility,
  detectFloor,
  detectFloorByY,
  getMapDirectionAngle,
  inverseMapPosition,
  parseScreenshotFilename,
  transformMapPosition,
  type ScreenPoint,
  type ScreenshotPosition,
} from "../../domain/map";
import { createQuestStatusResolver } from "../../domain/quests";
import {
  fetchLocalTrackerEvents,
  fetchLocalTrackerStatus,
  type ScreenshotWatcherStatus,
} from "../../services/local-tracker";
import type {
  MapConfig,
  MapMarker,
  QuestData,
  QuestObjective,
  TarkovData,
  WorldPoint,
} from "../../types/data";
import type { CustomMapMarker } from "../../types/state";
import "../../styles/map.css";

export interface MapPageProps {
  data: TarkovData;
  focusQuestId?: string;
  onOpenQuest?: (questId: string) => void;
  onOpenMiniMapSettings?: () => void;
  onQuestFocusConsumed?: () => void;
}

interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}

interface PlayerMapPosition extends ScreenshotPosition {
  z: number;
  screen: ScreenPoint;
  floorId?: string;
  sequence: number;
}

type LocalTrackerViewState =
  | { state: "CHECKING" }
  | ScreenshotWatcherStatus
  | { state: "UNAVAILABLE" };

interface QuestMapPoint {
  id: string;
  quest: QuestData;
  objective: QuestObjective;
  point: WorldPoint;
  screen: ScreenPoint;
  floorId?: string;
  isOptional: boolean;
  optionalIndex?: number;
}

interface ObjectiveEntry {
  quest: QuestData;
  objective: QuestObjective;
}

interface PendingMapFocus {
  mapKey: string;
  screen: ScreenPoint;
  markerId: string;
  floorId?: string;
}

type ViewIntent =
  | { kind: "fit"; mapKey: string }
  | { kind: "focus"; mapKey: string; point: ScreenPoint; scale: "fit" | number }
  | { kind: "manual"; mapKey: string };

type ObjectiveStatusFilter = "all" | "incomplete" | "completed";

interface MarkerEditorState {
  marker: CustomMapMarker;
  isNew: boolean;
}

const EMPTY_MAP: MapConfig = {
  key: "",
  displayName: "지도 없음",
  svgFileName: "",
  imageWidth: 1,
  imageHeight: 1,
  aliases: [],
  floors: [],
};

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.2;
const KEYBOARD_PAN_STEP = 40;
const LOCAL_TRACKER_POLL_INTERVAL_MS = 650;
const LOCAL_TRACKER_STATUS_REFRESH_INTERVAL_MS = 4_000;

function localTrackerStatusLabel(tracker: LocalTrackerViewState): string {
  switch (tracker.state) {
    case "CHECKING":
      return "로컬 실행기 연결 확인 중";
    case "WATCHING":
      return "자동 위치 추적 중";
    case "NOT_FOUND":
      return "스크린샷 폴더를 찾지 못했습니다";
    case "ERROR":
      return "자동 위치 추적 오류";
    case "UNAVAILABLE":
      return "브라우저 수동 모드";
  }
}

function localTrackerNote(tracker: LocalTrackerViewState): {
  title: string;
  description: string;
} {
  switch (tracker.state) {
    case "WATCHING":
      return {
        title: "폴더 자동 감지",
        description: `${tracker.folderPath}에서 새 EFT 스크린샷 파일을 자동 감지합니다. 필요하면 아래 파일 선택도 계속 사용할 수 있습니다.`,
      };
    case "NOT_FOUND":
      return {
        title: "폴더 확인 필요",
        description: "Escape from Tarkov 스크린샷 폴더를 찾지 못했습니다. 폴더가 생성될 때까지 파일 선택을 사용할 수 있습니다.",
      };
    case "ERROR":
      return {
        title: "자동 감지 일시 중지",
        description: "로컬 실행기의 폴더 감시를 시작하지 못했습니다. 파일 선택은 계속 사용할 수 있습니다.",
      };
    case "CHECKING":
      return {
        title: "로컬 연결 확인 중",
        description: "브라우저는 게임 로그나 스크린샷 폴더를 백그라운드에서 감시할 수 없습니다. 로컬 실행기 연결을 확인하는 동안 파일 선택을 사용할 수 있습니다.",
      };
    case "UNAVAILABLE":
      return {
        title: "수동 파일 선택",
        description: "브라우저는 게임 로그나 스크린샷 폴더를 백그라운드에서 감시할 수 없습니다. 자동 감지를 사용하려면 로컬 실행기로 열고, 웹에서는 파일을 직접 선택하세요.",
      };
  }
}

function bundledAsset(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;
}

const CUSTOM_MARKER_COLORS = [
  { value: "#d9b83f", label: "금색" },
  { value: "#ef5350", label: "빨강" },
  { value: "#ff8a3d", label: "주황" },
  { value: "#4fc27d", label: "초록" },
  { value: "#4f8cff", label: "파랑" },
  { value: "#a970ff", label: "보라" },
  { value: "#ef6db3", label: "분홍" },
  { value: "#e7e9e6", label: "흰색" },
] as const;

const BASIC_MARKER_LABELS: Record<string, string> = {
  BossSpawn: "보스",
  CultistSpawn: "컬티스트",
  Lever: "레버",
  PmcSpawn: "PMC 스폰",
  RaiderSpawn: "레이더",
  RogueSpawn: "로그",
  ScavSpawn: "스캐브 스폰",
  SniperScavSpawn: "스나이퍼 스캐브",
};

const BASIC_MARKER_ICONS: Record<string, string> = {
  BossSpawn: bundledAsset("assets/map-icons/BOSS%20Spawn.webp"),
  CultistSpawn: bundledAsset("assets/map-icons/Markers/Cultist.svg"),
  Lever: bundledAsset("assets/map-icons/Markers/Lever.svg"),
  PmcSpawn: bundledAsset("assets/map-icons/PMC%20Spawn.webp"),
  RaiderSpawn: bundledAsset("assets/map-icons/Raider%20Spawn.webp"),
  RogueSpawn: bundledAsset("assets/map-icons/Markers/Rogue.svg"),
  ScavSpawn: bundledAsset("assets/map-icons/SCAV%20Spawn.webp"),
  SniperScavSpawn: bundledAsset("assets/map-icons/Markers/SniperScav.svg"),
};

const EXTRACT_MARKER_ICONS: Record<string, string> = {
  PmcExtraction: bundledAsset("assets/map-icons/PMC%20Extraction.webp"),
  ScavExtraction: bundledAsset("assets/map-icons/SCAV%20Extraction.webp"),
  SharedExtraction: bundledAsset("assets/map-icons/PMC%20Extraction.webp"),
  Transit: bundledAsset("assets/map-icons/Transit.webp"),
};

const QUEST_MARKER_TYPES = new Map(
  ["Build", "Collect", "Custom", "HandOver", "Kill", "Mark", "Stash", "Survive", "Task", "Visit"].map(
    (type) => [type.toLocaleLowerCase("en-US"), type],
  ),
);

function normalized(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[\s_-]+/g, "");
}

function mapMatches(config: MapConfig, name: string | undefined): boolean {
  const candidate = normalized(name);
  if (!candidate) return false;
  return [config.key, config.displayName, ...config.aliases].some(
    (value) => normalized(value) === candidate,
  );
}

function findMapConfig(
  configs: readonly MapConfig[],
  name: string | undefined,
): MapConfig | undefined {
  return configs.find((config) => mapMatches(config, name));
}

function focusedQuestMap(
  data: TarkovData,
  focusQuestId: string | undefined,
): MapConfig | undefined {
  if (!focusQuestId) return undefined;
  const quest = data.quests.find(
    (candidate) =>
      candidate.id === focusQuestId || candidate.normalizedName === focusQuestId,
  );
  if (!quest) return undefined;

  for (const mapName of [
    ...quest.objectives.map((objective) => objective.mapName),
    ...quest.locations,
  ]) {
    const config = findMapConfig(data.mapConfigs, mapName);
    if (config) return config;
  }
  return undefined;
}

function defaultFloor(config: MapConfig): string | undefined {
  return (
    config.floors.find((floor) => floor.isDefault)?.layerId ??
    [...config.floors].sort((left, right) => left.order - right.order)[0]?.layerId
  );
}

function localQuestName(quest: QuestData): string {
  return quest.nameKo || quest.name || quest.nameEn;
}

function questAppliesToMap(quest: QuestData, config: MapConfig): boolean {
  return [
    ...quest.locations,
    ...quest.objectives.map((objective) => objective.mapName),
  ].some((mapName) => mapMatches(config, mapName));
}

function questSearchText(quest: QuestData): string {
  return normalized([
    localQuestName(quest),
    quest.name,
    quest.nameEn,
    quest.normalizedName,
    quest.trader,
    ...quest.objectives.map((objective) => objective.description),
  ].join(" "));
}

function objectiveAppliesToMap(entry: ObjectiveEntry, config: MapConfig): boolean {
  return entry.objective.mapName
    ? mapMatches(config, entry.objective.mapName)
    : entry.quest.locations.some((location) => mapMatches(config, location));
}

function objectiveTargetMap(
  entry: ObjectiveEntry,
  configs: readonly MapConfig[],
  currentConfig: MapConfig,
): MapConfig | undefined {
  if (objectiveAppliesToMap(entry, currentConfig)) return currentConfig;

  for (const mapName of [entry.objective.mapName, ...entry.quest.locations]) {
    const config = findMapConfig(configs, mapName);
    if (config) return config;
  }
  return undefined;
}

function objectiveTypeLabel(type: string): string {
  switch (type.toLocaleLowerCase("en-US")) {
    case "visit":
      return "Visit";
    case "mark":
      return "Mark";
    case "plantitem":
      return "Plant";
    case "extract":
      return "Extract";
    case "finditem":
      return "Find";
    default:
      return type;
  }
}

function buildQuestMapPoints(
  entry: ObjectiveEntry,
  config: MapConfig,
  floorLocations: TarkovData["mapFloorLocations"],
): QuestMapPoint[] {
  if (!objectiveAppliesToMap(entry, config)) return [];

  const buildPoint = (
    point: WorldPoint,
    index: number,
    isOptional: boolean,
  ): QuestMapPoint[] => {
    const screen = transformMapPosition(config, point.x, point.z);
    if (!screen) return [];
    const floorId =
      point.floorId ??
      detectFloor(floorLocations, config.key, point.x, point.y, point.z) ??
      undefined;
    return [
      {
        id: `quest:${entry.quest.id}:${entry.objective.id}:${isOptional ? "optional" : "point"}:${index}`,
        quest: entry.quest,
        objective: entry.objective,
        point,
        screen,
        floorId,
        isOptional,
        optionalIndex: isOptional ? index + 1 : undefined,
      },
    ];
  };

  return [
    ...entry.objective.locationPoints.flatMap((point, index) =>
      buildPoint(point, index, false),
    ),
    ...entry.objective.optionalPoints.flatMap((point, index) =>
      buildPoint(point, index, true),
    ),
  ];
}

function focusedQuestPoint(
  data: TarkovData,
  focusQuestId: string | undefined,
  config: MapConfig | undefined,
): QuestMapPoint | undefined {
  if (!focusQuestId || !config) return undefined;
  const quest = data.quests.find(
    (candidate) =>
      candidate.id === focusQuestId || candidate.normalizedName === focusQuestId,
  );
  if (!quest) return undefined;

  for (const objective of quest.objectives) {
    const point = buildQuestMapPoints(
      { quest, objective },
      config,
      data.mapFloorLocations,
    )[0];
    if (point) return point;
  }
  return undefined;
}

function fittedView(
  config: MapConfig,
  viewportWidth: number,
  viewportHeight: number,
  focus?: ScreenPoint,
): ViewTransform | undefined {
  if (
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    config.imageWidth <= 0 ||
    config.imageHeight <= 0
  ) {
    return undefined;
  }
  const scale = Math.min(
    viewportWidth / config.imageWidth,
    viewportHeight / config.imageHeight,
    MAX_ZOOM,
  );
  return {
    scale,
    x: focus
      ? viewportWidth / 2 - focus.x * scale
      : (viewportWidth - config.imageWidth * scale) / 2,
    y: focus
      ? viewportHeight / 2 - focus.y * scale
      : (viewportHeight - config.imageHeight * scale) / 2,
  };
}

function isExtractionType(markerType: string): boolean {
  const value = markerType.toLocaleLowerCase("en-US");
  return value.includes("extraction") || value === "transit";
}

function extractionMarkerVisible(
  markerType: string,
  settings: ReturnType<typeof useAppStore>["settings"]["map"],
): boolean {
  if (!settings.showExtractMarkers) return false;
  switch (markerType) {
    case "PmcExtraction":
      return settings.showPmcExtracts;
    case "ScavExtraction":
      return settings.showScavExtracts;
    case "SharedExtraction":
      return settings.showPmcExtracts || settings.showScavExtracts;
    case "Transit":
      return settings.showTransits;
    default:
      return true;
  }
}

function markerLabel(markerType: string): string {
  return BASIC_MARKER_LABELS[markerType] ?? markerType;
}

function markerIcon(markerType: string): string | undefined {
  return BASIC_MARKER_ICONS[markerType] ?? EXTRACT_MARKER_ICONS[markerType];
}

function questMarkerIcon(objectiveType: string): string {
  const type = QUEST_MARKER_TYPES.get(objectiveType.toLocaleLowerCase("en-US")) ?? "Custom";
  return bundledAsset(`assets/map-icons/Quest_${type}.svg`);
}

function formatCoordinate(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function markerFloorVisible(
  markerFloor: string | undefined,
  selectedFloor: string | undefined,
): boolean {
  return !selectedFloor || !markerFloor || markerFloor === selectedFloor;
}

function markerScreenPosition(
  config: MapConfig,
  marker: Pick<MapMarker, "x" | "z"> | Pick<CustomMapMarker, "x" | "z">,
): ScreenPoint | null {
  return transformMapPosition(config, marker.x, marker.z);
}

function createMarkerId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `custom-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function CustomMarkerEditor({
  editor,
  floors,
  onCancel,
  onChange,
  onDelete,
  onSave,
}: {
  editor: MarkerEditorState;
  floors: MapConfig["floors"];
  onCancel: () => void;
  onChange: (marker: CustomMapMarker) => void;
  onDelete: (opener: HTMLButtonElement) => void;
  onSave: () => void;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (editor.marker.name.trim()) onSave();
  };

  const moveColorSelection = (
    event: ReactKeyboardEvent<HTMLInputElement>,
    currentIndex: number,
  ) => {
    let nextIndex: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % CUSTOM_MARKER_COLORS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex =
        (currentIndex - 1 + CUSTOM_MARKER_COLORS.length) %
        CUSTOM_MARKER_COLORS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = CUSTOM_MARKER_COLORS.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const radioGroup = event.currentTarget.closest(".map-color-grid");
    const nextRadio = radioGroup?.querySelectorAll<HTMLInputElement>(
      'input[type="radio"]',
    )[nextIndex];
    onChange({ ...editor.marker, color: CUSTOM_MARKER_COLORS[nextIndex].value });
    nextRadio?.focus();
  };

  return (
    <Dialog
      description="이 마커는 현재 프로필에만 저장됩니다."
      footer={
        <>
          {!editor.isNew ? (
            <button
              className="danger map-delete-marker"
              onClick={(event) => onDelete(event.currentTarget)}
              type="button"
            >
              <Trash2 aria-hidden="true" size={16} /> 마커 삭제
            </button>
          ) : null}
          <span className="map-dialog-spacer" />
          <button onClick={onCancel} type="button">취소</button>
          <button
            className="primary"
            disabled={!editor.marker.name.trim()}
            form="custom-marker-form"
            type="submit"
          >
            마커 저장
          </button>
        </>
      }
      onClose={onCancel}
      open
      title={editor.isNew ? "커스텀 마커 추가" : "커스텀 마커 수정"}
    >
        <form className="map-marker-form" id="custom-marker-form" onSubmit={submit}>
          <label className="map-field">
            <span>마커 이름</span>
            <input
              aria-label="마커 이름"
              autoFocus
              maxLength={60}
              onChange={(event) =>
                onChange({ ...editor.marker, name: event.target.value })
              }
              placeholder="예: 팀 집결지"
              required
              type="text"
              value={editor.marker.name}
            />
          </label>

          <fieldset className="map-color-fieldset">
            <legend>마커 색상</legend>
            <div className="map-color-grid">
              {CUSTOM_MARKER_COLORS.map((color, index) => {
                const selected = editor.marker.color === color.value;
                return (
                  <label
                    className={`map-color-choice${selected ? " selected" : ""}`}
                    key={color.value}
                    style={{ "--marker-color": color.value } as CSSProperties}
                  >
                    <input
                      aria-label={`마커 색상 ${color.label}`}
                      checked={selected}
                      className="sr-only"
                      name="custom-marker-color"
                      onChange={() =>
                        onChange({ ...editor.marker, color: color.value })
                      }
                      onKeyDown={(event) => moveColorSelection(event, index)}
                      tabIndex={selected ? 0 : -1}
                      type="radio"
                      value={color.value}
                    />
                    <span aria-hidden="true" />
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="map-dialog-grid">
            <label className="map-field">
              <span>층</span>
              <select
                aria-label="마커 층"
                disabled={floors.length === 0}
                onChange={(event) =>
                  onChange({
                    ...editor.marker,
                    floorId: event.target.value || undefined,
                  })
                }
                value={editor.marker.floorId ?? ""}
              >
                {floors.length === 0 ? <option value="">단일 층</option> : null}
                {floors.map((floor) => (
                  <option key={floor.layerId} value={floor.layerId}>
                    {floor.displayName}
                  </option>
                ))}
              </select>
            </label>

            <label className="map-field map-range-field">
              <span>
                마커 크기 <strong>{editor.marker.size}px</strong>
              </span>
              <input
                aria-label="마커 크기"
                max="64"
                min="12"
                onChange={(event) =>
                  onChange({ ...editor.marker, size: Number(event.target.value) })
                }
                step="1"
                type="range"
                value={editor.marker.size}
              />
            </label>
          </div>

          <label className="map-field map-range-field">
            <span>
              마커 투명도 <strong>{Math.round(editor.marker.opacity * 100)}%</strong>
            </span>
            <input
              aria-label="마커 투명도"
              max="1"
              min="0.1"
              onChange={(event) =>
                onChange({ ...editor.marker, opacity: Number(event.target.value) })
              }
              step="0.05"
              type="range"
              value={editor.marker.opacity}
            />
          </label>

          <p className="map-dialog-coordinates">
            X {formatCoordinate(editor.marker.x)} · Y {formatCoordinate(editor.marker.y)} · Z{" "}
            {formatCoordinate(editor.marker.z)}
          </p>
        </form>
    </Dialog>
  );
}

export function MapPage({
  data,
  focusQuestId,
  onOpenMiniMapSettings,
  onOpenQuest,
  onQuestFocusConsumed,
}: MapPageProps) {
  const {
    profile,
    settings,
    setObjectiveProgress,
    upsertCustomMarker,
    deleteCustomMarker,
    updateMapSettings,
  } = useAppStore();
  const mapSettings = settings.map;
  const questStatusResolver = useMemo(
    () => createQuestStatusResolver(data.quests, profile),
    [data.quests, profile],
  );

  const initialConfig =
    focusedQuestMap(data, focusQuestId) ??
    findMapConfig(data.mapConfigs, mapSettings.lastMapKey) ??
    data.mapConfigs[0];
  const initialQuestPoint = focusedQuestPoint(data, focusQuestId, initialConfig);
  const [selectedMapKey, setSelectedMapKey] = useState(initialConfig?.key ?? "");
  const config =
    findMapConfig(data.mapConfigs, selectedMapKey) ?? data.mapConfigs[0] ?? EMPTY_MAP;
  const hasMaps = data.mapConfigs.length > 0;
  const orderedFloors = useMemo(
    () => [...config.floors].sort((left, right) => left.order - right.order),
    [config.floors],
  );
  const [selectedFloor, setSelectedFloor] = useState<string | undefined>(() =>
    initialConfig ? defaultFloor(initialConfig) : undefined,
  );
  const [focusedQuestId, setFocusedQuestId] = useState(focusQuestId);
  const [view, setView] = useState<ViewTransform>({ scale: 1, x: 0, y: 0 });
  const hiddenBasicTypes = useMemo(
    () => new Set(mapSettings.hiddenMarkerTypes),
    [mapSettings.hiddenMarkerTypes],
  );
  const [selectedMarkerId, setSelectedMarkerId] = useState<string>();
  const [objectiveStatusFilter, setObjectiveStatusFilter] =
    useState<ObjectiveStatusFilter>("all");
  const [objectiveTypeFilter, setObjectiveTypeFilter] = useState("all");
  const [regionQuestQuery, setRegionQuestQuery] = useState("");
  const [currentMapObjectivesOnly, setCurrentMapObjectivesOnly] = useState(true);
  const [groupObjectivesByQuest, setGroupObjectivesByQuest] = useState(true);
  const [playerPositions, setPlayerPositions] = useState<PlayerMapPosition[]>([]);
  const [positionError, setPositionError] = useState("");
  const [localTracker, setLocalTracker] = useState<LocalTrackerViewState>({
    state: "CHECKING",
  });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const [editor, setEditor] = useState<MarkerEditorState>();
  const [deleteCandidate, setDeleteCandidate] = useState<CustomMapMarker>();
  const pageRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const mapObjectRef = useRef<HTMLObjectElement>(null);
  const consumedQuestRef = useRef<string | undefined>(undefined);
  const previousMapRef = useRef(config.key);
  const pendingMapFocusRef = useRef<PendingMapFocus | undefined>(undefined);
  const viewIntentRef = useRef<ViewIntent>(
    initialQuestPoint
      ? {
          kind: "focus",
          mapKey: initialConfig?.key ?? "",
          point: initialQuestPoint.screen,
          scale: "fit",
        }
      : { kind: "fit", mapKey: initialConfig?.key ?? "" },
  );
  const editorOpenerRef = useRef<HTMLElement | null>(null);
  const deleteOpenerRef = useRef<HTMLElement | null>(null);
  const addMarkerButtonRef = useRef<HTMLButtonElement>(null);
  const playerSequenceRef = useRef(0);
  const applyScreenshotFileNameRef = useRef<(fileName: string) => void>(() => undefined);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | undefined>(undefined);

  const syncSvgFloors = useCallback(() => {
    const svgDocument = mapObjectRef.current?.contentDocument;
    if (svgDocument) {
      applySvgFloorVisibility(svgDocument, orderedFloors, selectedFloor);
    }
  }, [orderedFloors, selectedFloor]);

  useEffect(() => {
    syncSvgFloors();
  }, [syncSvgFloors]);

  const applyViewIntent = useCallback(() => {
    const viewport = viewportRef.current;
    const intent = viewIntentRef.current;
    if (!viewport || intent.mapKey !== config.key || intent.kind === "manual") return false;
    const { width, height } = viewport.getBoundingClientRect();
    const fitted = fittedView(
      config,
      width,
      height,
      intent.kind === "focus" ? intent.point : undefined,
    );
    if (!fitted) return false;
    const next =
      intent.kind === "focus" && intent.scale !== "fit"
        ? {
            scale: intent.scale,
            x: width / 2 - intent.point.x * intent.scale,
            y: height / 2 - intent.point.y * intent.scale,
          }
        : fitted;
    setView((current) =>
      current.scale === next.scale && current.x === next.x && current.y === next.y
        ? current
        : next,
    );
    return true;
  }, [config]);

  const resetView = useCallback(() => {
    viewIntentRef.current = { kind: "fit", mapKey: config.key };
    if (!applyViewIntent()) setView({ scale: 1, x: 0, y: 0 });
  }, [applyViewIntent, config.key]);

  const centerOnPoint = useCallback((point: ScreenPoint) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const { width, height } = viewport.getBoundingClientRect();
    setView((current) => {
      viewIntentRef.current = {
        kind: "focus",
        mapKey: config.key,
        point,
        scale: current.scale,
      };
      return {
        ...current,
        x: width / 2 - point.x * current.scale,
        y: height / 2 - point.y * current.scale,
      };
    });
  }, [config.key]);

  useLayoutEffect(() => {
    applyViewIntent();
  }, [applyViewIntent]);

  const handleSvgLoad = useCallback(() => {
    syncSvgFloors();
    applyViewIntent();
  }, [applyViewIntent, syncSvgFloors]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const resizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => applyViewIntent());
    resizeObserver?.observe(viewport);
    window.addEventListener("resize", applyViewIntent);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", applyViewIntent);
    };
  }, [applyViewIntent]);

  useEffect(() => {
    updateMapSettings({ lastMapKey: config.key });
  }, [config.key, updateMapSettings]);

  useEffect(() => {
    if (previousMapRef.current === config.key) return;
    previousMapRef.current = config.key;
    const pendingFocus =
      pendingMapFocusRef.current?.mapKey === config.key
        ? pendingMapFocusRef.current
        : undefined;
    pendingMapFocusRef.current = undefined;
    setSelectedFloor(pendingFocus?.floorId ?? defaultFloor(config));
    setSelectedMarkerId(pendingFocus?.markerId);
    setPlayerPositions([]);
    setPositionError("");
    if (pendingFocus) {
      viewIntentRef.current = {
        kind: "focus",
        mapKey: config.key,
        point: pendingFocus.screen,
        scale: "fit",
      };
      if (!applyViewIntent()) {
        setView({
          scale: 1,
          x: -pendingFocus.screen.x,
          y: -pendingFocus.screen.y,
        });
      }
    } else {
      resetView();
    }
  }, [applyViewIntent, config, resetView]);

  useEffect(() => {
    if (!focusQuestId) return;
    if (consumedQuestRef.current === focusQuestId) return;
    consumedQuestRef.current = focusQuestId;
    setFocusedQuestId(focusQuestId);
    const targetConfig = focusedQuestMap(data, focusQuestId);
    onQuestFocusConsumed?.();
    if (!targetConfig) return;
    const targetPoint = focusedQuestPoint(data, focusQuestId, targetConfig);
    if (targetPoint) {
      if (targetConfig.key === config.key) {
        viewIntentRef.current = {
          kind: "focus",
          mapKey: targetConfig.key,
          point: targetPoint.screen,
          scale: "fit",
        };
      } else {
        pendingMapFocusRef.current = {
          mapKey: targetConfig.key,
          screen: targetPoint.screen,
          markerId: targetPoint.id,
          floorId: targetPoint.floorId,
        };
      }
    }
    queueMicrotask(() => {
      if (targetPoint && targetConfig.key === config.key) {
        if (targetPoint.floorId) setSelectedFloor(targetPoint.floorId);
        setSelectedMarkerId(targetPoint.id);
        applyViewIntent();
      }
      setSelectedMapKey(targetConfig.key);
    });
  }, [applyViewIntent, config.key, data, focusQuestId, onQuestFocusConsumed]);

  useEffect(() => {
    const syncFullscreenState = () => {
      setIsFullscreen(document.fullscreenElement === pageRef.current);
    };
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

  const objectiveEntries = useMemo<ObjectiveEntry[]>(() => {
    const entries: ObjectiveEntry[] = [];
    const seenObjectiveIds = new Set<string>();

    for (const quest of data.quests) {
      const status = questStatusResolver.getStatus(quest);
      const isFocused =
        quest.id === focusedQuestId || quest.normalizedName === focusedQuestId;
      if (status !== "active" && !isFocused) continue;

      for (const objective of [...quest.objectives].sort(
        (left, right) => left.sortOrder - right.sortOrder,
      )) {
        if (seenObjectiveIds.has(objective.id)) continue;
        seenObjectiveIds.add(objective.id);
        entries.push({ quest, objective });
      }
    }
    return entries;
  }, [data.quests, focusedQuestId, questStatusResolver]);

  const regionQuests = useMemo(
    () => data.quests
      .filter((quest) => questAppliesToMap(quest, config))
      .sort((left, right) =>
        localQuestName(left).localeCompare(localQuestName(right), "ko-KR")),
    [config, data.quests],
  );
  const filteredRegionQuests = useMemo(() => {
    const needle = normalized(regionQuestQuery);
    if (!needle) return regionQuests;
    return regionQuests.filter((quest) => questSearchText(quest).includes(needle));
  }, [regionQuestQuery, regionQuests]);

  const questPoints = useMemo(
    () =>
      objectiveEntries.flatMap((entry) =>
        buildQuestMapPoints(entry, config, data.mapFloorLocations),
      ),
    [config, data.mapFloorLocations, objectiveEntries],
  );

  const sortedObjectiveEntries = useMemo(
    () =>
      [...objectiveEntries].sort((left, right) => {
        const currentMapOrder =
          Number(!objectiveAppliesToMap(left, config)) -
          Number(!objectiveAppliesToMap(right, config));
        if (currentMapOrder !== 0) return currentMapOrder;

        const questOrder = localQuestName(left.quest).localeCompare(
          localQuestName(right.quest),
          "ko",
        );
        if (questOrder !== 0) return questOrder;
        return (
          left.objective.sortOrder - right.objective.sortOrder ||
          left.objective.description.localeCompare(right.objective.description, "ko")
        );
      }),
    [config, objectiveEntries],
  );

  const objectiveTypeOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const { objective } of objectiveEntries) {
      const key = objective.objectiveType.toLocaleLowerCase("en-US");
      if (!options.has(key)) options.set(key, objective.objectiveType);
    }
    return [...options].sort(([, left], [, right]) =>
      objectiveTypeLabel(left).localeCompare(objectiveTypeLabel(right), "ko"),
    );
  }, [objectiveEntries]);

  const filteredObjectiveEntries = useMemo(
    () =>
      sortedObjectiveEntries.filter((entry) => {
        const completed = Boolean(profile.objectiveProgress[entry.objective.id]);
        if (objectiveStatusFilter === "incomplete" && completed) return false;
        if (objectiveStatusFilter === "completed" && !completed) return false;
        if (
          objectiveTypeFilter !== "all" &&
          entry.objective.objectiveType.toLocaleLowerCase("en-US") !==
            objectiveTypeFilter
        ) {
          return false;
        }
        return !currentMapObjectivesOnly || objectiveAppliesToMap(entry, config);
      }),
    [
      config,
      currentMapObjectivesOnly,
      objectiveStatusFilter,
      objectiveTypeFilter,
      profile.objectiveProgress,
      sortedObjectiveEntries,
    ],
  );

  const groupedObjectiveEntries = useMemo(() => {
    const groups = new Map<string, { quest: QuestData; entries: ObjectiveEntry[] }>();
    for (const entry of filteredObjectiveEntries) {
      const group = groups.get(entry.quest.id);
      if (group) group.entries.push(entry);
      else groups.set(entry.quest.id, { quest: entry.quest, entries: [entry] });
    }
    return [...groups.values()];
  }, [filteredObjectiveEntries]);

  const completedObjectiveCount = useMemo(
    () =>
      objectiveEntries.filter(({ objective }) =>
        Boolean(profile.objectiveProgress[objective.id]),
      ).length,
    [objectiveEntries, profile.objectiveProgress],
  );

  const mapMarkers = useMemo(
    () => data.mapMarkers.filter((marker) => mapMatches(config, marker.mapKey)),
    [config, data.mapMarkers],
  );

  const basicMarkerTypes = useMemo(
    () =>
      [...new Set(mapMarkers.filter((marker) => !isExtractionType(marker.markerType)).map((marker) => marker.markerType))]
        .sort((left, right) => markerLabel(left).localeCompare(markerLabel(right), "ko")),
    [mapMarkers],
  );

  const visibleDataMarkers = useMemo(
    () =>
      mapMarkers.filter((marker) => {
        if (!markerFloorVisible(marker.floorId, selectedFloor)) return false;
        if (isExtractionType(marker.markerType)) {
          return extractionMarkerVisible(marker.markerType, mapSettings);
        }
        return !hiddenBasicTypes.has(marker.markerType);
      }),
    [hiddenBasicTypes, mapMarkers, mapSettings, selectedFloor],
  );

  const customMarkers = useMemo(
    () =>
      profile.customMarkers.filter(
        (marker) =>
          mapMatches(config, marker.mapKey) &&
          markerFloorVisible(marker.floorId, selectedFloor),
      ),
    [config, profile.customMarkers, selectedFloor],
  );

  const profileCustomMarkers = useMemo(
    () =>
      [...profile.customMarkers].sort((left, right) => {
        const currentMapOrder =
          Number(!mapMatches(config, left.mapKey)) -
          Number(!mapMatches(config, right.mapKey));
        if (currentMapOrder !== 0) return currentMapOrder;
        const leftMap = findMapConfig(data.mapConfigs, left.mapKey)?.displayName ?? left.mapKey;
        const rightMap = findMapConfig(data.mapConfigs, right.mapKey)?.displayName ?? right.mapKey;
        return (
          leftMap.localeCompare(rightMap, "ko") ||
          left.name.localeCompare(right.name, "ko")
        );
      }),
    [config, data.mapConfigs, profile.customMarkers],
  );

  const focusQuestPoint = useCallback((point: QuestMapPoint) => {
    if (point.floorId) setSelectedFloor(point.floorId);
    setSelectedMarkerId(point.id);
    centerOnPoint(point.screen);
  }, [centerOnPoint]);

  const focusObjectiveEntry = (entry: ObjectiveEntry) => {
    const targetConfig = objectiveTargetMap(entry, data.mapConfigs, config);
    if (!targetConfig) return;
    const targetPoint = buildQuestMapPoints(
      entry,
      targetConfig,
      data.mapFloorLocations,
    )[0];
    if (!targetPoint) return;

    setFocusedQuestId(entry.quest.id);
    if (targetConfig.key === config.key) {
      focusQuestPoint(targetPoint);
      return;
    }

    pendingMapFocusRef.current = {
      mapKey: targetConfig.key,
      screen: targetPoint.screen,
      markerId: targetPoint.id,
      floorId: targetPoint.floorId,
    };
    setSelectedMapKey(targetConfig.key);
  };

  const focusCustomMarker = (marker: CustomMapMarker) => {
    const targetConfig = findMapConfig(data.mapConfigs, marker.mapKey);
    if (!targetConfig) return;
    const screen = markerScreenPosition(targetConfig, marker);
    if (!screen) return;

    setFocusedQuestId(undefined);
    if (targetConfig.key === config.key) {
      if (marker.floorId) setSelectedFloor(marker.floorId);
      setSelectedMarkerId(marker.id);
      centerOnPoint(screen);
      return;
    }

    pendingMapFocusRef.current = {
      mapKey: targetConfig.key,
      screen,
      markerId: marker.id,
      floorId: marker.floorId,
    };
    setSelectedMapKey(targetConfig.key);
  };

  const changeMap = (event: ChangeEvent<HTMLSelectElement>) => {
    setFocusedQuestId(undefined);
    pendingMapFocusRef.current = undefined;
    setRegionQuestQuery("");
    setSelectedMapKey(event.target.value);
  };

  const zoomAtPoint = useCallback((factor: number, pointerX: number, pointerY: number) => {
    viewIntentRef.current = { kind: "manual", mapKey: config.key };
    const viewportBounds = viewportRef.current?.getBoundingClientRect();
    const fitScale = viewportBounds
      ? fittedView(config, viewportBounds.width, viewportBounds.height)?.scale
      : undefined;
    const minimumScale = Math.min(MIN_ZOOM, fitScale ?? MIN_ZOOM);
    setView((current) => {
      const nextScale = clamp(
        current.scale * factor,
        minimumScale,
        MAX_ZOOM,
      );
      const worldX = (pointerX - current.x) / current.scale;
      const worldY = (pointerY - current.y) / current.scale;
      return {
        scale: nextScale,
        x: pointerX - worldX * nextScale,
        y: pointerY - worldY * nextScale,
      };
    });
  }, [config]);

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    zoomAtPoint(
      event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP,
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  };

  const handleViewportKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;

    const pan = (x: number, y: number) => {
      viewIntentRef.current = { kind: "manual", mapKey: config.key };
      setView((current) => ({ ...current, x: current.x + x, y: current.y + y }));
    };
    if (event.key === "ArrowLeft") pan(KEYBOARD_PAN_STEP, 0);
    else if (event.key === "ArrowRight") pan(-KEYBOARD_PAN_STEP, 0);
    else if (event.key === "ArrowUp") pan(0, KEYBOARD_PAN_STEP);
    else if (event.key === "ArrowDown") pan(0, -KEYBOARD_PAN_STEP);
    else if (["+", "=", "Add"].includes(event.key)) {
      const { width, height } = event.currentTarget.getBoundingClientRect();
      zoomAtPoint(ZOOM_STEP, width / 2, height / 2);
    } else if (["-", "_", "Subtract"].includes(event.key)) {
      const { width, height } = event.currentTarget.getBoundingClientRect();
      zoomAtPoint(1 / ZOOM_STEP, width / 2, height / 2);
    } else if (event.key === "0") resetView();
    else return;

    event.preventDefault();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button, input, select, label")) return;
    viewIntentRef.current = { kind: "manual", mapKey: config.key };
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.classList.add("dragging");
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setView((current) => ({
      ...current,
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    }));
  };

  const stopDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    event.currentTarget.classList.remove("dragging");
  };

  const toggleFullscreen = async () => {
    setFullscreenError("");
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen?.();
      } else {
        await pageRef.current?.requestFullscreen?.();
      }
    } catch {
      setFullscreenError("이 브라우저에서는 전체 화면을 열 수 없습니다.");
    }
  };

  const applyScreenshotFileName = useCallback((fileName: string) => {
    const parsed = parseScreenshotFilename(fileName);
    if (!parsed || parsed.z === undefined) {
      setPositionError("EFT 스크린샷 파일 이름에서 위치를 읽지 못했습니다.");
      return;
    }
    const screen = transformMapPosition(config, parsed.x, parsed.z);
    if (!screen) {
      setPositionError("이 지도의 좌표 변환 설정을 적용할 수 없습니다.");
      return;
    }

    const floorId =
      detectFloor(
        data.mapFloorLocations,
        config.key,
        parsed.x,
        parsed.y,
        parsed.z,
      ) ??
      detectFloorByY(data.mapFloorLocations, config.key, parsed.y) ??
      undefined;
    const position: PlayerMapPosition = {
      ...parsed,
      z: parsed.z,
      screen,
      floorId,
      sequence: ++playerSequenceRef.current,
    };
    setPlayerPositions((current) => [...current, position].slice(-50));
    setPositionError("");
    if (floorId) setSelectedFloor(floorId);
    if (!mapSettings.fixedView) centerOnPoint(screen);
  }, [centerOnPoint, config, data.mapFloorLocations, mapSettings.fixedView]);

  useEffect(() => {
    applyScreenshotFileNameRef.current = applyScreenshotFileName;
  }, [applyScreenshotFileName]);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let cursor = 0;
    let pollTimer: number | undefined;
    let reconnectDelay = LOCAL_TRACKER_POLL_INTERVAL_MS;
    let needsTrackerResync = false;
    let cursorInitialized = false;
    let nextStatusRefreshAt = 0;

    const schedule = (callback: () => void, delay: number) => {
      if (stopped) return;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(() => {
        pollTimer = undefined;
        callback();
      }, delay);
    };

    const schedulePoll = () => {
      schedule(() => void pollEvents(), LOCAL_TRACKER_POLL_INTERVAL_MS);
    };

    const scheduleReconnect = () => {
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
      schedule(() => void connect(), delay);
    };

    const pollEvents = async () => {
      const page = await fetchLocalTrackerEvents(cursor, controller.signal);
      if (stopped) return;
      if (!page) {
        setLocalTracker({ state: "UNAVAILABLE" });
        needsTrackerResync = true;
        scheduleReconnect();
        return;
      }
      reconnectDelay = LOCAL_TRACKER_POLL_INTERVAL_MS;

      if (page.pagination.isResetRequired) {
        // A bounded server buffer means part of the trail is unavailable.
        // Drop the discontinuous local trail, but still apply the retained
        // events so the newest known player position is not lost.
        setPlayerPositions([]);
      }

      const pageSequences = new Set<number>();
      for (const screenshotEvent of page.data) {
        if (
          screenshotEvent.sequence <= cursor ||
          pageSequences.has(screenshotEvent.sequence)
        ) {
          continue;
        }
        pageSequences.add(screenshotEvent.sequence);
        applyScreenshotFileNameRef.current(screenshotEvent.fileName);
      }
      cursor = Math.max(cursor, page.pagination.nextCursor);

      if (Date.now() >= nextStatusRefreshAt) {
        const status = await fetchLocalTrackerStatus(controller.signal);
        if (stopped) return;
        if (!status) {
          setLocalTracker({ state: "UNAVAILABLE" });
          needsTrackerResync = true;
          scheduleReconnect();
          return;
        }

        setLocalTracker(status.screenshotWatcher);
        nextStatusRefreshAt = Date.now() + LOCAL_TRACKER_STATUS_REFRESH_INTERVAL_MS;
        if (status.screenshotWatcher.state !== "WATCHING") {
          scheduleReconnect();
          return;
        }
      }
      schedulePoll();
    };

    const connect = async () => {
      const status = await fetchLocalTrackerStatus(controller.signal);
      if (stopped) return;
      if (!status) {
        setLocalTracker({ state: "UNAVAILABLE" });
        scheduleReconnect();
        return;
      }

      setLocalTracker(status.screenshotWatcher);
      if (!cursorInitialized || needsTrackerResync) {
        cursor = Math.max(0, status.latestCursor - 1);
        cursorInitialized = true;
        if (needsTrackerResync) {
          setPlayerPositions([]);
          needsTrackerResync = false;
        }
      }
      nextStatusRefreshAt = Date.now() + LOCAL_TRACKER_STATUS_REFRESH_INTERVAL_MS;
      if (status.screenshotWatcher.state === "WATCHING") {
        reconnectDelay = LOCAL_TRACKER_POLL_INTERVAL_MS;
        schedulePoll();
      } else {
        scheduleReconnect();
      }
    };

    void connect();
    return () => {
      stopped = true;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      controller.abort();
    };
  }, []);

  const importScreenshot = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    event.currentTarget.value = "";
    applyScreenshotFileName(file.name);
  };

  const clearPlayerTrail = () => {
    setPlayerPositions([]);
    setPositionError("");
  };

  const floorWorldY = useCallback(
    (floorId: string | undefined): number => {
      if (!floorId) return playerPositions.at(-1)?.y ?? 0;
      const region = data.mapFloorLocations.find(
        (location) =>
          mapMatches(config, location.mapKey) && location.floorId === floorId,
      );
      return region ? (region.minY + region.maxY) / 2 : 0;
    },
    [config, data.mapFloorLocations, playerPositions],
  );

  const rememberEditorOpener = useCallback(() => {
    editorOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);

  const closeEditor = useCallback(() => {
    const opener = editorOpenerRef.current;
    editorOpenerRef.current = null;
    setEditor(undefined);
    queueMicrotask(() => {
      if (opener?.isConnected) opener.focus();
      else addMarkerButtonRef.current?.focus();
    });
  }, []);

  const openMarkerEditorAt = useCallback(
    (screenX: number, screenY: number) => {
      const world = inverseMapPosition(config, screenX, screenY);
      if (!world) return;
      const floorId = selectedFloor ?? defaultFloor(config);
      rememberEditorOpener();
      setEditor({
        isNew: true,
        marker: {
          id: createMarkerId(),
          mapKey: config.key,
          name: "",
          x: world.x,
          y: floorWorldY(floorId),
          z: world.z,
          floorId,
          color: CUSTOM_MARKER_COLORS[0].value,
          size: clamp(mapSettings.markerSize, 12, 64),
          opacity: mapSettings.customMarkerOpacity,
          createdAt: new Date().toISOString(),
        },
      });
    },
    [
      config,
      floorWorldY,
      mapSettings.customMarkerOpacity,
      mapSettings.markerSize,
      rememberEditorOpener,
      selectedFloor,
    ],
  );

  const openExistingMarkerEditor = (marker: CustomMapMarker) => {
    rememberEditorOpener();
    focusCustomMarker(marker);
    setEditor({ marker: { ...marker }, isNew: false });
  };

  const openMarkerEditorAtCenter = () => {
    const viewport = viewportRef.current;
    const width = viewport?.clientWidth ?? 0;
    const height = viewport?.clientHeight ?? 0;
    openMarkerEditorAt((width / 2 - view.x) / view.scale, (height / 2 - view.y) / view.scale);
  };

  const handleMapDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    openMarkerEditorAt(
      (event.clientX - rect.left - view.x) / view.scale,
      (event.clientY - rect.top - view.y) / view.scale,
    );
  };

  const saveEditor = () => {
    if (!editor) return;
    upsertCustomMarker({ ...editor.marker, name: editor.marker.name.trim() });
    closeEditor();
  };

  const requestMarkerDelete = (
    marker: CustomMapMarker,
    opener?: HTMLElement,
  ) => {
    deleteOpenerRef.current = opener ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setDeleteCandidate(marker);
  };

  const cancelMarkerDelete = () => {
    const opener = deleteOpenerRef.current;
    deleteOpenerRef.current = null;
    setDeleteCandidate(undefined);
    // Let the browser finish removing the top-most modal before restoring focus
    // into the still-open marker editor underneath it.
    setTimeout(() => opener?.isConnected && opener.focus(), 0);
  };

  const confirmMarkerDelete = () => {
    if (!deleteCandidate) return;
    const deletingEditedMarker = editor?.marker.id === deleteCandidate.id;
    const deleteOpener = deleteOpenerRef.current;
    const editorOpener = editorOpenerRef.current;
    deleteCustomMarker(deleteCandidate.id);
    setDeleteCandidate(undefined);
    deleteOpenerRef.current = null;
    if (deletingEditedMarker) {
      setEditor(undefined);
      editorOpenerRef.current = null;
    }
    queueMicrotask(() => {
      const opener = deletingEditedMarker ? editorOpener : deleteOpener;
      if (opener?.isConnected) opener.focus();
      else addMarkerButtonRef.current?.focus();
    });
  };

  const latestPlayerPosition = playerPositions.at(-1);
  const trailPoints = playerPositions.map((position) => `${position.screen.x},${position.screen.y}`).join(" ");
  const markerScale = config.markerScale ?? 1;
  const trackerNote = localTrackerNote(localTracker);

  const renderObjectiveItem = (entry: ObjectiveEntry, showQuestMeta: boolean) => {
    const { quest, objective } = entry;
    const completed = Boolean(profile.objectiveProgress[objective.id]);
    const onCurrentMap = objectiveAppliesToMap(entry, config);
    const targetConfig = objectiveTargetMap(entry, data.mapConfigs, config);
    const targetPoint = targetConfig
      ? buildQuestMapPoints(entry, targetConfig, data.mapFloorLocations)[0]
      : undefined;
    const selected = questPoints.some(
      (point) => point.objective.id === objective.id && point.id === selectedMarkerId,
    );

    return (
      <li
        className={selected ? "selected" : ""}
        data-testid="map-objective-item"
        key={`${quest.id}:${objective.id}`}
      >
        {showQuestMeta ? (
          <div className="map-objective-meta">
            <span>{localQuestName(quest)}</span>
            <small>{quest.trader}</small>
          </div>
        ) : null}
        <div className="map-objective-tags">
          <span className="map-objective-type">{objectiveTypeLabel(objective.objectiveType)}</span>
          {!onCurrentMap && targetConfig ? (
            <span className="map-objective-map">{targetConfig.displayName}</span>
          ) : null}
        </div>
        <div className="map-objective-row">
          <label>
            <input
              aria-label={`${objective.description} 완료`}
              checked={completed}
              onChange={(event) => setObjectiveProgress(objective.id, event.target.checked)}
              type="checkbox"
            />
            <span className={completed ? "completed" : ""}>{objective.description}</span>
          </label>
          <button
            aria-label={`${objective.description} 마커 선택`}
            className="ghost icon-button compact"
            disabled={!targetPoint}
            onClick={() => focusObjectiveEntry(entry)}
            title={
              targetConfig && !onCurrentMap
                ? `${targetConfig.displayName} 지도로 이동`
                : "목표 마커로 이동"
            }
            type="button"
          >
            <Focus aria-hidden="true" size={15} />
          </button>
        </div>
      </li>
    );
  };

  if (!hasMaps) {
    return (
      <section className="map-page panel">
        <div className="empty-state">
          <h1>지도 데이터가 없습니다</h1>
          <p>내보낸 지도 설정과 SVG 파일을 확인해 주세요.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="map-page" ref={pageRef}>
      <header className="map-toolbar panel">
        <div className="map-picker-group">
          <label htmlFor="map-picker">지도 선택</label>
          <select id="map-picker" onChange={changeMap} value={config.key}>
            {data.mapConfigs.map((map) => (
              <option key={map.key} value={map.key}>{map.displayName}</option>
            ))}
          </select>
          {onOpenMiniMapSettings ? (
            <button
              aria-label="미니맵 설정 열기"
              className="map-settings-button"
              onClick={onOpenMiniMapSettings}
              title="미니맵 설정 열기"
              type="button"
            >
              <Settings2 aria-hidden="true" size={16} />
              <span>미니맵 설정</span>
            </button>
          ) : null}
        </div>

        {orderedFloors.length > 0 ? (
          <nav aria-label="지도 층 선택" className="map-floor-tabs">
            {orderedFloors.map((floor) => (
              <button
                aria-pressed={selectedFloor === floor.layerId}
                className={selectedFloor === floor.layerId ? "active" : ""}
                key={floor.layerId}
                onClick={() => setSelectedFloor(floor.layerId)}
                type="button"
              >
                {floor.displayName}
              </button>
            ))}
          </nav>
        ) : (
          <span className="map-single-floor badge">단일 층</span>
        )}

        <div className="map-view-actions">
          <span aria-live="polite" className="map-zoom-value" data-testid="zoom-value">
            {Math.round(view.scale * 100)}%
          </span>
          <MapMiniMap
            config={config}
            orderedFloors={orderedFloors}
            player={latestPlayerPosition}
            playerMarkerSize={mapSettings.playerMarkerSize}
            selectedFloor={selectedFloor}
          />
          <button aria-label="지도 보기 초기화" onClick={resetView} title="지도 보기 초기화" type="button">
            <RotateCcw aria-hidden="true" size={17} /> <span>초기화</span>
          </button>
          <button
            aria-label={isFullscreen ? "전체 화면 닫기" : "전체 화면 열기"}
            onClick={() => void toggleFullscreen()}
            title={isFullscreen ? "전체 화면 닫기" : "전체 화면 열기"}
            type="button"
          >
            {isFullscreen ? <Minimize2 aria-hidden="true" size={17} /> : <Maximize2 aria-hidden="true" size={17} />}
            <span>{isFullscreen ? "축소" : "전체 화면"}</span>
          </button>
        </div>
      </header>

      {fullscreenError ? <p className="map-inline-error" role="alert">{fullscreenError}</p> : null}

      <div className="map-layout">
        <aside aria-label="지도 도구" className="map-sidebar panel">
          <section className="map-side-section map-position-section">
            <div className="map-section-heading">
              <div>
                <p className="map-eyebrow">현재 위치</p>
                <h2>스크린샷 좌표</h2>
              </div>
              <Crosshair aria-hidden="true" size={19} />
            </div>

            <div
              className="map-tracker-status"
              data-state={localTracker.state.toLowerCase()}
              role="status"
            >
              <span aria-hidden="true" className="map-tracker-status-dot" />
              <div>
                <strong>{localTrackerStatusLabel(localTracker)}</strong>
                {localTracker.state === "WATCHING" ? (
                  <span className="map-tracker-path" title={localTracker.folderPath}>
                    {localTracker.folderPath}
                  </span>
                ) : null}
                {localTracker.state === "ERROR" ? <span>{localTracker.message}</span> : null}
              </div>
            </div>

            <label className="map-file-button button" htmlFor="map-screenshot-file">
              <Upload aria-hidden="true" size={16} /> 스크린샷 파일 선택
            </label>
            <input
              accept="image/*"
              className="sr-only"
              id="map-screenshot-file"
              onChange={importScreenshot}
              type="file"
            />
            {latestPlayerPosition ? (
              <div className="map-position-readout">
                <strong>
                  X {formatCoordinate(latestPlayerPosition.x)} · Y {formatCoordinate(latestPlayerPosition.y)} · Z{" "}
                  {formatCoordinate(latestPlayerPosition.z)}
                </strong>
                <span>
                  방향 {Math.round(latestPlayerPosition.angle ?? 0)}°
                  {latestPlayerPosition.floorId ? ` · ${orderedFloors.find((floor) => floor.layerId === latestPlayerPosition.floorId)?.displayName ?? latestPlayerPosition.floorId}` : ""}
                </span>
              </div>
            ) : (
              <p className="map-empty-copy">EFT 스크린샷을 선택하면 파일 이름만 읽습니다.</p>
            )}
            {positionError ? <p className="map-inline-error" role="alert">{positionError}</p> : null}
            <div className="map-position-actions">
              <label className="map-check-row">
                <input
                  checked={mapSettings.fixedView}
                  onChange={(event) => updateMapSettings({ fixedView: event.target.checked })}
                  type="checkbox"
                />
                <span>플레이어 자동 중앙 맞춤 고정</span>
              </label>
              <button
                className="compact"
                disabled={playerPositions.length === 0}
                onClick={clearPlayerTrail}
                type="button"
              >
                <Trash2 aria-hidden="true" size={14} /> 플레이어 경로 지우기
              </button>
            </div>
          </section>

          <section aria-labelledby="map-region-quests-title" className="map-side-section map-region-quests-section">
            <div className="map-section-heading">
              <div>
                <p className="map-eyebrow">현재 지도</p>
                <h2 id="map-region-quests-title">지역 퀘스트 검색</h2>
              </div>
              <span className="badge">{filteredRegionQuests.length}/{regionQuests.length}</span>
            </div>
            <label className="map-region-quest-search">
              <Search aria-hidden="true" size={15} />
              <span className="sr-only">현재 지역 퀘스트 검색</span>
              <input
                aria-label="현재 지역 퀘스트 검색"
                onChange={(event) => setRegionQuestQuery(event.target.value)}
                placeholder="퀘스트·상인·목표 검색"
                type="search"
                value={regionQuestQuery}
              />
            </label>
            {filteredRegionQuests.length > 0 ? (
              <ul className="map-region-quest-list">
                {filteredRegionQuests.map((quest) => (
                  <li key={quest.id} data-testid="map-region-quest-item">
                    <button
                      className="map-region-quest-button"
                      disabled={!onOpenQuest}
                      onClick={() => onOpenQuest?.(quest.id)}
                      type="button"
                    >
                      <span>
                        <strong>{localQuestName(quest)}</strong>
                        <small>
                          {quest.trader} · {quest.objectives.length}개 목표
                          {quest.objectives[0]?.description ? ` · ${quest.objectives[0].description}` : ""}
                        </small>
                      </span>
                      <span aria-hidden="true">›</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="map-empty-copy">검색 조건에 맞는 지역 퀘스트가 없습니다.</p>
            )}
          </section>

          <section aria-labelledby="map-objectives-title" className="map-side-section map-objectives-section">
            <div className="map-section-heading">
              <div>
                <p className="map-eyebrow">프로필 진행도</p>
                <h2 id="map-objectives-title">활성 퀘스트 목표</h2>
              </div>
              <span className="badge">{objectiveEntries.length}</span>
            </div>
            <div className="map-objective-progress">
              <div>
                <span>전체 진행률</span>
                <strong>{completedObjectiveCount}/{objectiveEntries.length} 완료</strong>
              </div>
              <progress
                aria-label="전체 목표 진행률"
                max={Math.max(objectiveEntries.length, 1)}
                value={completedObjectiveCount}
              />
            </div>

            <div className="map-objective-filters">
              <label>
                <span>완료 상태</span>
                <select
                  aria-label="완료 상태 필터"
                  onChange={(event) =>
                    setObjectiveStatusFilter(event.target.value as ObjectiveStatusFilter)
                  }
                  value={objectiveStatusFilter}
                >
                  <option value="all">전체</option>
                  <option value="incomplete">미완료</option>
                  <option value="completed">완료</option>
                </select>
              </label>
              <label>
                <span>목표 유형</span>
                <select
                  aria-label="목표 유형 필터"
                  onChange={(event) => setObjectiveTypeFilter(event.target.value)}
                  value={objectiveTypeFilter}
                >
                  <option value="all">모든 유형</option>
                  {objectiveTypeOptions.map(([value, type]) => (
                    <option key={value} value={value}>{objectiveTypeLabel(type)}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="map-objective-toggles">
              <label className="map-check-row map-compact-check">
                <input
                  checked={currentMapObjectivesOnly}
                  onChange={(event) => setCurrentMapObjectivesOnly(event.target.checked)}
                  type="checkbox"
                />
                <span>현재 지도만</span>
              </label>
              <label className="map-check-row map-compact-check">
                <input
                  checked={groupObjectivesByQuest}
                  onChange={(event) => setGroupObjectivesByQuest(event.target.checked)}
                  type="checkbox"
                />
                <span>퀘스트별 그룹화</span>
              </label>
              <label className="map-check-row map-compact-check">
                <input
                  aria-label="완료한 목표 포함"
                  checked={mapSettings.showCompletedObjectives}
                  onChange={(event) => updateMapSettings({ showCompletedObjectives: event.target.checked })}
                  type="checkbox"
                />
                <span>완료한 목표 마커 표시</span>
              </label>
            </div>

            {filteredObjectiveEntries.length > 0 ? (
              <div className="map-objective-scroll">
                {groupObjectivesByQuest ? (
                  groupedObjectiveEntries.map(({ quest, entries }) => {
                    const completedCount = entries.filter(({ objective }) =>
                      Boolean(profile.objectiveProgress[objective.id]),
                    ).length;
                    return (
                      <section className="map-objective-group" key={quest.id}>
                        <header>
                          <div>
                            <h3>{localQuestName(quest)}</h3>
                            <small>{quest.trader}</small>
                          </div>
                          <span>{completedCount}/{entries.length}</span>
                        </header>
                        <ul className="map-objective-list map-objective-list-grouped">
                          {entries.map((entry) => renderObjectiveItem(entry, false))}
                        </ul>
                      </section>
                    );
                  })
                ) : (
                  <ul className="map-objective-list">
                    {filteredObjectiveEntries.map((entry) => renderObjectiveItem(entry, true))}
                  </ul>
                )}
              </div>
            ) : (
              <p className="map-empty-copy">선택한 필터에 맞는 활성 퀘스트 목표가 없습니다.</p>
            )}
          </section>

          <section aria-labelledby="map-custom-markers-title" className="map-side-section">
            <div className="map-section-heading">
              <div>
                <p className="map-eyebrow">현재 프로필</p>
                <h2 id="map-custom-markers-title">커스텀 마커 목록</h2>
              </div>
              <span className="badge">{profileCustomMarkers.length}</span>
            </div>
            {profileCustomMarkers.length > 0 ? (
              <ul className="map-custom-marker-list">
                {profileCustomMarkers.map((marker) => {
                  const markerConfig = findMapConfig(data.mapConfigs, marker.mapKey);
                  const floorName = marker.floorId
                    ? markerConfig?.floors.find((floor) => floor.layerId === marker.floorId)?.displayName ?? marker.floorId
                    : "단일 층";
                  const canFocus = Boolean(
                    markerConfig && markerScreenPosition(markerConfig, marker),
                  );
                  return (
                    <li
                      className={selectedMarkerId === marker.id ? "selected" : ""}
                      key={marker.id}
                      style={{ "--custom-color": marker.color } as CSSProperties}
                    >
                      <button
                        aria-label={`${marker.name} 위치로 이동`}
                        className="map-custom-marker-focus"
                        disabled={!canFocus}
                        onClick={() => focusCustomMarker(marker)}
                        type="button"
                      >
                        <span
                          aria-hidden="true"
                          className="map-custom-marker-swatch"
                          style={{ "--custom-color": marker.color } as CSSProperties}
                        />
                        <span>
                          <strong>{marker.name}</strong>
                          <small>{markerConfig?.displayName ?? marker.mapKey} · {floorName}</small>
                        </span>
                      </button>
                      <div className="map-custom-marker-actions">
                        <button
                          aria-label={`${marker.name} 편집`}
                          className="ghost icon-button compact"
                          onClick={() => openExistingMarkerEditor(marker)}
                          title="마커 편집"
                          type="button"
                        >
                          <Pencil aria-hidden="true" size={14} />
                        </button>
                        <button
                          aria-label={`${marker.name} 삭제`}
                          className="danger ghost icon-button compact"
                          onClick={(event) => requestMarkerDelete(marker, event.currentTarget)}
                          title="마커 삭제"
                          type="button"
                        >
                          <Trash2 aria-hidden="true" size={14} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="map-empty-copy">이 프로필에 저장한 커스텀 마커가 없습니다.</p>
            )}
          </section>

          <section aria-labelledby="map-layers-title" className="map-side-section">
            <div className="map-section-heading">
              <div>
                <p className="map-eyebrow">레이어</p>
                <h2 id="map-layers-title">마커 표시</h2>
              </div>
            </div>
            <div className="map-layer-grid">
              <label className="map-check-row">
                <input
                  checked={mapSettings.showQuestMarkers}
                  onChange={(event) => updateMapSettings({ showQuestMarkers: event.target.checked })}
                  type="checkbox"
                />
                <span>퀘스트 마커 표시</span>
              </label>
              <label className="map-check-row">
                <input
                  checked={mapSettings.showExtractMarkers}
                  onChange={(event) => updateMapSettings({ showExtractMarkers: event.target.checked })}
                  type="checkbox"
                />
                <span>탈출구 표시</span>
              </label>
              <label className="map-check-row map-check-row-nested">
                <input
                  checked={mapSettings.showPmcExtracts}
                  onChange={(event) => updateMapSettings({ showPmcExtracts: event.target.checked })}
                  type="checkbox"
                />
                <span>PMC 탈출구 표시</span>
              </label>
              <label className="map-check-row map-check-row-nested">
                <input
                  checked={mapSettings.showScavExtracts}
                  onChange={(event) => updateMapSettings({ showScavExtracts: event.target.checked })}
                  type="checkbox"
                />
                <span>Scav 탈출구 표시</span>
              </label>
              <label className="map-check-row map-check-row-nested">
                <input
                  checked={mapSettings.showTransits}
                  onChange={(event) => updateMapSettings({ showTransits: event.target.checked })}
                  type="checkbox"
                />
                <span>트랜짓 탈출구 표시</span>
              </label>
              {basicMarkerTypes.map((type) => (
                <label className="map-check-row" key={type}>
                  <input
                    checked={!hiddenBasicTypes.has(type)}
                    onChange={(event) => {
                      const next = new Set(hiddenBasicTypes);
                      if (event.target.checked) next.delete(type);
                      else next.add(type);
                      updateMapSettings({ hiddenMarkerTypes: [...next] });
                    }}
                    type="checkbox"
                  />
                  <span>{markerLabel(type)} 표시</span>
                </label>
              ))}
            </div>
          </section>

          <section className="map-side-section map-browser-note">
            <strong>{trackerNote.title}</strong>
            <p>{trackerNote.description}</p>
          </section>
        </aside>

        <section aria-labelledby="map-canvas-title" className="map-canvas-panel panel">
          <div className="map-canvas-topline">
            <div>
              <p className="map-eyebrow">{selectedFloor ? orderedFloors.find((floor) => floor.layerId === selectedFloor)?.displayName : "전체"}</p>
              <h1 id="map-canvas-title">{config.displayName}</h1>
            </div>
            <button
              className="primary"
              onClick={openMarkerEditorAtCenter}
              ref={addMarkerButtonRef}
              type="button"
            >
              <Plus aria-hidden="true" size={17} /> 커스텀 마커 추가
            </button>
          </div>

          <div
            aria-describedby="map-keyboard-hint"
            aria-label={`${config.displayName} 대화형 지도`}
            className="map-viewport"
            data-testid="map-viewport"
            onDoubleClick={handleMapDoubleClick}
            onKeyDown={handleViewportKeyDown}
            onPointerCancel={stopDragging}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={stopDragging}
            onWheel={handleWheel}
            ref={viewportRef}
            role="region"
            tabIndex={0}
          >
            <div
              className="map-world"
              data-pan={`${view.x},${view.y}`}
              data-testid="map-world"
              style={{
                width: config.imageWidth,
                height: config.imageHeight,
                transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
                "--map-inverse-scale": `${1 / view.scale}`,
              } as CSSProperties}
            >
              <object
                aria-label={`${config.displayName} 지도`}
                className="map-svg-image"
                data={bundledAsset(`assets/maps/${encodeURIComponent(config.svgFileName)}`)}
                height={config.imageHeight}
                onLoad={handleSvgLoad}
                ref={mapObjectRef}
                role="img"
                type="image/svg+xml"
                width={config.imageWidth}
              />

              {playerPositions.length > 1 ? (
                <svg
                  aria-hidden="true"
                  className="map-player-trail"
                  data-testid="player-trail"
                  height={config.imageHeight}
                  viewBox={`0 0 ${config.imageWidth} ${config.imageHeight}`}
                  width={config.imageWidth}
                >
                  <polyline points={trailPoints} />
                  {playerPositions.slice(0, -1).map((position) => (
                    <circle
                      cx={position.screen.x}
                      cy={position.screen.y}
                      key={position.sequence}
                      r={3 / view.scale}
                    />
                  ))}
                </svg>
              ) : null}

              {visibleDataMarkers.map((marker) => {
                const screen = markerScreenPosition(config, marker);
                if (!screen) return null;
                const extract = isExtractionType(marker.markerType);
                const icon = markerIcon(marker.markerType);
                const name = marker.nameKo || marker.name || markerLabel(marker.markerType);
                return (
                  <button
                    aria-label={`${extract ? "탈출구" : markerLabel(marker.markerType)} 마커 ${name}`}
                    className={`map-marker map-data-marker ${extract ? "extract" : "basic"}`}
                    key={marker.id}
                    onClick={() => {
                      setSelectedMarkerId(marker.id);
                      centerOnPoint(screen);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    style={{
                      left: screen.x,
                      top: screen.y,
                      "--marker-size": `${mapSettings.markerSize * markerScale}px`,
                      "--extract-name-size": `${mapSettings.extractNameSize}px`,
                    } as CSSProperties}
                    title={name}
                    type="button"
                  >
                    {icon ? <img alt="" draggable="false" src={icon} /> : <span className="map-marker-dot" />}
                    {name ? <span className="map-marker-label">{name}</span> : null}
                  </button>
                );
              })}

              {mapSettings.showQuestMarkers
                ? questPoints
                    .filter(
                      (point) =>
                        markerFloorVisible(point.floorId, selectedFloor) &&
                        (mapSettings.showCompletedObjectives ||
                          !profile.objectiveProgress[point.objective.id]),
                    )
                    .map((point) => {
                      const completed = Boolean(profile.objectiveProgress[point.objective.id]);
                      const choiceLabel = point.isOptional
                        ? `선택 ${point.optionalIndex ?? 1}`
                        : undefined;
                      return (
                        <button
                          aria-label={`${choiceLabel ? `${choiceLabel} ` : ""}퀘스트 마커 ${point.objective.description}`}
                          aria-pressed={selectedMarkerId === point.id}
                          className={`map-marker map-quest-marker ${point.isOptional ? "optional" : ""} ${completed ? "completed" : ""} ${selectedMarkerId === point.id ? "selected" : ""}`}
                          key={point.id}
                          onClick={() => {
                            if (point.floorId) setSelectedFloor(point.floorId);
                            setSelectedMarkerId(point.id);
                            const viewport = viewportRef.current;
                            if (!viewport) return;
                            const { width, height } = viewport.getBoundingClientRect();
                            setView((current) => ({
                              ...current,
                              x: width / 2 - point.screen.x * current.scale,
                              y: height / 2 - point.screen.y * current.scale,
                            }));
                          }}
                          onPointerDown={(event) => event.stopPropagation()}
                          style={{
                            left: point.screen.x,
                            top: point.screen.y,
                            "--marker-size": `${mapSettings.markerSize * markerScale}px`,
                            "--quest-name-size": `${mapSettings.questNameSize}px`,
                          } as CSSProperties}
                          title={`${choiceLabel ? `[${choiceLabel}] ` : ""}${localQuestName(point.quest)} · ${point.objective.description}`}
                          type="button"
                        >
                          {point.isOptional ? (
                            <span className="map-optional-circle" />
                          ) : mapSettings.questMarkerStyle.startsWith("circle") ? (
                            <span className="map-quest-circle" />
                          ) : (
                            <img alt="" draggable="false" src={questMarkerIcon(point.objective.objectiveType)} />
                          )}
                          {choiceLabel ? (
                            <span className="map-optional-label">{choiceLabel}</span>
                          ) : mapSettings.questMarkerStyle.includes("Name") ? (
                            <span className="map-marker-label">{point.objective.description}</span>
                          ) : null}
                        </button>
                      );
                    })
                : null}

              {customMarkers.map((marker) => {
                const screen = markerScreenPosition(config, marker);
                if (!screen) return null;
                return (
                  <button
                    aria-label={`커스텀 마커 ${marker.name}`}
                    aria-pressed={selectedMarkerId === marker.id}
                    className="map-marker map-custom-marker"
                    key={marker.id}
                    onClick={() => openExistingMarkerEditor(marker)}
                    onPointerDown={(event) => event.stopPropagation()}
                    style={{
                      left: screen.x,
                      top: screen.y,
                      opacity: marker.opacity * mapSettings.customMarkerOpacity,
                      "--custom-color": marker.color,
                      "--marker-size": `${marker.size}px`,
                    } as CSSProperties}
                    title={`${marker.name} · 수정하려면 클릭`}
                    type="button"
                  >
                    <span className="map-custom-pin"><LocateFixed aria-hidden="true" size={Math.max(12, marker.size * 0.68)} /></span>
                    <span className="map-marker-label">{marker.name}</span>
                  </button>
                );
              })}

              {latestPlayerPosition ? (
                <button
                  aria-label={`플레이어 위치 X ${formatCoordinate(latestPlayerPosition.x)} Y ${formatCoordinate(latestPlayerPosition.y)} Z ${formatCoordinate(latestPlayerPosition.z)} 방향 ${Math.round(latestPlayerPosition.angle ?? 0)}`}
                  className="map-marker map-player-marker"
                  onClick={() => centerOnPoint(latestPlayerPosition.screen)}
                  onPointerDown={(event) => event.stopPropagation()}
                  style={{
                    left: latestPlayerPosition.screen.x,
                    top: latestPlayerPosition.screen.y,
                    "--marker-size": `${mapSettings.playerMarkerSize}px`,
                    "--player-angle": `${getMapDirectionAngle(
                      latestPlayerPosition.angle ?? 0,
                      config.key,
                      config.mapRotation,
                    )}deg`,
                  } as CSSProperties}
                  title="현재 플레이어 위치"
                  type="button"
                >
                  <Navigation aria-hidden="true" />
                  <span className="map-player-pulse" />
                </button>
              ) : null}
            </div>

            <div className="map-viewport-hint" id="map-keyboard-hint">
              <span>드래그 이동</span>
              <span>휠 확대/축소</span>
              <span>방향키: 이동</span>
              <span>+/-: 확대·축소</span>
              <span>0: 보기 초기화</span>
              <span>빈 공간 더블클릭: 마커 추가</span>
            </div>
          </div>
        </section>
      </div>

      {editor ? (
        <CustomMarkerEditor
          editor={editor}
          floors={orderedFloors}
          onCancel={closeEditor}
          onChange={(marker) => setEditor((current) => current ? { ...current, marker } : current)}
          onDelete={(opener) => requestMarkerDelete(editor.marker, opener)}
          onSave={saveEditor}
        />
      ) : null}

      {deleteCandidate ? (
        <Dialog
          description={`“${deleteCandidate.name}” 마커를 삭제하면 복구할 수 없습니다.`}
          footer={
            <>
              <button onClick={cancelMarkerDelete} type="button">취소</button>
              <button className="danger" onClick={confirmMarkerDelete} type="button">
                <Trash2 aria-hidden="true" size={16} /> 삭제 확인
              </button>
            </>
          }
          onClose={cancelMarkerDelete}
          open
          title="커스텀 마커 삭제"
        >
          <p className="map-delete-confirmation">
            삭제 후에는 이 위치와 스타일 정보를 다시 불러올 수 없습니다.
          </p>
        </Dialog>
      ) : null}
    </section>
  );
}
