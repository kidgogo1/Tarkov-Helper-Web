import { describe, expect, it } from "vitest";

import { selectQuestCatalog } from "../../src/domain/quest-catalog";
import type { QuestData } from "../../src/types/data";

function quest(id: string): QuestData {
  return {
    id,
    normalizedName: id,
    name: id,
    nameEn: id,
    trader: "Prapor",
    locations: [],
    kappaRequired: false,
    requirements: [],
    alternativeQuestIds: [],
    followUpQuestIds: [],
    objectives: [],
    requiredItems: [],
  };
}

describe("selectQuestCatalog", () => {
  const regular = [quest("regular")];
  const pvpSeason = [quest("pvp-season")];
  const pve = [quest("pve")];

  it("keeps the PVP profile on the regular catalog when a season catalog exists", () => {
    expect(selectQuestCatalog({
      quests: regular,
      questCatalogs: { pve, pvpSeason },
    }, "pvp")).toBe(regular);
  });

  it("selects the PVE catalog for the PVE profile", () => {
    expect(selectQuestCatalog({
      quests: regular,
      questCatalogs: { pve, pvpSeason },
    }, "pve")).toBe(pve);
  });

  it.each(["pvp", "pve"] as const)(
    "falls back to the legacy quests array for an old %s bundle",
    (profile) => {
      expect(selectQuestCatalog({ quests: regular }, profile)).toBe(regular);
    },
  );
});
