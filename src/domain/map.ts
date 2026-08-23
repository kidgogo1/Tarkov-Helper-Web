import type { MapConfig, MapFloor, MapFloorLocation } from "../types/data";
import { fallbackFloorLocationsForMap } from "./map-floor-fallbacks";

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface WorldMapPoint {
  x: number;
  z: number;
}

export interface ScreenshotPosition {
  mapName: string;
  x: number;
  y: number;
  z?: number;
  angle?: number;
  originalFileName: string;
}

export type QuestLogEventType = "started" | "completed" | "failed";

export interface QuestLogEvent {
  questId: string;
  eventType: QuestLogEventType;
  traderId: string;
  timestamp: Date;
  originalLine: string;
  sourceFile?: string;
}

export function getMapDirectionAngle(
  angle: number,
  mapKey: string,
  configuredRotation?: number,
): number {
  const normalizedMapKey = mapKey.trim().toLocaleLowerCase("en-US");
  const desktopRotation = normalizedMapKey === "factory"
    ? 90
    : normalizedMapKey === "labs"
      ? -90
      : 0;
  const rotation = Number.isFinite(configuredRotation)
    ? configuredRotation as number
    : desktopRotation;
  return angle + rotation;
}

export function collapseQuestLogEvents<
  T extends Pick<QuestLogEvent, "questId" | "eventType" | "timestamp">,
>(events: readonly T[]): T[] {
  const finalByQuest = new Map<string, T>();
  for (const event of [...events].sort(
    (left, right) => left.timestamp.getTime() - right.timestamp.getTime(),
  )) {
    finalByQuest.set(event.questId, event);
  }
  return [...finalByQuest.values()].sort(
    (left, right) => left.timestamp.getTime() - right.timestamp.getTime(),
  );
}

export function applySvgFloorVisibility(
  svgDocument: Document,
  floors: readonly MapFloor[],
  selectedFloorId: string | undefined,
): void {
  const svgRoot = svgDocument.documentElement;
  if (svgRoot?.namespaceURI === "http://www.w3.org/2000/svg") {
    const existingBackground = svgDocument.getElementById("tarkov-helper-map-background");
    const canvasBackground =
      existingBackground ??
      svgDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
    if (!existingBackground) {
      canvasBackground.setAttribute("id", "tarkov-helper-map-background");
    }
    canvasBackground.setAttribute("width", "100%");
    canvasBackground.setAttribute("height", "100%");
    canvasBackground.setAttribute("fill", "#0d0f0e");
    canvasBackground.setAttribute("pointer-events", "none");
    if (canvasBackground.parentNode !== svgRoot || svgRoot.firstChild !== canvasBackground) {
      svgRoot.insertBefore(canvasBackground, svgRoot.firstChild);
    }
  }

  const defaultMapFloor = floors.find((floor) => floor.isDefault) ?? floors[0];
  const selectedMapFloor =
    floors.find((floor) => floor.layerId === selectedFloorId) ?? defaultMapFloor;
  if (!selectedMapFloor) return;

  for (const floor of floors) {
    const layer = svgDocument.getElementById(floor.layerId);
    if (!layer) continue;
    const selected = floor.layerId === selectedMapFloor.layerId;
    const background =
      !selected &&
      defaultMapFloor &&
      floor.layerId === defaultMapFloor.layerId &&
      selectedMapFloor.layerId !== defaultMapFloor.layerId;
    layer.style.setProperty("display", selected || background ? "inline" : "none", "important");
    layer.style.setProperty(
      "opacity",
      selected ? "1" : background ? (selectedMapFloor.order < 0 ? "0.15" : "0.3") : "1",
      "important",
    );
  }
}

export const DEFAULT_SCREENSHOT_PATTERN =
  /\d{4}-\d{2}-\d{2}\[\d{2}-\d{2}\]_(?<x>-?\d+\.?\d*),\s*(?<y>-?\d+\.?\d*),\s*(?<z>-?\d+\.?\d*)_(?<qx>-?\d+\.?\d*),\s*(?<qy>-?\d+\.?\d*),\s*(?<qz>-?\d+\.?\d*),\s*(?<qw>-?\d+\.?\d*)_/i;

const MAP_NAME_MAPPING = new Map<string, string>([
  ["woods", "Woods"],
  ["woods_preset", "Woods"],
  ["customs", "Customs"],
  ["customs_preset", "Customs"],
  ["bigmap", "Customs"],
  ["bigmap_preset", "Customs"],
  ["shoreline", "Shoreline"],
  ["shoreline_preset", "Shoreline"],
  ["interchange", "Interchange"],
  ["shopping_mall", "Interchange"],
  ["shopping_mall_preset", "Interchange"],
  ["reserve", "Reserve"],
  ["rezervbase", "Reserve"],
  ["rezerv_base", "Reserve"],
  ["rezerv_base_preset", "Reserve"],
  ["lighthouse", "Lighthouse"],
  ["lighthouse_preset", "Lighthouse"],
  ["tarkovstreets", "StreetsOfTarkov"],
  ["streets", "StreetsOfTarkov"],
  ["streets of tarkov", "StreetsOfTarkov"],
  ["city", "StreetsOfTarkov"],
  ["city_preset", "StreetsOfTarkov"],
  ["factory", "Factory"],
  ["factory4_day", "Factory"],
  ["factory4_night", "Factory"],
  ["factory4_day_preset", "Factory"],
  ["factory4_night_preset", "Factory"],
  ["factory_day", "Factory"],
  ["factory_night", "Factory"],
  ["factory_day_preset", "Factory"],
  ["factory_night_preset", "Factory"],
  ["groundzero", "GroundZero"],
  ["ground zero", "GroundZero"],
  ["ground_zero", "GroundZero"],
  ["sandbox", "GroundZero"],
  ["sandbox_high", "GroundZero"],
  ["sandbox_start", "GroundZero"],
  ["sandbox_preset", "GroundZero"],
  ["sandbox_high_preset", "GroundZero"],
  ["sandbox_start_preset", "GroundZero"],
  ["laboratory", "Labs"],
  ["laboratory_preset", "Labs"],
  ["labs", "Labs"],
  ["the lab", "Labs"],
  ["labyrinth", "Labyrinth"],
  ["the labyrinth", "Labyrinth"],
  ["labyrinth_preset", "Labyrinth"],
  ["terminal", "Terminal"],
  ["terminal_preset", "Terminal"],
]);

const MAP_DETECTION_PATTERNS = [
  /maps\/([A-Za-z0-9_]+)\.bundle/i,
  /Location:\s*([A-Za-z0-9_ -]+),/i,
];

const QUEST_MESSAGE_TYPES = new Map<number, QuestLogEventType>([
  [10, "started"],
  [11, "failed"],
  [12, "completed"],
]);

function hasSixFiniteValues(transform: readonly number[]): boolean {
  return transform.length >= 6 && transform.slice(0, 6).every(Number.isFinite);
}

export function applyAffineTransform(
  transform: readonly number[],
  gameX: number,
  gameZ: number,
): ScreenPoint | null {
  if (!hasSixFiniteValues(transform) || !Number.isFinite(gameX) || !Number.isFinite(gameZ)) {
    return null;
  }
  const [a, b, c, d, tx, ty] = transform as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return {
    x: a * gameX + b * gameZ + tx,
    y: c * gameX + d * gameZ + ty,
  };
}

export function invertAffineTransform(
  transform: readonly number[],
  screenX: number,
  screenY: number,
): WorldMapPoint | null {
  if (
    !hasSixFiniteValues(transform) ||
    !Number.isFinite(screenX) ||
    !Number.isFinite(screenY)
  ) {
    return null;
  }
  const [a, b, c, d, tx, ty] = transform as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-10) return null;

  const deltaX = screenX - tx;
  const deltaY = screenY - ty;
  return {
    x: (d * deltaX - b * deltaY) / determinant,
    z: (-c * deltaX + a * deltaY) / determinant,
  };
}

function mapAffineTransform(config: MapConfig): readonly number[] | undefined {
  return config.playerMarkerTransform ?? config.calibratedTransform;
}

export function transformMapPosition(
  config: MapConfig,
  gameX: number,
  gameZ: number,
): ScreenPoint | null {
  const transform = mapAffineTransform(config);
  if (transform) return applyAffineTransform(transform, gameX, gameZ);
  if (!Number.isFinite(gameX) || !Number.isFinite(gameZ)) return null;
  return {
    x: config.imageWidth / 2 + gameX,
    y: config.imageHeight / 2 + gameZ,
  };
}

export function inverseMapPosition(
  config: MapConfig,
  screenX: number,
  screenY: number,
): WorldMapPoint | null {
  const transform = mapAffineTransform(config);
  if (transform) return invertAffineTransform(transform, screenX, screenY);
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return null;
  return {
    x: screenX - config.imageWidth / 2,
    z: screenY - config.imageHeight / 2,
  };
}

function parseFiniteNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function quaternionYawWithEftOffset(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): number | undefined {
  if (![qx, qy, qz, qw].every(Number.isFinite)) return undefined;
  const sinYawCosPitch = 2 * (qw * qy + qx * qz);
  const cosYawCosPitch = 1 - 2 * (qy * qy + qz * qz);
  return (Math.atan2(sinYawCosPitch, cosYawCosPitch) * 180) / Math.PI + 180;
}

function compileScreenshotPattern(pattern: RegExp | string): RegExp {
  if (pattern instanceof RegExp) {
    return new RegExp(pattern.source, pattern.flags.replace("g", "").replace("y", ""));
  }
  return new RegExp(pattern, "i");
}

export function isValidScreenshotPattern(pattern: RegExp | string): boolean {
  try {
    const regex = compileScreenshotPattern(pattern);
    const source = regex.source;
    return source.includes("?<x>") && source.includes("?<y>");
  } catch {
    return false;
  }
}

export function parseScreenshotFilename(
  fileName: string,
  pattern: RegExp | string = DEFAULT_SCREENSHOT_PATTERN,
): ScreenshotPosition | null {
  if (!fileName.trim()) return null;

  try {
    const match = compileScreenshotPattern(pattern).exec(fileName);
    const groups = match?.groups;
    if (!groups) return null;
    const x = parseFiniteNumber(groups.x);
    const y = parseFiniteNumber(groups.y);
    if (x === undefined || y === undefined) return null;

    const z = parseFiniteNumber(groups.z);
    const explicitAngle = parseFiniteNumber(groups.angle);
    const qx = parseFiniteNumber(groups.qx);
    const qy = parseFiniteNumber(groups.qy);
    const qz = parseFiniteNumber(groups.qz);
    const qw = parseFiniteNumber(groups.qw);
    const quaternionAngle =
      qx !== undefined &&
      qy !== undefined &&
      qz !== undefined &&
      qw !== undefined
        ? quaternionYawWithEftOffset(qx, qy, qz, qw)
        : undefined;

    return {
      mapName: groups.map ?? "Unknown",
      x,
      y,
      ...(z === undefined ? {} : { z }),
      ...(explicitAngle === undefined && quaternionAngle === undefined
        ? {}
        : { angle: explicitAngle ?? quaternionAngle }),
      originalFileName: fileName,
    };
  } catch {
    return null;
  }
}

export function normalizeMapName(rawMapName: string): string | null {
  const normalized = rawMapName.trim().toLocaleLowerCase("en-US");
  if (!normalized) return null;
  const directMatch = MAP_NAME_MAPPING.get(normalized);
  if (directMatch) return directMatch;
  if (normalized.endsWith("_preset")) {
    const withoutPreset = normalized.slice(0, -"_preset".length);
    return MAP_NAME_MAPPING.get(withoutPreset) ?? withoutPreset;
  }
  return normalized;
}

export function detectMapFromLogLine(line: string): string | null {
  for (const pattern of MAP_DETECTION_PATTERNS) {
    const match = pattern.exec(line);
    const rawMapName = match?.[1];
    if (rawMapName) return normalizeMapName(rawMapName);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseQuestJsonBlock(
  jsonString: string,
  sourceFile?: string,
): QuestLogEvent | null {
  try {
    const root: unknown = JSON.parse(jsonString);
    if (!isRecord(root) || root.type !== "new_message" || !isRecord(root.message)) {
      return null;
    }

    const eventType =
      typeof root.message.type === "number"
        ? QUEST_MESSAGE_TYPES.get(root.message.type)
        : undefined;
    if (!eventType || typeof root.message.templateId !== "string") return null;

    const questId = root.message.templateId.split(" ")[0] ?? "";
    if (!questId) return null;
    const timestamp =
      typeof root.message.dt === "number" && Number.isFinite(root.message.dt)
        ? new Date(root.message.dt * 1000)
        : new Date();

    return {
      questId,
      eventType,
      traderId: typeof root.dialogId === "string" ? root.dialogId : "",
      timestamp,
      originalLine: jsonString.slice(0, 200),
      ...(sourceFile === undefined ? {} : { sourceFile }),
    };
  } catch {
    return null;
  }
}

export function parseQuestLogContent(
  content: string,
  sourceFile?: string,
): QuestLogEvent[] {
  const events: QuestLogEvent[] = [];
  const jsonLines: string[] = [];
  let inJson = false;
  let braceCount = 0;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!inJson && line.trimStart().startsWith("{")) {
      inJson = true;
      jsonLines.length = 0;
      braceCount = 0;
    }

    if (!inJson) continue;
    jsonLines.push(line);
    for (const character of line) {
      if (character === "{") braceCount += 1;
      if (character === "}") braceCount -= 1;
    }

    if (braceCount === 0) {
      inJson = false;
      const event = parseQuestJsonBlock(`${jsonLines.join("\n")}\n`, sourceFile);
      if (event) events.push(event);
    }
  }

  return events;
}

function hasCompleteXzBounds(location: MapFloorLocation): boolean {
  return (
    location.minX !== undefined &&
    location.maxX !== undefined &&
    location.minZ !== undefined &&
    location.maxZ !== undefined
  );
}

function floorLocationContainsXz(
  location: MapFloorLocation,
  x: number,
  z: number,
): boolean {
  return hasCompleteXzBounds(location) &&
    x >= location.minX! &&
    x <= location.maxX! &&
    z >= location.minZ! &&
    z <= location.maxZ!;
}

export function floorLocationContains(
  location: MapFloorLocation,
  x: number,
  y: number,
  z: number,
): boolean {
  if (y < location.minY || y > location.maxY) return false;
  if (!hasCompleteXzBounds(location)) return true;
  return (
    x >= location.minX! &&
    x <= location.maxX! &&
    z >= location.minZ! &&
    z <= location.maxZ!
  );
}

function matchingFloorLocations(
  locations: readonly MapFloorLocation[],
  mapKey: string,
): MapFloorLocation[] {
  const normalizedMapKey = mapKey.toLocaleLowerCase("en-US");
  return locations
    .filter(
      (location) =>
        location.mapKey.toLocaleLowerCase("en-US") === normalizedMapKey,
    )
    .sort((left, right) => right.priority - left.priority);
}

export function detectFloor(
  locations: readonly MapFloorLocation[],
  mapKey: string,
  x: number,
  y: number,
  z: number,
): string | null {
  return (
    matchingFloorLocations(locations, mapKey).find((location) =>
      floorLocationContains(location, x, y, z),
    )?.floorId ?? null
  );
}

/**
 * Resolves positions outside every explicit indoor X/Z footprint to the map's
 * default floor. Positions inside a known footprint but outside all Y ranges
 * remain unknown, because guessing there would connect different floors.
 * Older data packs may omit an entire map's floor rows; supported fallback
 * GameBounds are added only when the config contains every corresponding SVG
 * floor, so incomplete/custom fixtures remain conservative.
 */
export function detectPlayerFloor(
  locations: readonly MapFloorLocation[],
  config: Pick<MapConfig, "key" | "floors">,
  x: number,
  y: number,
  z: number,
): string | null {
  const explicitMapLocations = matchingFloorLocations(locations, config.key);
  const configuredFloorIds = new Set(config.floors.map((floor) => floor.layerId));
  const allFallbackMapLocations = fallbackFloorLocationsForMap(config.key);
  const fallbackMapLocations = allFallbackMapLocations.every((location) =>
    configuredFloorIds.has(location.floorId),
  )
    ? allFallbackMapLocations
    : [];
  const explicitFloorIds = new Set(explicitMapLocations.map((location) => location.floorId));
  const supplementalFallbackLocations = fallbackMapLocations.filter(
    (location) => !explicitFloorIds.has(location.floorId),
  );
  const mapLocations = matchingFloorLocations(
    [...locations, ...supplementalFallbackLocations],
    config.key,
  );
  const detected = mapLocations.find((location) =>
    floorLocationContains(location, x, y, z))?.floorId;
  if (detected) return detected;
  if (mapLocations.length === 0) return null;
  if (mapLocations.some((location) => !hasCompleteXzBounds(location))) return null;
  if (mapLocations.some((location) => floorLocationContainsXz(location, x, z))) {
    return null;
  }
  return config.floors.find((floor) => floor.isDefault)?.layerId ?? null;
}

export function detectFloorByY(
  locations: readonly MapFloorLocation[],
  mapKey: string,
  y: number,
): string | null {
  return (
    matchingFloorLocations(locations, mapKey).find(
      (location) =>
        !hasCompleteXzBounds(location) && y >= location.minY && y <= location.maxY,
    )?.floorId ?? null
  );
}
