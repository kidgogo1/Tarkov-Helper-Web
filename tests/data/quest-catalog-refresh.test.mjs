import { describe, expect, it } from "vitest";

import {
  assembleQuestCatalogPack,
  createQuestCatalogSeed,
  questCatalogSourceUrls,
} from "../../scripts/quest-catalog-refresh.mjs";

function quest(id, bsgId, name = id) {
  return {
    id,
    ...(bsgId ? { bsgId } : {}),
    normalizedName: id,
    name,
    nameEn: name,
  };
}

describe("quest catalog refresh helpers", () => {
  it.each([
    ["regular", "regular"],
    ["pve", "pve"],
    ["pvpSeason", "pvp-season"],
  ])("builds %s source URLs", (mode, path) => {
    expect(questCatalogSourceUrls(mode)).toEqual({
      tasks: `https://json.tarkov.dev/${path}/tasks`,
      english: `https://json.tarkov.dev/${path}/tasks_en`,
      korean: `https://json.tarkov.dev/${path}/tasks_ko`,
      maps: `https://json.tarkov.dev/${path}/maps_en`,
    });
  });

  it("keeps only mode quests while retaining stable local IDs", () => {
    const regularPack = {
      quests: [
        quest("stable-shared", "bsg-shared", "Shared Quest"),
        quest("stable-name-only", undefined, "Name Matched Quest"),
        quest("regular-only", "bsg-regular", "Regular Only"),
      ],
      questCatalogs: { pve: [quest("stale", "stale")] },
    };
    const liveModeQuests = [
      { id: "bsg-shared", gameId: "bsg-shared", name: "Shared Quest" },
      { id: "bsg-name", gameId: "bsg-name", name: "Name Matched Quest" },
      { id: "bsg-new", gameId: "bsg-new", name: "New Quest" },
    ];

    const seed = createQuestCatalogSeed(regularPack, liveModeQuests);

    expect(seed).not.toHaveProperty("questCatalogs");
    expect(seed.quests).toEqual([
      expect.objectContaining({ id: "stable-shared", bsgId: "bsg-shared" }),
      expect.objectContaining({ id: "stable-name-only", bsgId: "bsg-name" }),
    ]);
  });

  it("does not collapse two current tasks onto one ambiguous legacy name", () => {
    const regularPack = {
      quests: [quest("legacy-make-amends", undefined, "Make Amends")],
    };
    const liveModeQuests = [
      { id: "usec", gameId: "usec", name: "Make Amends" },
      { id: "bear", gameId: "bear", name: "Make Amends" },
    ];

    expect(createQuestCatalogSeed(regularPack, liveModeQuests).quests).toEqual([]);
  });

  it("prefers a legacy primary name over another quest's historical alias", () => {
    const legacy = quest("legacy-battery", undefined, "Battery Change");
    const renamed = {
      ...quest("renamed", "different-bsg", "A Different Current Quest"),
      nameAliases: ["Battery Change"],
    };
    const liveModeQuests = [
      { id: "battery-bsg", gameId: "battery-bsg", name: "Battery Change" },
    ];

    expect(createQuestCatalogSeed({ quests: [legacy, renamed] }, liveModeQuests).quests)
      .toEqual([expect.objectContaining({ id: "legacy-battery", bsgId: "battery-bsg" })]);
  });

  it("keeps regular quests as the legacy list and attaches both mode catalogs", () => {
    const regular = { meta: { sources: {} }, quests: [quest("regular", "regular")] };
    const pve = { quests: [quest("pve", "pve")] };
    const pvpSeason = { quests: [quest("season", "season")] };

    const result = assembleQuestCatalogPack({ regular, pve, pvpSeason });

    expect(result.quests).toBe(regular.quests);
    expect(result.questCatalogs).toEqual({
      pve: pve.quests,
      pvpSeason: pvpSeason.quests,
    });
    expect(result.meta.sources.questCatalogCounts).toEqual({
      regular: 1,
      pve: 1,
      pvpSeason: 1,
    });
  });
});
