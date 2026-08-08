import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  extractWikiQuestMeta,
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

    expect(pack.meta.counts.quests).toBe(501);
    expect(pack.quests).toHaveLength(501);
    expect(pack.meta.sources).toMatchObject({
      tarkovDataQuestCount: 501,
      wikiQuestCount: 516,
      refreshMode: "preserve-local-enriched-append-tarkovdata",
    });
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
      wikiQuestCount: 516,
      wikiRevisionTimestamp: "2026-08-07T14:28:05Z",
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
      wikiQuestCount: 516,
    });

    const repeated = mergeQuestSources(refreshed, remote, {
      wikiQuestCount: 516,
      wikiRevisionTimestamp: "2026-08-07T14:28:05Z",
    });
    expect(repeated.meta.sources.localExportedAt).toBe("2026-05-06T18:03:23Z");
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
});
