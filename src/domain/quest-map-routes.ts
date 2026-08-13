import { detectFloor, normalizeMapName, transformMapPosition } from "./map";
import type {
  MapConfig,
  MapFloorLocation,
  QuestData,
  QuestObjective,
  WorldPoint,
} from "../types/data";

export const MAX_MAP_ROUTE_QUESTS = 100;

function normalizedMapName(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[\s_-]+/g, "");
}

export function mapConfigMatchesRouteName(
  config: MapConfig,
  mapName: string | undefined,
): boolean {
  const candidate = mapName ? normalizedMapName(mapName) : "";
  return Boolean(candidate) && [config.key, config.displayName, ...config.aliases]
    .some((value) => normalizedMapName(value) === candidate);
}

export function findRouteMapConfig(
  configs: readonly MapConfig[],
  mapName: string | undefined,
): MapConfig | undefined {
  const directMatch = configs.find((config) => mapConfigMatchesRouteName(config, mapName));
  if (directMatch || !mapName) return directMatch;
  const canonicalName = normalizeMapName(mapName);
  return canonicalName
    ? configs.find((config) => mapConfigMatchesRouteName(config, canonicalName))
    : undefined;
}

/**
 * Returns the only map that can be safely attributed to an objective.
 * A mapless objective in a multi-region quest is intentionally rejected: the
 * same world coordinates must never be projected onto several unrelated maps.
 */
export function objectiveRouteMapName(
  quest: QuestData,
  objective: QuestObjective,
): string | undefined {
  const explicitMap = objective.mapName?.trim();
  if (explicitMap) return explicitMap;

  const uniqueLocations = new Map<string, string>();
  for (const location of quest.locations) {
    const trimmed = location.trim();
    if (trimmed) uniqueLocations.set(normalizedMapName(trimmed), trimmed);
  }
  return uniqueLocations.size === 1 ? [...uniqueLocations.values()][0] : undefined;
}

export function objectiveHasUnambiguousMapRoute(
  quest: QuestData,
  objective: QuestObjective,
): boolean {
  return Boolean(
    objectiveRouteMapName(quest, objective) &&
    (objective.locationPoints.length > 0 || objective.optionalPoints.length > 0),
  );
}

export function resolveRoutePointFloor(
  config: MapConfig,
  point: WorldPoint,
  floorLocations: readonly MapFloorLocation[],
): string | undefined {
  const explicitFloor = point.floorId?.trim();
  if (explicitFloor) {
    return config.floors.length === 0 ||
      config.floors.some((floor) => floor.layerId === explicitFloor)
      ? explicitFloor
      : undefined;
  }

  const detectedFloor = detectFloor(
    floorLocations,
    config.key,
    point.x,
    point.y,
    point.z,
  ) ?? undefined;
  if (detectedFloor) {
    return config.floors.length === 0 ||
      config.floors.some((floor) => floor.layerId === detectedFloor)
      ? detectedFloor
      : undefined;
  }
  return config.floors.length === 1 ? config.floors[0]?.layerId : undefined;
}

export function routePointIsDisplayable(
  config: MapConfig,
  point: WorldPoint,
  floorLocations: readonly MapFloorLocation[],
): boolean {
  if (!transformMapPosition(config, point.x, point.z)) return false;
  const floorId = resolveRoutePointFloor(config, point, floorLocations);
  if (point.floorId && !floorId) return false;
  return config.floors.length <= 1 || Boolean(floorId);
}

export function objectiveHasDisplayableMapRoute(
  quest: QuestData,
  objective: QuestObjective,
  configs: readonly MapConfig[],
  floorLocations: readonly MapFloorLocation[],
): boolean {
  const config = findRouteMapConfig(configs, objectiveRouteMapName(quest, objective));
  return Boolean(config && [...objective.locationPoints, ...objective.optionalPoints]
    .some((point) => routePointIsDisplayable(config, point, floorLocations)));
}

export function questHasUnambiguousMapRoute(quest: QuestData): boolean {
  return quest.objectives.some((objective) =>
    objectiveHasUnambiguousMapRoute(quest, objective));
}

export function questHasDisplayableMapRoute(
  quest: QuestData,
  configs: readonly MapConfig[],
  floorLocations: readonly MapFloorLocation[],
): boolean {
  return quest.objectives.some((objective) =>
    objectiveHasDisplayableMapRoute(quest, objective, configs, floorLocations));
}
