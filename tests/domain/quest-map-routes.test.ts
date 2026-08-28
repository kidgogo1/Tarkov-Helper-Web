import { describe, expect, it } from "vitest";

import {
  objectiveRouteMapName,
  objectiveRouteLocationForMap,
  questHasDisplayableMapRoute,
  questHasUnambiguousMapRoute,
} from "../../src/domain/quest-map-routes";
import type { MapConfig, QuestData, QuestObjective } from "../../src/types/data";

const customs: MapConfig = {
  key: "Customs",
  displayName: "Customs",
  svgFileName: "customs.svg",
  imageWidth: 1000,
  imageHeight: 1000,
  aliases: ["bigmap"],
  floors: [{ layerId: "main", displayName: "지상", order: 0, isDefault: true }],
};

const reserve: MapConfig = {
  ...customs,
  key: "Reserve",
  displayName: "Reserve",
  aliases: ["rezervbase"],
};

const objective: QuestObjective = {
  id: "objective-route",
  sortOrder: 0,
  objectiveType: "Visit",
  description: "목표 방문",
  requiresFir: false,
  locationPoints: [{ x: 100, y: 1, z: 200 }],
  optionalPoints: [],
};

function quest(locations: string[], objectives: QuestObjective[] = [objective]): QuestData {
  return {
    id: "quest-route",
    normalizedName: "quest-route",
    name: "Route Quest",
    nameEn: "Route Quest",
    nameKo: "경로 퀘스트",
    trader: "Prapor",
    locations,
    kappaRequired: false,
    requirements: [],
    alternativeQuestIds: [],
    followUpQuestIds: [],
    objectives,
    requiredItems: [],
  };
}

describe("quest map route inference", () => {
  it("uses an explicit objective map or the quest's only unambiguous map", () => {
    const explicit = { ...objective, mapName: "Shoreline" };
    expect(objectiveRouteMapName(quest(["Interchange", "Shoreline"]), explicit))
      .toBe("Shoreline");
    expect(objectiveRouteMapName(quest(["Customs"]), objective)).toBe("Customs");
  });

  it("rejects mapless multi-region and coordinate-less objectives", () => {
    expect(objectiveRouteMapName(quest(["Shoreline", "Interchange"]), objective))
      .toBeUndefined();
    expect(questHasUnambiguousMapRoute(quest(["Customs"], [{
      ...objective,
      locationPoints: [],
    }]))).toBe(false);
  });

  it("accepts only routes that resolve to a packaged map and a safe floor", () => {
    expect(questHasDisplayableMapRoute(quest(["Customs"]), [customs], [])).toBe(true);
    expect(questHasDisplayableMapRoute(quest(["UnknownMap"]), [customs], [])).toBe(false);

    const multiFloor = {
      ...customs,
      floors: [
        customs.floors[0],
        { layerId: "level2", displayName: "2층", order: 1, isDefault: false },
      ],
    };
    expect(questHasDisplayableMapRoute(quest(["Customs"]), [multiFloor], []))
      .toBe(false);
    expect(questHasDisplayableMapRoute(quest(["Customs"], [{
      ...objective,
      locationPoints: [{ ...objective.locationPoints[0], floorId: "level2" }],
    }]), [multiFloor], [])).toBe(true);
  });

  it("selects the coordinates belonging to each map of one multi-map objective", () => {
    const multiMapObjective: QuestObjective = {
      ...objective,
      mapName: "Customs",
      mapLocations: [
        {
          mapName: "Customs",
          locationPoints: [{ x: 100, y: 1, z: 200 }],
          optionalPoints: [],
        },
        {
          mapName: "Reserve",
          locationPoints: [{ x: 300, y: 2, z: 400 }],
          optionalPoints: [],
        },
      ],
    };
    const multiMapQuest = quest(["Customs", "Reserve"], [multiMapObjective]);

    expect(objectiveRouteLocationForMap(multiMapQuest, multiMapObjective, customs)?.locationPoints)
      .toEqual([{ x: 100, y: 1, z: 200 }]);
    expect(objectiveRouteLocationForMap(multiMapQuest, multiMapObjective, reserve)?.locationPoints)
      .toEqual([{ x: 300, y: 2, z: 400 }]);
    expect(questHasUnambiguousMapRoute(multiMapQuest)).toBe(true);
    expect(questHasDisplayableMapRoute(multiMapQuest, [customs, reserve], []))
      .toBe(true);
  });
});
