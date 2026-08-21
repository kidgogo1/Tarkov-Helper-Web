import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  extractWikiQuestMeta,
  applyWikiGuideLinkErrors,
  applyWikiQuestRenames,
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
      tarkovDataQuestCount: 501,
      liveTaskCount: 517,
      wikiQuestCount: 514,
      refreshMode: "preserve-local-enriched-append-tarkovdata",
      wikiRewardQuestCount: 441,
      wikiRewardItemCount: 713,
    });
  });

  it("bundles explicit maps for the corrected Vitamins and Hunting Trip objectives", () => {
    const packPath = path.resolve(process.cwd(), "public/data/tarkov-data.json");
    const pack = JSON.parse(readFileSync(packPath, "utf8"));
    const vitamins = pack.quests.find((quest) => quest.bsgId === "5b478eca86f7744642012254");
    const huntingTrip = pack.quests.find((quest) => quest.bsgId === "5d25e4ca86f77409dd5cdf2c");

    expect(vitamins.objectives
      .filter((objective) => objective.locationPoints.length > 0)
      .map((objective) => objective.mapName))
      .toEqual(["Shoreline", "Interchange", "Interchange"]);
    expect(huntingTrip.objectives[0].mapName).toBe("Woods");
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

  it("preserves enriched local records and appends unmatched remote quests", () => {
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
    expect(refreshed.quests[0]).toEqual(baseQuest);
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

  it("preserves enriched ids and fields when a live task is refreshed", () => {
    const enriched = {
      ...baseQuest,
      id: "tarkovdata-saved-quest",
      bsgId: "same-id",
      locations: ["Lighthouse"],
      rewardXp: 12345,
      objectives: [{
        id: "remote-objective",
        mapName: "Lighthouse",
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
      locations: ["Lighthouse"],
      rewardXp: 12345,
    });
    expect(refreshed.quests[0].objectives[0]).toMatchObject({
      id: "remote-objective",
      description: "Updated objective",
      mapName: "Lighthouse",
      locationPoints: [{ x: 1, y: 2, z: 3 }],
    });
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
      if (bsgId === "6a5ccda873f06065630d61b0") {
        expect(expectedQuest).not.toHaveProperty("wikiPageLink");
      } else {
        expect(expectedQuest.wikiPageLink).toEqual(expect.stringContaining("fandom.com/wiki/"));
      }
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
      { wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Demonstration_model" },
      {
        name: "The Huntsman Path - Controller",
        nameAliases: ["The Huntsman Path - Control"],
        wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/The_Huntsman_Path_-_Controller",
      },
      { wikiPageLink: undefined },
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
