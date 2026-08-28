import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  extractWikiQuestMeta,
  applyWikiGuideLinkErrors,
  applyWikiQuestRenames,
  mergeTarkovDevItems,
  normalizeTarkovDevTasks,
  mergeQuestSources,
  normalizeQuestName,
  toAppQuest,
} from "../../scripts/quest-pack.mjs";

const baseQuest = {
  id: "local-quest",
  bsgId: "same-id",
  normalizedName: "sample-quest",
  name: "Sample Quest",
  nameEn: "Sample Quest",
  trader: "Mechanic",
  locations: ["Woods"],
  kappaRequired: false,
  requirements: [],
  alternativeQuestIds: [],
  followUpQuestIds: [],
  objectives: [{ id: "local-objective", description: "Keep local map data" }],
  requiredItems: [],
};

const emptyPack = {
  meta: {
    originalCommit: "original",
    modifiedCommit: "modified",
    exportedAt: "2026-05-06T18:03:23Z",
    counts: { quests: 1, items: 0, hideoutStations: 0, maps: 0, mapMarkers: 0 },
  },
  quests: [baseQuest],
  items: [],
  hideoutStations: [],
  traders: [],
  mapConfigs: [],
  mapMarkers: [],
  mapFloorLocations: [],
};

describe("quest pack refresh", () => {
  it("bundles the refreshed source provenance and appended quest count", () => {
    const packPath = path.resolve(process.cwd(), "public/data/tarkov-data.json");
    const pack = JSON.parse(readFileSync(packPath, "utf8"));

    expect(pack.meta.counts.quests).toBe(517);
    expect(pack.quests).toHaveLength(517);
    expect(pack.meta.sources).toMatchObject({
      tarkovDataQuestCount: 517,
      liveTaskCount: 517,
      wikiQuestCount: 519,
      refreshMode: "bsg-id-authoritative-mode-catalogs",
      questCatalogCounts: { regular: 517, pve: 514, pvpSeason: 491 },
      wikiRewardQuestCount: 441,
      wikiRewardItemCount: 713,
    });
  });

  it("bundles current maps and live world positions for Vitamins, Supplements, and Hunting Trip", () => {
    const packPath = path.resolve(process.cwd(), "public/data/tarkov-data.json");
    const pack = JSON.parse(readFileSync(packPath, "utf8"));
    const vitamins = pack.quests.find((quest) => quest.bsgId === "5b478eca86f7744642012254");
    const supplements = pack.quests.find((quest) => quest.bsgId === "5b478ff486f7744d184ecbbf");
    const huntingTrip = pack.quests.find((quest) => quest.bsgId === "5d25e4ca86f77409dd5cdf2c");

    expect(vitamins.objectives
      .filter((objective) => objective.optionalPoints.length > 0)
      .map((objective) => objective.mapName))
      .toEqual(["Shoreline"]);
    expect(supplements.objectives
      .filter((objective) => objective.optionalPoints.length > 0)
      .map((objective) => objective.mapName))
      .toEqual(["Interchange"]);
    expect(huntingTrip.objectives[0].mapName).toBe("Woods");
  });

  it("keeps item, quest, and objective identities unique in every bundled catalog", () => {
    const packPath = path.resolve(process.cwd(), "public/data/tarkov-data.json");
    const pack = JSON.parse(readFileSync(packPath, "utf8"));
    const itemIds = pack.items.map((item) => item.id);
    const itemBsgIds = pack.items.map((item) => item.bsgId).filter(Boolean);
    const catalogs = {
      regular: pack.quests,
      pve: pack.questCatalogs.pve,
      pvpSeason: pack.questCatalogs.pvpSeason,
    };

    expect(new Set(itemIds).size).toBe(itemIds.length);
    expect(new Set(itemBsgIds).size).toBe(itemBsgIds.length);
    for (const [name, quests] of Object.entries(catalogs)) {
      const questIds = quests.map((quest) => quest.id);
      const objectiveIds = quests.flatMap((quest) =>
        quest.objectives.map((objective) => objective.id));
      expect(new Set(questIds).size, `${name}: duplicate quest id`).toBe(questIds.length);
      expect(new Set(objectiveIds).size, `${name}: duplicate objective id`)
        .toBe(objectiveIds.length);
      expect(pack.meta.sources.questCatalogCounts[name]).toBe(quests.length);
    }
  });

  it("bundles resolvable current follow-up links for every game-mode catalog", () => {
    const packPath = path.resolve(process.cwd(), "public/data/tarkov-data.json");
    const pack = JSON.parse(readFileSync(packPath, "utf8"));
    const catalogs = [pack.quests, pack.questCatalogs.pve, pack.questCatalogs.pvpSeason];

    for (const quests of catalogs) {
      const byId = new Map(quests.map((quest) => [quest.id, quest]));
      const collector = quests.find((quest) => (quest.nameEn ?? quest.name) === "Collector");

      for (const quest of quests) {
        for (const requirement of quest.requirements) {
          const requirementType = String(requirement.requirementType ?? "complete").toLowerCase();
          if (!["complete", "completed", "done", "success"].includes(requirementType)) continue;
          const prerequisite = quests.find((candidate) => (
            candidate.bsgId === requirement.questId
            || candidate.id === requirement.questId
            || candidate.bsgIdAliases?.includes(requirement.questId)
          ));
          expect(prerequisite, `${quest.name}: unresolved prerequisite`).toBeDefined();
          expect(prerequisite.followUpQuestIds).toContain(quest.id);
        }

        for (const followUpId of quest.followUpQuestIds) {
          const followUp = byId.get(followUpId);
          expect(followUp, `${quest.name}: unresolved follow-up`).toBeDefined();
          const isDirectRequirement = followUp.requirements.some((requirement) => (
            ["complete", "completed", "done", "success"].includes(
              String(requirement.requirementType ?? "complete").toLowerCase(),
            ) && (
              requirement.questId === quest.id
              || requirement.questId === quest.bsgId
              || quest.bsgIdAliases?.includes(requirement.questId)
            )
          ));
          const isCollectorRequirement = followUp.id === collector?.id && quest.kappaRequired;
          expect(isDirectRequirement || isCollectorRequirement, `${quest.name}: stale follow-up`).toBe(true);
        }
      }
    }
  });

  it("keeps one-way live quest failure branches directional", () => {
    const packPath = path.resolve(process.cwd(), "public/data/tarkov-data.json");
    const pack = JSON.parse(readFileSync(packPath, "utf8"));
    const inevitable = pack.quests.find((quest) => quest.nameEn === "Inevitable Response");
    const swift = pack.quests.find((quest) => quest.nameEn === "Swift Retribution");

    expect(inevitable.alternativeQuestIds).toContain(swift.id);
    expect(swift.alternativeQuestIds).not.toContain(inevitable.id);
  });

  it("does not leave routed objectives ambiguous across zero or multiple quest maps", () => {
    const packPath = path.resolve(process.cwd(), "public/data/tarkov-data.json");
    const pack = JSON.parse(readFileSync(packPath, "utf8"));
    const ambiguous = pack.quests.flatMap((quest) => {
      if (quest.locations.length === 1) return [];
      return quest.objectives
        .filter((objective) => (
          (objective.locationPoints.length > 0 || objective.optionalPoints.length > 0)
          && !objective.mapName
        ))
        .map((objective) => `${quest.name}:${objective.id}`);
    });

    expect(ambiguous).toEqual([]);
  });

  it("counts only the fixed quest table and excludes operational tasks", () => {
    const wiki = [
      "==List of Quests==",
      "|-\n| [[First Quest]]\n| objectives",
      "|-\n| [[Second Quest]]\n| objectives",
      "==Operational Tasks==",
      "|-\n| [[Daily Task]]\n| objectives",
    ].join("\n");

    expect(extractWikiQuestMeta(wiki, "2026-08-07T14:28:05Z")).toEqual({
      wikiQuestCount: 2,
      wikiRevisionTimestamp: "2026-08-07T14:28:05Z",
    });
  });

  it("normalizes wiki suffixes and punctuation for identity matching", () => {
    expect(normalizeQuestName("Against the Conscience - Part 1 [PVP ZONE]"))
      .toBe("against the conscience part 1");
    expect(normalizeQuestName("Counteraction - USEC")).toBe("counteraction");
  });

  it("refreshes matched records by BSG id and appends unmatched remote quests", () => {
    const remote = {
      meta: { generated: "2026-08-02T09:43:19.569Z", count: 2 },
      quests: [
        {
          id: "sample-quest",
          gameId: "same-id",
          name: "Sample Quest",
          trader: "Mechanic",
          map: "woods",
          minPlayerLevel: 17,
          kappa: true,
          objectives: [],
        },
        {
          id: "new-quest",
          gameId: "new-id",
          name: "New Quest",
          trader: "Ragman",
          map: "reserve",
          minPlayerLevel: 12,
          kappa: false,
          objectives: [{ id: "remote-objective", type: "mark", description: "Mark a place" }],
        },
      ],
    };

    const refreshed = mergeQuestSources(emptyPack, remote, {
      wikiQuestCount: 514,
      wikiRevisionTimestamp: "2026-08-19T23:11:55Z",
    });

    expect(refreshed.quests).toHaveLength(2);
    expect(refreshed.quests[0]).toMatchObject({
      id: "local-quest",
      bsgId: "same-id",
      name: "Sample Quest",
      trader: "Mechanic",
      locations: ["Woods"],
      minLevel: 17,
      kappaRequired: true,
      requirements: [],
      objectives: [],
    });
    expect(refreshed.quests[1]).toMatchObject({
      bsgId: "new-id",
      name: "New Quest",
      trader: "Ragman",
      locations: ["Reserve"],
      minLevel: 12,
      kappaRequired: false,
    });
    expect(refreshed.quests[1].objectives[0]).toMatchObject({
      objectiveType: "mark",
      description: "Mark a place",
      locationPoints: [],
      optionalPoints: [],
    });
    expect(refreshed.meta.counts.quests).toBe(2);
    expect(refreshed.meta.sources).toMatchObject({
      tarkovDataGeneratedAt: "2026-08-02T09:43:19.569Z",
      wikiQuestCount: 514,
    });

    const repeated = mergeQuestSources(refreshed, remote, {
      wikiQuestCount: 516,
      wikiRevisionTimestamp: "2026-08-07T14:28:05Z",
    });
    expect(repeated.meta.sources.localExportedAt).toBe("2026-05-06T18:03:23Z");
  });

  it("preserves enriched ids and objective coordinates while refreshing current fields", () => {
    const enriched = {
      ...baseQuest,
      id: "tarkovdata-saved-quest",
      bsgId: "same-id",
      locations: ["Woods"],
      rewardXp: 12345,
      objectives: [{
        id: "remote-objective",
        mapName: "Woods",
        locationPoints: [{ x: 1, y: 2, z: 3 }],
      }],
    };
    const refreshed = mergeQuestSources(
      { ...emptyPack, quests: [enriched] },
      {
        meta: { generated: "now", count: 1 },
        quests: [{
          id: "new-upstream-id",
          gameId: "same-id",
          name: "Updated Quest",
          trader: "Mechanic",
          map: "woods",
          objectives: [{ id: "remote-objective", type: "mark", description: "Updated objective" }],
        }],
      },
    );

    expect(refreshed.quests[0]).toMatchObject({
      id: "tarkovdata-saved-quest",
      bsgId: "same-id",
      name: "Updated Quest",
      locations: ["Woods"],
      rewardXp: 12345,
    });
    expect(refreshed.quests[0].objectives[0]).toMatchObject({
      id: "remote-objective",
      description: "Updated objective",
      mapName: "Woods",
      locationPoints: [{ x: 1, y: 2, z: 3 }],
    });
  });

  it("keeps a legacy objective id and coordinates when the live objective id changed", () => {
    const local = {
      ...baseQuest,
      objectives: [{
        id: "legacy-objective-id",
        sortOrder: 0,
        objectiveType: "Mark",
        description: "Mark the medical container",
        mapName: "Woods",
        locationPoints: [{ x: 10, y: 2, z: -4 }],
        optionalPoints: [],
      }],
    };
    const refreshed = mergeQuestSources(
      { ...emptyPack, quests: [local] },
      {
        meta: { generated: "now", count: 1 },
        quests: [{
          id: "sample-quest",
          gameId: "same-id",
          name: "Sample Quest",
          trader: "Mechanic",
          map: "woods",
          objectives: [{
            id: "live-objective-id",
            type: "mark",
            description: "Mark the medical container",
            maps: ["woods"],
          }],
          requirements: [],
        }],
      },
    );

    expect(refreshed.quests[0].objectives).toEqual([
      expect.objectContaining({
        id: "legacy-objective-id",
        bsgId: "live-objective-id",
        description: "Mark the medical container",
        mapName: "Woods",
        locationPoints: [{ x: 10, y: 2, z: -4 }],
      }),
    ]);
  });

  it("drops stale local coordinates when a matched objective moved to another map", () => {
    const local = {
      ...baseQuest,
      locations: ["Lighthouse"],
      objectives: [{
        id: "legacy-objective-id",
        sortOrder: 0,
        objectiveType: "Mark",
        description: "Mark the medical container",
        mapName: "Lighthouse",
        locationPoints: [{ x: 10, y: 2, z: -4 }],
        optionalPoints: [],
      }],
    };
    const refreshed = mergeQuestSources(
      { ...emptyPack, quests: [local] },
      {
        meta: { generated: "now", count: 1 },
        quests: [{
          id: "sample-quest",
          gameId: "same-id",
          name: "Sample Quest",
          trader: "Mechanic",
          map: "woods",
          objectives: [{
            id: "live-objective-id",
            type: "mark",
            description: "Mark the medical container",
            maps: ["woods"],
          }],
          requirements: [],
        }],
      },
    );

    expect(refreshed.quests[0].objectives[0]).toMatchObject({
      id: "legacy-objective-id",
      bsgId: "live-objective-id",
      mapName: "Woods",
      locationPoints: [],
      optionalPoints: [],
    });
  });

  it("does not retain a legacy map marker on a current handover-only objective", () => {
    const local = {
      ...baseQuest,
      locations: ["Woods"],
      objectives: [{
        id: "legacy-handover",
        sortOrder: 0,
        objectiveType: "HandOver",
        description: "Hand over the folder",
        itemId: "folder",
        targetCount: 1,
        mapName: "Woods",
        locationPoints: [{ x: -40, y: 1, z: -143 }],
        optionalPoints: [],
      }],
    };
    const refreshed = mergeQuestSources(
      { ...emptyPack, quests: [local] },
      {
        meta: { generated: "now", count: 1 },
        quests: [{
          id: "sample-quest",
          gameId: "same-id",
          name: "Sample Quest",
          trader: "Mechanic",
          map: null,
          objectives: [{
            id: "live-handover",
            type: "giveQuestItem",
            description: "Hand over the folder",
            items: ["folder"],
            count: 1,
          }],
          requirements: [],
        }],
      },
    );

    expect(refreshed.quests[0].objectives[0]).toMatchObject({
      id: "legacy-handover",
      bsgId: "live-handover",
      locationPoints: [],
      optionalPoints: [],
    });
  });

  it("preserves ordered legacy handover ids when duplicate labels omitted item ids", () => {
    const local = {
      ...baseQuest,
      objectives: [
        {
          id: "legacy-find-a",
          sortOrder: 0,
          objectiveType: "Collect",
          description: "Find injector A",
          itemId: "item-a",
          targetCount: 1,
        },
        {
          id: "legacy-give-a",
          sortOrder: 1,
          objectiveType: "HandOver",
          description: "Hand over the injector",
          targetCount: 1,
        },
        {
          id: "legacy-find-b",
          sortOrder: 2,
          objectiveType: "Collect",
          description: "Find injector B",
          itemId: "item-b",
          targetCount: 1,
        },
        {
          id: "legacy-give-b",
          sortOrder: 3,
          objectiveType: "HandOver",
          description: "Hand over the injector",
          targetCount: 1,
        },
      ],
    };
    const refreshed = mergeQuestSources(
      { ...emptyPack, quests: [local] },
      {
        meta: { generated: "now", count: 1 },
        quests: [{
          id: "sample-quest",
          gameId: "same-id",
          name: "Sample Quest",
          trader: "Therapist",
          objectives: [
            { id: "live-find-a", type: "findItem", description: "Find injector A", items: ["item-a"], count: 1 },
            { id: "live-give-a", type: "giveItem", description: "Hand over the injector", items: ["item-a"], count: 1 },
            { id: "live-find-b", type: "findItem", description: "Find injector B", items: ["item-b"], count: 1 },
            { id: "live-give-b", type: "giveItem", description: "Hand over the injector", items: ["item-b"], count: 1 },
          ],
        }],
      },
    );

    expect(refreshed.quests[0].objectives.map((objective) => objective.id)).toEqual([
      "legacy-find-a",
      "legacy-give-a",
      "legacy-find-b",
      "legacy-give-b",
    ]);
  });

  it("uses item identity to preserve duplicate legacy descriptions across type renames", () => {
    const local = {
      ...baseQuest,
      objectives: [
        {
          id: "legacy-water-report",
          sortOrder: 0,
          objectiveType: "Custom",
          description: "Hand over the extracted data",
          itemId: "water-report",
        },
        {
          id: "legacy-pump-report",
          sortOrder: 1,
          objectiveType: "Custom",
          description: "Hand over the extracted data",
          itemId: "pump-report",
        },
      ],
    };
    const refreshed = mergeQuestSources(
      { ...emptyPack, quests: [local] },
      {
        meta: { generated: "now", count: 1 },
        quests: [{
          id: "sample-quest",
          gameId: "same-id",
          name: "Sample Quest",
          trader: "Mechanic",
          objectives: [
            { id: "live-water-report", type: "giveQuestItem", description: "Hand over the extracted data", questItem: "water-report", count: 1 },
            { id: "live-pump-report", type: "giveQuestItem", description: "Hand over the extracted data", questItem: "pump-report", count: 1 },
          ],
        }],
      },
    );

    expect(refreshed.quests[0].objectives.map((objective) => objective.id)).toEqual([
      "legacy-water-report",
      "legacy-pump-report",
    ]);
  });

  it("uses live possibleLocations as world coordinates", () => {
    const [normalized] = normalizeTarkovDevTasks({
      data: {
        tasks: {
          "position-task": {
            id: "position-task",
            name: "position-task name",
            trader: "trader-id",
            map: "woods-id",
            objectives: [{
              id: "position-objective",
              description: "position-objective",
              type: "findQuestItem",
              maps: ["woods-id"],
              possibleLocations: [{
                map: "woods-id",
                positions: [
                  { x: -41.1733, y: 7.6146, z: -110.08528 },
                  { x: 58.483997, y: 0.9229994, z: -72.764984 },
                ],
              }],
            }],
          },
        },
      },
      english: {
        "position-task name": "Position Task",
        "position-objective": "Find the hidden package",
      },
      maps: { "woods-id Name": "Woods" },
      traders: [{ id: "trader-id", name: "Mechanic" }],
    });

    const appQuest = toAppQuest(normalized);
    expect(appQuest.objectives[0]).toMatchObject({
      bsgId: "position-objective",
      mapName: "Woods",
      locationPoints: [],
      optionalPoints: [
        { x: -41.1733, y: 7.6146, z: -110.08528 },
        { x: 58.483997, y: 0.9229994, z: -72.764984 },
      ],
    });
  });

  it("namespaces new objective app ids while retaining the upstream objective id", () => {
    const appQuest = toAppQuest({
      id: "quest-with-shared-objective",
      gameId: "quest-bsg-id",
      name: "Quest With Shared Objective",
      trader: "Mechanic",
      map: "woods",
      objectives: [{
        id: "shared-objective-id",
        type: "visit",
        description: "Visit the location",
      }],
    });

    expect(appQuest.objectives[0]).toMatchObject({
      id: "tarkovdata-quest-with-shared-objective:objective:shared-objective-id",
      bsgId: "shared-objective-id",
    });
  });

  it("separates duplicate legacy objective ids across quests without changing unique local ids", () => {
    const localQuest = (id, bsgId, objectiveId) => ({
      ...baseQuest,
      id,
      bsgId,
      normalizedName: id,
      name: id,
      nameEn: id,
      objectives: [{
        id: objectiveId,
        bsgId: "shared-upstream-objective",
        sortOrder: 0,
        objectiveType: "visit",
        description: "Visit the location",
        requiresFir: false,
        locationPoints: [],
        optionalPoints: [],
      }],
    });
    const refreshed = mergeQuestSources(
      {
        ...emptyPack,
        quests: [
          localQuest("stable-quest-a", "quest-a", "shared-upstream-objective"),
          localQuest("stable-quest-b", "quest-b", "shared-upstream-objective"),
          localQuest("stable-quest-c", "quest-c", "unique-local-objective"),
        ],
      },
      {
        meta: { generated: "now", count: 3 },
        quests: [
          {
            id: "quest-a",
            gameId: "quest-a",
            name: "stable-quest-a",
            trader: "Mechanic",
            objectives: [{ id: "shared-upstream-objective", type: "visit" }],
          },
          {
            id: "quest-b",
            gameId: "quest-b",
            name: "stable-quest-b",
            trader: "Mechanic",
            objectives: [{ id: "shared-upstream-objective", type: "visit" }],
          },
          {
            id: "quest-c",
            gameId: "quest-c",
            name: "stable-quest-c",
            trader: "Mechanic",
            objectives: [{ id: "unique-upstream-objective", type: "visit" }],
          },
        ],
      },
    );

    const byQuestId = new Map(refreshed.quests.map((quest) => [quest.id, quest]));
    expect(byQuestId.get("stable-quest-a").objectives[0]).toMatchObject({
      id: "stable-quest-a:objective:shared-upstream-objective",
      bsgId: "shared-upstream-objective",
      progressIdAliases: ["shared-upstream-objective"],
    });
    expect(byQuestId.get("stable-quest-b").objectives[0]).toMatchObject({
      id: "stable-quest-b:objective:shared-upstream-objective",
      bsgId: "shared-upstream-objective",
    });
    expect(byQuestId.get("stable-quest-c").objectives[0].id).toBe("unique-local-objective");
  });

  it("keeps only the selected map's legacy points and preserves deduplicated points per map", () => {
    const appQuest = toAppQuest({
      id: "multi-map-quest",
      gameId: "multi-map-bsg-id",
      name: "Multi-map Quest",
      trader: "Mechanic",
      objectives: [{
        id: "multi-map-objective",
        type: "visit",
        description: "Visit either location",
        locations: [
          {
            map: "woods",
            optional: false,
            positions: [
              { x: 10, y: 2, z: 30 },
              { x: 10, y: 2, z: 30 },
            ],
          },
          {
            map: "reserve",
            optional: false,
            positions: [{ x: 40, y: 5, z: 60 }],
          },
          {
            map: "woods",
            optional: true,
            positions: [
              { x: 70, y: 8, z: 90 },
              { x: 70, y: 8, z: 90 },
            ],
          },
        ],
      }],
    });

    expect(appQuest.objectives[0]).toMatchObject({
      mapName: "Woods",
      mapNames: ["Woods", "Reserve"],
      locationPoints: [{ x: 10, y: 2, z: 30 }],
      optionalPoints: [{ x: 70, y: 8, z: 90 }],
      mapLocations: [
        {
          mapName: "Woods",
          locationPoints: [{ x: 10, y: 2, z: 30 }],
          optionalPoints: [{ x: 70, y: 8, z: 90 }],
        },
        {
          mapName: "Reserve",
          locationPoints: [{ x: 40, y: 5, z: 60 }],
          optionalPoints: [],
        },
      ],
    });
  });

  it("refreshes a legacy Wiki quest by BSG id while retaining its old name as an alias", () => {
    const legacy = {
      ...baseQuest,
      id: "QmV5b25kLXRoZS1SZWQtTWVhdC0y",
      bsgId: "64f6aafd67e11a7c6206e0d0",
      name: "Beyond the Red Meat - Part 2",
      nameEn: "Beyond the Red Meat - Part 2",
      normalizedName: "beyond-the-red-meat-part-2",
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Beyond_the_Red_Meat_-_Part_2",
      minLevel: 22,
      trader: "Jaeger",
    };
    const refreshed = mergeQuestSources(
      { ...emptyPack, quests: [legacy] },
      {
        meta: { generated: "now", count: 1 },
        quests: [{
          id: "the-secret-recipe",
          gameId: "64f6aafd67e11a7c6206e0d0",
          name: "The Secret Recipe",
          wiki: "https://escapefromtarkov.fandom.com/wiki/The_Secret_Recipe",
          minPlayerLevel: 37,
          trader: "Skier",
          objectives: [],
          requirements: [],
        }],
      },
    );

    expect(refreshed.quests).toHaveLength(1);
    expect(refreshed.quests[0]).toMatchObject({
      id: "QmV5b25kLXRoZS1SZWQtTWVhdC0y",
      bsgId: "64f6aafd67e11a7c6206e0d0",
      name: "The Secret Recipe",
      nameEn: "The Secret Recipe",
      normalizedName: "beyond-the-red-meat-part-2",
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/The_Secret_Recipe",
      minLevel: 37,
      trader: "Skier",
    });
    expect(refreshed.quests[0].nameAliases).toContain("Beyond the Red Meat - Part 2");
  });

  it("removes obsolete local prerequisites when the live task has an explicit empty requirement list", () => {
    const legacy = {
      ...baseQuest,
      id: "tarkovdata-current-quest",
      requirements: [{
        questId: "obsolete-prerequisite",
        requirementType: "Complete",
        groupId: 1,
      }],
    };
    const refreshed = mergeQuestSources(
      { ...emptyPack, quests: [legacy] },
      {
        meta: { generated: "now", count: 1 },
        quests: [{
          id: "current-quest",
          gameId: "same-id",
          name: "Sample Quest",
          trader: "Mechanic",
          objectives: [],
          requirements: [],
        }],
      },
    );

    expect(refreshed.quests[0].requirements).toEqual([]);
  });

  it("keeps distinct USEC and BEAR tasks that normalize to the same quest name", () => {
    const usecQuest = {
      ...baseQuest,
      id: "tarkovdata-make-amends-usec",
      bsgId: "make-amends-usec-id",
      name: "Make Amends - USEC",
      nameEn: "Make Amends - USEC",
    };
    const refreshed = mergeQuestSources(
      { ...emptyPack, quests: [usecQuest] },
      {
        meta: { generated: "now", count: 2 },
        quests: [
          {
            id: "make-amends-usec",
            gameId: "make-amends-usec-id",
            name: "Make Amends - USEC",
            trader: "Lightkeeper",
            objectives: [],
            requirements: [],
          },
          {
            id: "make-amends-bear",
            gameId: "make-amends-bear-id",
            name: "Make Amends - BEAR",
            trader: "Lightkeeper",
            objectives: [],
            requirements: [],
          },
        ],
      },
    );

    expect(refreshed.quests).toHaveLength(2);
    expect(refreshed.quests.map((quest) => quest.bsgId)).toEqual([
      "make-amends-usec-id",
      "make-amends-bear-id",
    ]);
  });

  it("coalesces duplicate upstream records by BSG id and lets the live feed win", () => {
    const refreshed = mergeQuestSources(
      { ...emptyPack, quests: [] },
      {
        meta: { generated: "now", count: 2 },
        quests: [
          {
            id: "old-source-slug",
            gameId: "shared-bsg-id",
            name: "Old Source Name",
            trader: "Prapor",
            objectives: [],
            requirements: [],
          },
          {
            id: "shared-bsg-id",
            gameId: "shared-bsg-id",
            name: "Current Live Name",
            trader: "Skier",
            objectives: [],
            requirements: [],
          },
        ],
      },
    );

    expect(refreshed.quests).toHaveLength(1);
    expect(refreshed.quests[0]).toMatchObject({
      bsgId: "shared-bsg-id",
      name: "Current Live Name",
      trader: "Skier",
    });
  });

  it("preserves every accepted status from a live task prerequisite", () => {
    const [normalized] = normalizeTarkovDevTasks({
      data: {
        tasks: {
          "multi-status-task": {
            id: "multi-status-task",
            name: "multi-status-task name",
            trader: "trader-id",
            taskRequirements: [{
              task: "prerequisite-task",
              status: ["Success", "Fail"],
            }],
            objectives: [],
          },
        },
      },
      english: { "multi-status-task name": "Multi-status Task" },
      traders: [{ id: "trader-id", name: "Mechanic" }],
    });

    expect(normalized.requirements).toEqual([
      { questId: "prerequisite-task", requirementType: "Success", groupId: 1 },
      { questId: "prerequisite-task", requirementType: "Fail", groupId: 1 },
    ]);
  });

  it("derives mutually exclusive quest choices only from completed-task fail conditions", () => {
    const normalized = normalizeTarkovDevTasks({
      data: {
        tasks: {
          "route-a": {
            id: "route-a",
            name: "route-a name",
            trader: "trader-id",
            failConditions: [
              { type: "taskStatus", task: "route-b", status: ["complete"] },
              { type: "taskStatus", task: "route-b", status: ["Complete"] },
              { type: "taskStatus", task: "retry-task", status: ["failed"] },
              { type: "useItem", task: "not-a-route", status: ["complete"] },
            ],
            objectives: [],
          },
          "route-b": {
            id: "route-b",
            name: "route-b name",
            trader: "trader-id",
            objectives: [],
          },
        },
      },
      english: { "route-a name": "Route A", "route-b name": "Route B" },
      traders: [{ id: "trader-id", name: "Skier" }],
    });

    const routeA = normalized.find((quest) => quest.id === "route-a");
    const routeB = normalized.find((quest) => quest.id === "route-b");
    expect(routeA.alternativeQuestIds).toEqual([]);
    expect(routeB.alternativeQuestIds).toEqual(["route-a"]);
    expect(toAppQuest(routeB).alternativeQuestIds).toEqual(["route-a"]);
  });

  it("rebuilds current follow-up and alternative links with stable app ids", () => {
    const quest = (id, bsgId, overrides = {}) => ({
      ...baseQuest,
      id,
      bsgId,
      normalizedName: id,
      name: id,
      nameEn: id,
      requirements: [],
      alternativeQuestIds: [],
      followUpQuestIds: [],
      ...overrides,
    });
    const localPack = {
      ...emptyPack,
      quests: [
        quest("stable-prerequisite", "prerequisite-bsg", {
          kappaRequired: false,
          followUpQuestIds: ["obsolete-follow-up"],
        }),
        quest("stable-target", "target-bsg", {
          alternativeQuestIds: ["obsolete-alternative"],
        }),
        quest("stable-branch", "branch-bsg"),
        quest("stable-non-kappa", "non-kappa-bsg", {
          followUpQuestIds: ["stable-collector"],
        }),
        quest("stable-collector", "collector-bsg", { name: "Collector", nameEn: "Collector" }),
      ],
    };
    const remote = {
      meta: { generated: "now", count: 5 },
      quests: [
        {
          id: "prerequisite",
          gameId: "prerequisite-bsg",
          name: "Current Prerequisite",
          trader: "Prapor",
          kappaRequired: true,
          requirements: [],
          objectives: [],
        },
        {
          id: "target",
          gameId: "target-bsg",
          name: "Current Target",
          trader: "Prapor",
          requirements: [{ questId: "prerequisite-bsg", requirementType: "complete", groupId: 1 }],
          alternativeQuestIds: ["branch-bsg"],
          objectives: [],
        },
        {
          id: "branch",
          gameId: "branch-bsg",
          name: "Current Branch",
          trader: "Prapor",
          requirements: [],
          objectives: [],
        },
        {
          id: "non-kappa",
          gameId: "non-kappa-bsg",
          name: "Current Non-Kappa",
          trader: "Prapor",
          kappaRequired: false,
          requirements: [],
          objectives: [],
        },
        {
          id: "collector",
          gameId: "collector-bsg",
          name: "Collector",
          trader: "Fence",
          requirements: [],
          objectives: [],
        },
      ],
    };

    const refreshed = mergeQuestSources(localPack, remote);
    const byId = new Map(refreshed.quests.map((candidate) => [candidate.id, candidate]));

    expect(byId.get("stable-prerequisite").followUpQuestIds).toEqual([
      "stable-target",
      "stable-collector",
    ]);
    expect(byId.get("stable-target").alternativeQuestIds).toEqual(["stable-branch"]);
    expect(byId.get("stable-branch").alternativeQuestIds).toEqual([]);
    expect(byId.get("stable-non-kappa").followUpQuestIds).toEqual([]);
  });

  it("lists only completion-based prerequisites as follow-up quests", () => {
    const localQuest = (id, bsgId) => ({
      ...baseQuest,
      id,
      bsgId,
      normalizedName: id,
      name: id,
      nameEn: id,
    });
    const localPack = {
      ...emptyPack,
      quests: [
        localQuest("stable-source", "source-bsg"),
        localQuest("stable-complete", "complete-bsg"),
        localQuest("stable-success", "success-bsg"),
        localQuest("stable-active", "active-bsg"),
        localQuest("stable-failed", "failed-bsg"),
      ],
    };
    const remoteQuest = (id, requirements = []) => ({
      id,
      gameId: `${id}-bsg`,
      name: id,
      trader: "Prapor",
      requirements,
      objectives: [],
    });
    const requirement = (requirementType) => ({
      questId: "source-bsg",
      requirementType,
      groupId: 1,
    });
    const refreshed = mergeQuestSources(localPack, {
      meta: { count: 5 },
      quests: [
        remoteQuest("source"),
        remoteQuest("complete", [requirement("Complete")]),
        remoteQuest("success", [requirement("Success")]),
        remoteQuest("active", [requirement("Active")]),
        remoteQuest("failed", [requirement("Failed")]),
      ],
    });
    const source = refreshed.quests.find((quest) => quest.id === "stable-source");

    expect(source.followUpQuestIds).toEqual(["stable-complete", "stable-success"]);
  });

  it("keeps live trader and game-state requirements instead of silently dropping them", () => {
    const [normalized] = normalizeTarkovDevTasks({
      data: {
        tasks: {
          "condition-task": {
            id: "condition-task",
            name: "condition-task name",
            trader: "skier-id",
            experience: 12345,
            kappaRequired: true,
            factionName: "Bear",
            finishRewards: {
              traderStanding: [{ trader: "skier-id", standing: 0.25 }],
              skillLevelReward: [{ skill: "Surgery", level: 2 }],
              items: [],
              offerUnlock: [],
            },
            traderRequirements: [{
              id: "loyalty-condition",
              trader: "skier-id",
              requirementType: "level",
              compareMethod: ">=",
              value: 2,
            }],
            otherRequirements: [
              {
                id: "dialogue-condition",
                type: "dialogue",
                traders: ["skier-id"],
              },
              {
                id: "variable-condition",
                type: "globalVariable",
                variableId: "story-progress-id",
                compareMethod: ">=",
                value: 1,
              },
            ],
            objectives: [],
          },
        },
      },
      english: { "condition-task name": "Condition Task" },
      traders: [{ id: "skier-id", name: "Skier" }],
    });

    const result = toAppQuest(normalized);
    expect(result).toMatchObject({
      rewardXp: 12345,
      kappaRequired: true,
      faction: "Bear",
      rewardReputation: [{ trader: "Skier", amount: 0.25 }],
      rewardSkills: [{ skill: "Surgery", levels: 2 }],
    });
    expect(result.traderRequirements).toEqual([{
      id: "loyalty-condition",
      traderId: "skier-id",
      traderName: "Skier",
      requirementType: "level",
      compareMethod: ">=",
      value: 2,
    }]);
    expect(result.otherRequirements).toEqual([
      {
        id: "dialogue-condition",
        type: "dialogue",
        traderIds: ["skier-id"],
        traderNames: ["Skier"],
      },
      {
        id: "variable-condition",
        type: "globalVariable",
        variableId: "story-progress-id",
        compareMethod: ">=",
        value: 1,
      },
    ]);
  });

  it("maps live item ids onto stable local ids and creates missing quest items", () => {
    const localItems = [{
      id: "legacy-salewa-id",
      name: "Salewa first aid kit",
      nameEn: "Salewa first aid kit",
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Salewa_first_aid_kit",
      categories: ["Medical"],
      isDogtagItem: false,
    }];
    const merged = mergeTarkovDevItems({
      localItems,
      data: {
        items: {
          "salewa-bsg-id": {
            id: "salewa-bsg-id",
            name: "salewa-bsg-id Name",
            shortName: "salewa-bsg-id ShortName",
            wikiLink: "https://escapefromtarkov.fandom.com/wiki/Salewa_first_aid_kit",
            types: ["medical"],
          },
        },
      },
      english: {
        "salewa-bsg-id Name": "Salewa first aid kit",
        "salewa-bsg-id ShortName": "Salewa",
        "quest-item-bsg-id Name": "Secret component",
        "quest-item-bsg-id ShortName": "Vial",
      },
      korean: {
        "salewa-bsg-id Name": "살레와 구급낭",
        "quest-item-bsg-id Name": "비밀 재료",
      },
      referencedItemIds: ["salewa-bsg-id", "quest-item-bsg-id"],
    });

    expect(merged.items).toHaveLength(2);
    expect(merged.items[0]).toMatchObject({
      id: "legacy-salewa-id",
      bsgId: "salewa-bsg-id",
      nameEn: "Salewa first aid kit",
      nameKo: "살레와 구급낭",
    });
    expect(merged.items[1]).toMatchObject({
      id: "tarkovdata-item-quest-item-bsg-id",
      bsgId: "quest-item-bsg-id",
      nameEn: "Secret component",
      nameKo: "비밀 재료",
    });
    expect(merged.itemIdByBsgId.get("salewa-bsg-id")).toBe("legacy-salewa-id");
    expect(merged.itemIdByBsgId.get("quest-item-bsg-id"))
      .toBe("tarkovdata-item-quest-item-bsg-id");
  });

  it("replaces a generated quest-item placeholder when a stable legacy item can be identified", () => {
    const merged = mergeTarkovDevItems({
      localItems: [
        {
          id: "legacy-secret-item",
          name: "Secret component",
          nameEn: "Secret component",
          categories: ["Quest Items"],
          isDogtagItem: false,
        },
        {
          id: "tarkovdata-item-secret-bsg-id",
          bsgId: "secret-bsg-id",
          name: "secret-bsg-id",
          nameEn: "secret-bsg-id",
          categories: ["questItem"],
          isDogtagItem: false,
        },
      ],
      data: { items: {} },
      english: { "secret-bsg-id Name": "Secret component" },
      referencedItemIds: ["secret-bsg-id"],
    });

    expect(merged.items).toHaveLength(1);
    expect(merged.items[0]).toMatchObject({
      id: "legacy-secret-item",
      bsgId: "secret-bsg-id",
      nameEn: "Secret component",
    });
    expect(merged.itemIdByBsgId.get("secret-bsg-id")).toBe("legacy-secret-item");
  });

  it("matches an exact item name before a wiki page shared by another live item", () => {
    const sharedWiki = "https://escapefromtarkov.fandom.com/wiki/Dorm_room_314_marked_key";
    const merged = mergeTarkovDevItems({
      localItems: [{
        id: "legacy-marked-key",
        name: "Dorm room 314 marked key",
        nameEn: "Dorm room 314 marked key",
        wikiPageLink: sharedWiki,
        categories: ["Keys"],
        isDogtagItem: false,
      }],
      data: {
        items: {
          "marked-key-preset-bsg-id": {
            id: "marked-key-preset-bsg-id",
            name: "marked-key-preset-bsg-id Name",
            wikiLink: sharedWiki,
            types: ["preset"],
          },
          "marked-key-bsg-id": {
            id: "marked-key-bsg-id",
            name: "marked-key-bsg-id Name",
            wikiLink: sharedWiki,
            types: ["key"],
          },
        },
      },
      english: {
        "marked-key-preset-bsg-id Name": "Dorm room 314 marked key preset",
        "marked-key-bsg-id Name": "Dorm room 314 marked key",
      },
      referencedItemIds: ["marked-key-preset-bsg-id", "marked-key-bsg-id"],
    });

    expect(merged.itemIdByBsgId.get("marked-key-bsg-id")).toBe("legacy-marked-key");
    expect(merged.itemIdByBsgId.get("marked-key-preset-bsg-id"))
      .toBe("tarkovdata-item-marked-key-preset-bsg-id");
    expect(new Set(merged.itemIdByBsgId.values()).size).toBe(2);
    expect(merged.items).toHaveLength(2);
    expect(merged.items.map((item) => item.bsgId).sort()).toEqual([
      "marked-key-bsg-id",
      "marked-key-preset-bsg-id",
    ]);
  });

  it("assigns each stable local item id to at most one live bsg id", () => {
    const sharedWiki = "https://escapefromtarkov.fandom.com/wiki/Shared_item_page";
    const merged = mergeTarkovDevItems({
      localItems: [{
        id: "legacy-shared-item",
        name: "Legacy shared item",
        nameEn: "Legacy shared item",
        wikiPageLink: sharedWiki,
        categories: [],
        isDogtagItem: false,
      }],
      data: {
        items: {
          "shared-live-a": {
            id: "shared-live-a",
            name: "shared-live-a Name",
            wikiLink: sharedWiki,
            types: ["item"],
          },
          "shared-live-b": {
            id: "shared-live-b",
            name: "shared-live-b Name",
            wikiLink: sharedWiki,
            types: ["preset"],
          },
        },
      },
      english: {
        "shared-live-a Name": "Live item A",
        "shared-live-b Name": "Live item B",
      },
      referencedItemIds: ["shared-live-a", "shared-live-b"],
    });

    expect(merged.items.find((item) => item.id === "legacy-shared-item"))
      .not.toHaveProperty("bsgId");
    expect(merged.itemIdByBsgId.get("shared-live-a")).toBe("tarkovdata-item-shared-live-a");
    expect(merged.itemIdByBsgId.get("shared-live-b")).toBe("tarkovdata-item-shared-live-b");
    expect(new Set(merged.itemIdByBsgId.values()).size).toBe(2);
  });

  it("keeps local items but excludes live items not referenced by quests", () => {
    const merged = mergeTarkovDevItems({
      localItems: [{
        id: "legacy-local-item",
        bsgId: "legacy-local-bsg-id",
        name: "Legacy local item",
        nameEn: "Legacy local item",
        categories: ["Legacy"],
        isDogtagItem: false,
      }],
      data: {
        items: {
          "referenced-live-id": {
            id: "referenced-live-id",
            name: "referenced-live-id Name",
            types: ["questItem"],
          },
          "unreferenced-live-id": {
            id: "unreferenced-live-id",
            name: "unreferenced-live-id Name",
            types: ["item"],
          },
        },
      },
      english: {
        "referenced-live-id Name": "Referenced live item",
        "unreferenced-live-id Name": "Unreferenced live item",
      },
      referencedItemIds: ["referenced-live-id"],
    });

    expect(merged.items.map((item) => item.id)).toEqual([
      "legacy-local-item",
      "tarkovdata-item-referenced-live-id",
    ]);
    expect(merged.itemIdByBsgId.has("unreferenced-live-id")).toBe(false);
  });

  it("omits redundant sell-item alternatives while preserving handover choices", () => {
    const [normalized] = normalizeTarkovDevTasks({
      data: {
        tasks: {
          "mixed-item-task": {
            id: "mixed-item-task",
            name: "mixed-item-task name",
            trader: "ragman-id",
            objectives: [
              {
                id: "sell-any-item",
                description: "sell-any-item",
                type: "sellItem",
                count: 50,
                items: ["sale-item-a", "sale-item-b", "sale-item-c"],
              },
              {
                id: "give-either-medical-item",
                description: "give-either-medical-item",
                type: "giveItem",
                count: 2,
                items: ["medical-item-a", "medical-item-b"],
              },
            ],
          },
        },
      },
      english: {
        "mixed-item-task name": "Mixed Item Task",
        "sell-any-item": "Sell any item to Ragman",
        "give-either-medical-item": "Hand over either medical item",
      },
      traders: [{ id: "ragman-id", name: "Ragman" }],
      itemIdByBsgId: new Map([
        ["sale-item-a", "sale-app-a"],
        ["sale-item-b", "sale-app-b"],
        ["sale-item-c", "sale-app-c"],
        ["medical-item-a", "medical-app-a"],
        ["medical-item-b", "medical-app-b"],
      ]),
      itemNamesByBsgId: new Map([
        ["sale-item-a", "Sale item A"],
        ["sale-item-b", "Sale item B"],
        ["sale-item-c", "Sale item C"],
        ["medical-item-a", "Medical item A"],
        ["medical-item-b", "Medical item B"],
      ]),
    });

    const result = toAppQuest(normalized);
    const sellObjective = result.objectives.find(
      (objective) => objective.bsgId === "sell-any-item",
    );
    const handoverObjective = result.objectives.find(
      (objective) => objective.bsgId === "give-either-medical-item",
    );

    expect(sellObjective).toMatchObject({ itemId: "sale-app-a" });
    expect(sellObjective).not.toHaveProperty("alternativeItemIds");
    expect(handoverObjective).toMatchObject({
      itemId: "medical-app-a",
      alternativeItemIds: ["medical-app-b"],
    });
    expect(result.requiredItems).toEqual([
      expect.objectContaining({
        itemId: "medical-app-a",
        alternativeItemIds: ["medical-app-b"],
        alternativeItemNames: ["Medical item B"],
        count: 2,
        requirementType: "Handover",
      }),
    ]);
  });

  it("derives current required items and finish rewards from live objectives", () => {
    const itemIdByBsgId = new Map([
      ["salewa-bsg-id", "legacy-salewa-id"],
      ["quest-item-bsg-id", "legacy-quest-item-id"],
      ["key-bsg-id", "legacy-key-id"],
      ["euro-bsg-id", "legacy-euro-id"],
    ]);
    const itemNamesByBsgId = new Map([
      ["salewa-bsg-id", "Salewa first aid kit"],
      ["quest-item-bsg-id", "Secret component"],
      ["key-bsg-id", "TerraGroup meeting room key"],
      ["euro-bsg-id", "Euros"],
    ]);
    const [normalized] = normalizeTarkovDevTasks({
      data: {
        tasks: {
          "item-task": {
            id: "item-task",
            name: "item-task name",
            trader: "skier-id",
            objectives: [
              {
                id: "give-meds",
                description: "give-meds",
                type: "giveItem",
                count: 2,
                items: ["salewa-bsg-id"],
                foundInRaid: true,
              },
              {
                id: "give-quest-item",
                description: "give-quest-item",
                type: "giveQuestItem",
                count: 1,
                questItem: "quest-item-bsg-id",
                requiredKeys: [["key-bsg-id"]],
              },
            ],
            finishRewards: {
              items: [{ item: "euro-bsg-id", count: 1000, attributes: {} }],
              traderStanding: [],
              skillLevelReward: [],
              offerUnlock: [],
            },
          },
        },
      },
      english: {
        "item-task name": "Item Task",
        "give-meds": "Hand over the medical kits",
        "give-quest-item": "Hand over the secret component",
      },
      traders: [{ id: "skier-id", name: "Skier" }],
      itemIdByBsgId,
      itemNamesByBsgId,
    });
    const result = toAppQuest(normalized);

    expect(result.requiredItems).toEqual([
      expect.objectContaining({
        itemId: "legacy-salewa-id",
        itemName: "Salewa first aid kit",
        count: 2,
        requiresFir: true,
        requirementType: "Handover",
      }),
      expect.objectContaining({
        itemId: "legacy-quest-item-id",
        itemName: "Secret component",
        count: 1,
        requirementType: "Handover",
      }),
      expect.objectContaining({
        itemId: "legacy-key-id",
        itemName: "TerraGroup meeting room key",
        count: 1,
        requirementType: "Required",
      }),
    ]);
    expect(result.rewardItems).toEqual([
      expect.objectContaining({
        itemId: "legacy-euro-id",
        itemName: "Euros",
        count: 1000,
      }),
    ]);
  });

  it("sums repeated plant consumables without double-counting find and handover steps", () => {
    const [normalized] = normalizeTarkovDevTasks({
      data: {
        tasks: {
          "installation-task": {
            id: "installation-task",
            name: "installation-task name",
            trader: "mechanic-id",
            objectives: [
              { id: "plant-camera-1", type: "plantItem", count: 1, items: ["camera-id"] },
              { id: "plant-camera-2", type: "plantItem", count: 1, items: ["camera-id"] },
              { id: "plant-camera-3", type: "plantItem", count: 1, items: ["camera-id"] },
              { id: "plant-camera-4", type: "plantItem", count: 1, items: ["camera-id"] },
              { id: "find-wire", type: "findItem", count: 2, items: ["wire-id"] },
              { id: "give-wire", type: "giveItem", count: 2, items: ["wire-id"] },
            ],
          },
        },
      },
      english: { "installation-task name": "Installation Task" },
      traders: [{ id: "mechanic-id", name: "Mechanic" }],
      itemIdByBsgId: new Map([
        ["camera-id", "camera-app-id"],
        ["wire-id", "wire-app-id"],
      ]),
      itemNamesByBsgId: new Map([
        ["camera-id", "WI-FI Camera"],
        ["wire-id", "Wire"],
      ]),
    });

    const result = toAppQuest(normalized);
    expect(result.requiredItems.find((item) => item.itemId === "camera-app-id"))
      .toMatchObject({ count: 4, requirementType: "Plant" });
    expect(result.requiredItems.find((item) => item.itemId === "wire-app-id"))
      .toMatchObject({ count: 2, requirementType: "Handover" });
  });

  it("keeps saved ids while following the wiki rename to A Big Loss", () => {
    const legacy = {
      ...baseQuest,
      id: "legacy-database-part-2",
      name: "Database - Part 2",
      nameEn: "Database - Part 2",
      nameKo: "데이터베이스 - 파트 2",
      normalizedName: "database---part-2",
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Database_-_Part_2",
    };
    const pack = { ...emptyPack, quests: [legacy] };
    const refreshed = mergeQuestSources(pack, { meta: { generated: "now", count: 0 }, quests: [] });

    expect(refreshed.quests[0]).toMatchObject({
      id: "legacy-database-part-2",
      name: "A Big Loss",
      nameEn: "A Big Loss",
      nameKo: "큰 손실",
      normalizedName: "a-big-loss",
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/A_Big_Loss",
    });
    expect(refreshed.quests[0].nameAliases).toContain("Database - Part 2");
  });

  it("keeps saved ids while following the wiki rename to Small Things, Big Help", () => {
    const legacy = {
      ...baseQuest,
      id: "legacy-blood-of-war-part-3",
      name: "The Blood of War - Part 3",
      nameEn: "The Blood of War - Part 3",
      nameKo: "전쟁의 피 - 파트 3",
      normalizedName: "the-blood-of-war---part-3",
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/The_Blood_of_War_-_Part_3",
    };
    const pack = { ...emptyPack, quests: [legacy] };
    const refreshed = mergeQuestSources(pack, { meta: { generated: "now", count: 0 }, quests: [] });

    expect(refreshed.quests[0]).toMatchObject({
      id: "legacy-blood-of-war-part-3",
      name: "Small Things, Big Help",
      nameEn: "Small Things, Big Help",
      nameKo: "작은 일, 큰 도움",
      normalizedName: "small-things-big-help",
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Small_Things,_Big_Help",
    });
    expect(refreshed.quests[0].nameAliases).toContain("The Blood of War - Part 3");
  });

  it("follows a current Fandom redirect while retaining the app's old name", () => {
    const legacy = {
      ...baseQuest,
      id: "legacy-gunsmith-part-1",
      name: "Gunsmith - Part 1",
      nameEn: "Gunsmith - Part 1",
      normalizedName: "gunsmith---part-1",
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Gunsmith_-_Part_1",
    };
    const refreshed = mergeQuestSources(
      { ...emptyPack, quests: [legacy] },
      { meta: { generated: "now", count: 0 }, quests: [] },
    );

    expect(refreshed.quests[0]).toMatchObject({
      id: "legacy-gunsmith-part-1",
      name: "Gunsmith - MP-133",
      nameEn: "Gunsmith - MP-133",
      normalizedName: "gunsmith-mp-133",
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Gunsmith_-_MP-133",
    });
    expect(refreshed.quests[0].nameAliases).toContain("Gunsmith - Part 1");
  });

  it("removes only confirmed missing Wiki links during a guide refresh", () => {
    const quests = [
      { id: "missing", wikiPageLink: "https://example.test/missing" },
      { id: "rate-limited", wikiPageLink: "https://example.test/rate-limited" },
    ];
    const refreshed = applyWikiGuideLinkErrors(quests, {
      entries: {
        missing: { error: "PAGE_NOT_FOUND" },
        "rate-limited": { error: "HTTP_429" },
      },
    });

    expect(refreshed[0]).not.toHaveProperty("wikiPageLink");
    expect(refreshed[1].wikiPageLink).toBe("https://example.test/rate-limited");
  });

  it("canonicalizes stale quest Wiki links and removes links with no current page", () => {
    const staleQuests = [
      {
        ...baseQuest,
        id: "legacy-bp-depot",
        name: "BP Depot",
        nameEn: "BP Depot",
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/BP_Depot",
      },
      {
        ...baseQuest,
        id: "legacy-gunsmith-5",
        name: "Gunsmith - Part 5",
        nameEn: "Gunsmith - Part 5",
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Gunsmith_-_Part_5",
      },
      {
        ...baseQuest,
        id: "legacy-new-day",
        name: "New Day, New Paths",
        nameEn: "New Day, New Paths",
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/New_Day%2C_New_Paths",
      },
      {
        ...baseQuest,
        id: "legacy-evil-watchman",
        name: "The Huntsman Path - Evil Watchman",
        nameEn: "The Huntsman Path - Evil Watchman",
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/The_Huntsman_Path_-_Evil_Watchman",
      },
      {
        ...baseQuest,
        id: "legacy-cargo-1",
        name: "Cargo X - Part 1",
        nameEn: "Cargo X - Part 1",
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Cargo_X_-_Part_1",
      },
      {
        ...baseQuest,
        id: "legacy-missing",
        name: "Painkiller",
        nameEn: "Painkiller",
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Painkiller",
      },
      {
        ...baseQuest,
        id: "tarkovdata-new-beginning",
        name: "Neuanfang",
        nameEn: "Neuanfang",
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Neuanfang",
      },
    ];
    const refreshed = mergeQuestSources(
      { ...emptyPack, quests: staleQuests },
      { meta: { generated: "now", count: 0 }, quests: [] },
    );
    const byId = new Map(refreshed.quests.map((quest) => [quest.id, quest]));

    expect(byId.get("legacy-bp-depot")).toMatchObject({
      nameEn: "Oil Run",
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Oil_Run",
    });
    expect(byId.get("legacy-gunsmith-5")).toMatchObject({
      nameEn: "Gunsmith - Model 870",
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Gunsmith_-_Model_870",
    });
    expect(byId.get("legacy-new-day")).toMatchObject({
      nameEn: "New Paths",
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/New_Paths",
    });
    expect(byId.get("legacy-evil-watchman")).toMatchObject({
      nameEn: "The Huntsman Path - Angry Watchman",
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/The_Huntsman_Path_-_Angry_Watchman",
    });
    expect(byId.get("legacy-cargo-1").wikiPageLink).toBe(
      "https://escapefromtarkov.fandom.com/wiki/Cargo_X",
    );
    expect(byId.get("legacy-missing").wikiPageLink).toBeUndefined();
    expect(byId.get("tarkovdata-new-beginning")).toMatchObject({
      nameEn: "New Beginning (Prestige 1)",
      wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/New_Beginning_(Prestige_1)",
    });
  });

  it("includes the current Wiki/live tasks that were missing from the bundled quest DB", () => {
    const packPath = path.resolve(process.cwd(), "public/data/tarkov-data.json");
    const pack = JSON.parse(readFileSync(packPath, "utf8"));
    const byBsgId = new Map(pack.quests.map((quest) => [quest.bsgId, quest]));
    const expected = [
      ["69c277f3ea6da9c23e07f8d2", "A Bitter Victory"],
      ["69ce1cfb298a6529b30d712b", "A Wedge Between Us"],
      ["69ce213a298a6529b30d7134", "Biochemistry"],
      ["6a5cd2178fd7c2b201032f3f", "Demonstration Model"],
      ["6a5424ae135497b9df0c68be", "Fall Ailment"],
      ["69ce21e990144e437802b1e0", "Fresh Stock"],
      ["69c2a2d004de49c8f0055a3d", "Hangover"],
      ["6a5c1578f2689567c30eb0f3", "Hiking"],
      ["69ce1de03e15cd80bd06f6c9", "Oil Change"],
      ["69ce1f84ebbdbf36a200627c", "Peaceful Atom"],
      ["6a5ccda873f06065630d61b0", "Secret Message"],
      ["68ee1c18b4e5bc9a68018cd7", "Special Order"],
      ["6a4532e48e82d8ffea0c3eae", "The Huntsman Path - Controller"],
      ["67a09673972c11a3f507731d", "The Tarkov Butcher"],
      ["69ce204c8702b378f9091e4b", "War Never Changes"],
      ["69e5583240c3e6c8ba0edbd5", "Wiring the Vessel"],
    ];

    for (const [bsgId, name] of expected) {
      const expectedQuest = byBsgId.get(bsgId);
      expect(expectedQuest).toMatchObject({
        name,
        nameEn: name,
      });
      expect(expectedQuest.wikiPageLink).toEqual(expect.stringContaining("fandom.com/wiki/"));
    }
  });

  it("creates safe app defaults for a remote quest without map locations", () => {
    const result = toAppQuest({
      id: "no-map",
      gameId: "no-map-id",
      name: "No Map Quest",
      trader: "Fence",
      map: null,
      minPlayerLevel: 1,
      kappa: false,
      objectives: [],
    });

    expect(result).toMatchObject({
      id: "tarkovdata-no-map",
      bsgId: "no-map-id",
      locations: [],
      requirements: [],
      alternativeQuestIds: [],
      followUpQuestIds: [],
      objectives: [],
      requiredItems: [],
    });
  });

  it("normalizes live task localization and map fields before app bundling", () => {
    const [result] = normalizeTarkovDevTasks({
      data: {
        tasks: {
          "live-task-id": {
            id: "live-task-id",
            name: "live-task-id name",
            trader: "trader-id",
            wikiLink: "https://escapefromtarkov.fandom.com/wiki/Live_Task",
            map: null,
            objectives: [{
              id: "live-objective-id",
              description: "live-objective-id",
              type: "mark",
              maps: ["woods"],
            }],
          },
        },
      },
      english: { "live-task-id name": "Live Task", "live-objective-id": "Mark the place" },
      korean: { "live-task-id name": "라이브 퀘스트", "live-objective-id": "장소 표시" },
      traders: [{ id: "trader-id", name: "Mechanic" }],
    });

    expect(result).toMatchObject({
      id: "live-task-id",
      gameId: "live-task-id",
      name: "Live Task",
      nameKo: "라이브 퀘스트",
      trader: "Mechanic",
      wiki: "https://escapefromtarkov.fandom.com/wiki/Live_Task",
      objectives: [{
        description: "Mark the place",
        descriptionKo: "장소 표시",
        locations: [{ map: "Woods" }],
      }],
    });
  });

  it("omits the live Any faction so common quests remain available to both factions", () => {
    const result = toAppQuest({
      id: "common-quest",
      gameId: "common-quest-id",
      name: "Common Quest",
      factionName: "Any",
      objectives: [],
    });

    expect(result).not.toHaveProperty("faction");
  });

  it("cleans trailing encoded whitespace from live Wiki links", () => {
    const [result] = normalizeTarkovDevTasks({
      data: {
        tasks: {
          "live-task-id": {
            id: "live-task-id",
            name: "live-task-id name",
            trader: "trader-id",
            wikiLink: "https://escapefromtarkov.fandom.com/wiki/Live_Task%0A",
            objectives: [],
          },
        },
      },
      english: { "live-task-id name": "Live Task" },
      korean: { "live-task-id name": "Live Task" },
      traders: [{ id: "trader-id", name: "Mechanic" }],
    });

    const appQuest = toAppQuest(result);
    expect(appQuest.wikiPageLink).toBe(
      "https://escapefromtarkov.fandom.com/wiki/Live_Task",
    );
    expect(appQuest).not.toHaveProperty("nameKo");
  });

  it("normalizes remote laboratory aliases to the bundled map key", () => {
    const result = toAppQuest({
      id: "lab-quest",
      gameId: "lab-id",
      name: "Lab Quest",
      trader: "Ragman",
      map: "the-lab",
      kappa: false,
      objectives: [],
    });

    expect(result.locations).toEqual(["TheLab"]);
  });

  it("assigns evidence-bound maps to known location objectives with missing source maps", () => {
    const vitamins = {
      ...baseQuest,
      id: "local-vitamins",
      bsgId: "5b478eca86f7744642012254",
      name: "Vitamins - Part 1",
      locations: ["Shoreline", "Interchange"],
      objectives: [
        { id: "EGAHYCvMa5BEU_0nItA_4Z", locationPoints: [{ x: 1, y: 0, z: 1 }] },
        { id: "vRBCUL9KyySlPdtxQs1X6u", locationPoints: [{ x: 2, y: 0, z: 2 }] },
        { id: "IUXs1ycQH6QCq2RDps-v4y", locationPoints: [{ x: 3, y: 0, z: 3 }] },
      ],
    };
    const huntingTrip = {
      ...baseQuest,
      id: "local-hunting-trip",
      bsgId: "5d25e4ca86f77409dd5cdf2c",
      name: "Hunting Trip",
      locations: [],
      objectives: [
        { id: "ZQMUlzXjyfbANPjmdvAR-h", locationPoints: [{ x: 4, y: 0, z: 4 }] },
      ],
    };

    const refreshed = mergeQuestSources(
      { ...emptyPack, quests: [vitamins, huntingTrip] },
      { meta: { generated: "now", count: 0 }, quests: [] },
    );

    expect(refreshed.quests[0].objectives.map((objective) => objective.mapName))
      .toEqual(["Shoreline", "Interchange", "Interchange"]);
    expect(refreshed.quests[1].objectives[0].mapName).toBe("Woods");
  });

  it("uses upstream objective ids without guessing from objective descriptions", () => {
    const result = toAppQuest({
      id: "vitamins-part-1",
      gameId: "5b478eca86f7744642012254",
      name: "Vitamins - Part 1",
      trader: "Skier",
      map: null,
      objectives: [
        { id: "5b478f6886f774464201225a", description: "renamed upstream text" },
        { id: "5b4c826b86f7743cc87bcee4", description: "another renamed text" },
        { id: "5b4c82cd86f774170c6e4169", description: "third renamed text" },
      ],
    });
    const unrelated = toAppQuest({
      id: "unrelated",
      gameId: "different-quest",
      name: "Vitamins - Part 1",
      map: null,
      objectives: [
        { id: "5b478f6886f774464201225a", description: "on Shoreline" },
      ],
    });

    expect(result.objectives.map((objective) => objective.mapName))
      .toEqual(["Shoreline", "Interchange", "Interchange"]);
    expect(unrelated.objectives[0]).not.toHaveProperty("mapName");
  });

  it("normalizes newly added quests to verified Wiki titles", () => {
    const quests = [
      {
        id: "tarkovdata-697877e0c639962b2e0cf24f",
        name: "Arena Business [PVP ZONE]",
        nameEn: "Arena Business [PVP ZONE]",
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Arena_Business_%5BPVP_ZONE%5D",
      },
      {
        id: "tarkovdata-6a5cd2178fd7c2b201032f3f",
        name: "Demonstration Model",
        nameEn: "Demonstration Model",
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Demonstration_Model",
      },
      {
        id: "tarkovdata-arena-pve",
        name: "Arena Business [PVE ZONE]",
        nameEn: "Arena Business [PVE ZONE]",
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Arena_Business_%5BPVE_ZONE%5D",
      },
      {
        id: "legacy-mall-cop",
        name: "Mall Cop",
        nameEn: "Mall Cop",
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Mall_Cop",
      },
      {
        id: "legacy-tickets-please",
        name: "Tickets, Please",
        nameEn: "Tickets, Please",
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Tickets%2C_Please",
      },
      {
        id: "tarkovdata-6a4532e48e82d8ffea0c3eae",
        name: "The Huntsman Path - Control",
        nameEn: "The Huntsman Path - Control",
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/The_Huntsman_Path_-_Control",
      },
      {
        id: "tarkovdata-6a5ccda873f06065630d61b0",
        name: "Secret Message",
        nameEn: "Secret Message",
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Secret_Message",
      },
      {
        id: "tarkovdata-6761ff17cdc36bd66102e9d0",
        name: "Neuanfang",
        nameEn: "Neuanfang",
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Neuanfang",
      },
    ];

    expect(applyWikiQuestRenames(quests)).toMatchObject([
      { wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Arena_Business" },
      { wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Demonstration_Model" },
      { wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Arena_Business" },
      { wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Gendarmerie_-_Mall_Cop" },
      { wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Gendarmerie_-_Tickets%2C_Please" },
      {
        name: "The Huntsman Path - Controller",
        nameAliases: ["The Huntsman Path - Control"],
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/The_Huntsman_Path_-_Controller",
      },
      { wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Secret_Message" },
      {
        name: "New Beginning (Prestige 2)",
        nameAliases: ["Neuanfang"],
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/New_Beginning_(Prestige_2)",
      },
    ]);
    expect(applyWikiQuestRenames([{
      id: "tarkovdata-697877e0c639962b2e0cf24f",
      name: "Arena Business [PVP ZONE]",
    }])[0].wikiPageLink).toBe(
      "https://escapefromtarkov.fandom.com/wiki/Arena_Business",
    );
  });
});
