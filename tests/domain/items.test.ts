import { describe, expect, it } from "vitest";

import type {
  HideoutStation,
  ItemData,
  QuestData,
} from "../../src/types/data";
import type { ProfileState } from "../../src/types/state";
import {
  aggregateCollectorItems,
  aggregateItemRequirements,
  evaluateItemFulfillment,
  filterAndSortItems,
  formatCountDisplay,
  formatOwnedDisplay,
  getAggregatedItemStatistics,
  getCollectorQuestChain,
  getParentCategory,
} from "../../src/domain/items";

function quest(id: string, overrides: Partial<QuestData> = {}): QuestData {
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
    ...overrides,
  };
}

function item(
  id: string,
  name: string,
  category: string,
  overrides: Partial<ItemData> = {},
): ItemData {
  return {
    id,
    name,
    nameEn: name,
    category,
    categories: [category],
    isDogtagItem: false,
    ...overrides,
  };
}

function profile(overrides: Partial<ProfileState> = {}): ProfileState {
  return {
    level: 60,
    scavRep: 6,
    dspDecodeCount: 0,
    hasEodEdition: true,
    hasUnheardEdition: true,
    prestigeLevel: 10,
    faction: "usec",
    questProgress: {},
    objectiveProgress: {},
    hideoutLevels: {},
    inventory: {},
    customMarkers: [],
    ...overrides,
  };
}

const bolt = item("bolt", "Bolts", "Building materials");
const wire = item("wire", "Wires", "Electronics");
const roubles = item("roubles-id", "Roubles", "Money");

function itemRequirement(
  id: string,
  itemId: string,
  itemName: string,
  count: number,
  requiresFir = false,
) {
  return {
    id,
    itemId,
    itemName,
    count,
    requiresFir,
    requirementType: "handover",
    sortOrder: 0,
  };
}

function hideoutStation(): HideoutStation {
  return {
    id: "workbench",
    name: "Workbench",
    normalizedName: "workbench",
    maxLevel: 3,
    levels: [
      {
        id: "level-1",
        level: 1,
        constructionTime: 0,
        items: [
          {
            id: "built-bolt",
            itemId: "bolt",
            itemName: "Bolts",
            count: 99,
            foundInRaid: false,
            sortOrder: 0,
          },
        ],
        stations: [],
        traders: [],
        skills: [],
      },
      {
        id: "level-2",
        level: 2,
        constructionTime: 0,
        items: [
          {
            id: "future-bolt",
            itemId: "bolt",
            itemName: "Bolts",
            count: 4,
            foundInRaid: false,
            sortOrder: 0,
          },
          {
            id: "future-roubles",
            itemId: "roubles-id",
            itemName: "Roubles",
            count: 500_000,
            foundInRaid: false,
            sortOrder: 1,
          },
        ],
        stations: [],
        traders: [],
        skills: [],
      },
    ],
  };
}

describe("item and hideout aggregation", () => {
  it("merges unfinished quest and future hideout needs, tracks FIR, and counts currencies by reference", () => {
    const active = quest("active", {
      requiredItems: [
        itemRequirement("q-bolt", "bolt", "Bolts", 2, true),
        itemRequirement("q-wire", "wire", "Wires", 3),
        itemRequirement("q-money", "roubles-id", "Roubles", 250_000),
      ],
    });
    const done = quest("done", {
      requiredItems: [itemRequirement("done-bolt", "bolt", "Bolts", 50)],
    });
    const failed = quest("failed", {
      requiredItems: [itemRequirement("failed-bolt", "bolt", "Bolts", 50)],
    });
    const state = profile({
      questProgress: { done: "done", failed: "failed" },
      hideoutLevels: { workbench: 1 },
      inventory: {
        bolt: { fir: 1, nonFir: 4 },
        wire: { fir: 0, nonFir: 3 },
      },
    });

    const result = aggregateItemRequirements(
      [active, done, failed],
      [hideoutStation()],
      [bolt, wire, roubles],
      state,
    );

    expect(result).toHaveLength(3);
    const bolts = result.find((entry) => entry.itemId === "bolt");
    expect(bolts).toMatchObject({
      displayName: "Bolts",
      parentCategory: "Barter",
      questCount: 2,
      questFirCount: 2,
      hideoutCount: 4,
      totalCount: 6,
      totalFirCount: 2,
      ownedFir: 1,
      ownedNonFir: 4,
      fulfillmentStatus: "partiallyFulfilled",
      progressPercent: 50,
      shortage: 1,
      firShortage: 1,
    });
    expect(bolts?.questSources).toEqual([
      expect.objectContaining({ questId: "active", requiredCount: 2 }),
    ]);
    expect(bolts?.hideoutSources).toEqual([
      expect.objectContaining({ stationId: "workbench", level: 2, requiredCount: 4 }),
    ]);
    expect(result.find((entry) => entry.itemId === "wire")).toMatchObject({
      questCount: 3,
      hideoutCount: 0,
      fulfillmentStatus: "fulfilled",
    });
    expect(result.find((entry) => entry.itemId === "roubles-id")).toMatchObject({
      questCount: 1,
      hideoutCount: 1,
      totalCount: 2,
    });
  });

  it("requires FIR inventory for FIR needs and total inventory otherwise", () => {
    expect(
      evaluateItemFulfillment(6, 2, { fir: 1, nonFir: 10 }),
    ).toEqual({
      status: "partiallyFulfilled",
      progressPercent: 50,
      isFulfilled: false,
    });
    expect(evaluateItemFulfillment(6, 2, { fir: 2, nonFir: 4 })).toEqual({
      status: "fulfilled",
      progressPercent: 100,
      isFulfilled: true,
    });
    const mixedShort = evaluateItemFulfillment(6, 2, { fir: 2, nonFir: 0 });
    expect(mixedShort).toMatchObject({
      status: "partiallyFulfilled",
      isFulfilled: false,
    });
    expect(mixedShort.progressPercent).toBeCloseTo(100 / 3);
    expect(evaluateItemFulfillment(3, 0, { fir: 1, nonFir: 2 })).toEqual({
      status: "fulfilled",
      progressPercent: 100,
      isFulfilled: true,
    });
  });

  it("reports an FIR shortage even when general inventory covers the total count", () => {
    const mixed = quest("mixed", {
      requiredItems: [
        itemRequirement("mixed-fir", "bolt", "Bolts", 2, true),
        itemRequirement("mixed-general", "bolt", "Bolts", 4),
      ],
    });
    const result = aggregateItemRequirements(
      [mixed],
      [],
      [bolt],
      profile({ inventory: { bolt: { fir: 0, nonFir: 6 } } }),
    );

    expect(result[0]).toMatchObject({
      totalCount: 6,
      totalFirCount: 2,
      shortage: 2,
      firShortage: 2,
      isFulfilled: false,
    });
    expect(getAggregatedItemStatistics(result)).toMatchObject({
      totalShortage: 2,
      shortageItemCount: 1,
    });
  });
});

describe("collector prerequisite chain", () => {
  it("recursively includes unfinished prerequisites and excludes terminal/unavailable quests", () => {
    const first = quest("first", {
      requiredItems: [itemRequirement("first-bolt", "bolt", "Bolts", 2)],
    });
    const second = quest("second", {
      requirements: [
        { questId: "first", requirementType: "complete", groupId: 0 },
      ],
      requiredItems: [itemRequirement("second-wire", "wire", "Wires", 3, true)],
    });
    const collector = quest("collector-id", {
      normalizedName: "collector",
      requirements: [
        { questId: "second", requirementType: "complete", groupId: 0 },
      ],
      requiredItems: [itemRequirement("collector-bolt", "bolt", "Bolts", 1, true)],
    });
    const quests = [first, second, collector];
    const state = profile({ questProgress: { first: "done" } });

    expect(getCollectorQuestChain(quests, state, true).map((task) => task.id)).toEqual([
      "collector-id",
      "second",
    ]);
    expect(getCollectorQuestChain(quests, state, false).map((task) => task.id)).toEqual([
      "collector-id",
    ]);

    const aggregated = aggregateCollectorItems(quests, [bolt, wire], state, true);
    expect(aggregated.map((entry) => entry.itemId).sort()).toEqual(["bolt", "wire"]);
    expect(aggregated.find((entry) => entry.itemId === "bolt")).toMatchObject({
      questCount: 1,
      questFirCount: 1,
    });
    expect(aggregated.find((entry) => entry.itemId === "wire")).toMatchObject({
      questCount: 3,
      questFirCount: 3,
    });
  });

  it("is cycle-safe when malformed data points back to Collector", () => {
    const collector = quest("collector", {
      requirements: [
        { questId: "loop", requirementType: "complete", groupId: 0 },
      ],
    });
    const loop = quest("loop", {
      requirements: [
        { questId: "collector", requirementType: "complete", groupId: 0 },
      ],
    });

    expect(getCollectorQuestChain([collector, loop], profile(), true)).toHaveLength(2);
  });
});

describe("item display and filtering helpers", () => {
  it("maps parent categories and formats FIR/owned count labels", () => {
    expect(getParentCategory("Food|Packaged")).toBe("Provisions");
    expect(getParentCategory("Custom category")).toBe("Custom category");
    expect(getParentCategory(undefined)).toBe("Other");
    expect(formatCountDisplay(7, 0)).toBe("7");
    expect(formatCountDisplay(7, 7)).toBe("7 (FIR)");
    expect(formatCountDisplay(7, 2)).toBe("2F+5");
    expect(formatOwnedDisplay({ fir: 2, nonFir: 3 })).toBe("2F+3");
  });

  it("combines search/source/category/FIR/fulfillment filters and source sorting", () => {
    const state = profile({
      inventory: {
        bolt: { fir: 0, nonFir: 0 },
        wire: { fir: 3, nonFir: 0 },
      },
    });
    const q = quest("q", {
      requiredItems: [
        itemRequirement("bolt", "bolt", "Bolts", 2),
        itemRequirement("wire", "wire", "Wires", 3, true),
      ],
    });
    const entries = aggregateItemRequirements([q], [], [bolt, wire], state);

    expect(
      filterAndSortItems(entries, {
        searchText: "wire",
        source: "quest",
        category: "Barter",
        fulfillment: "fulfilled",
        firOnly: true,
        hideFulfilled: false,
        sortBy: "quest",
      }).map((entry) => entry.itemId),
    ).toEqual(["wire"]);
    expect(
      filterAndSortItems(entries, {
        hideFulfilled: true,
        sortBy: "name",
      }).map((entry) => entry.itemId),
    ).toEqual(["bolt"]);
  });
});
