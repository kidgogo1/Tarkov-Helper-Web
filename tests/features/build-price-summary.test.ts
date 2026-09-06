import { describe, expect, it } from "vitest";

import { summarizeBuildPrice } from "../../src/features/modding/build-price-summary";
import { createFactoryBuild } from "../../src/domain/weapon-build";
import type {
  WeaponBuild,
  WeaponCatalog,
  WeaponPartItem,
} from "../../src/types/weapon-modding";

function part(
  id: string,
  overrides: Partial<WeaponPartItem> = {},
): WeaponPartItem {
  return {
    categories: ["Parts"],
    id,
    kind: "part",
    name: id,
    ...overrides,
  };
}

const catalog: WeaponCatalog = {
  schemaVersion: 1,
  dataVersion: "2026-08-26",
  weaponIds: ["weapon"],
  items: [
    {
      baseStats: {
        ergonomics: 50,
        horizontalRecoil: 160,
        verticalRecoil: 80,
        weight: 3,
      },
      categories: ["Assault rifles"],
      factoryPartIds: [],
      id: "weapon",
      kind: "weapon",
      name: "Test rifle",
      slots: [],
      factoryTraderOffersByProfile: {
        pvp: [{
          currency: "RUB", loyaltyLevel: 2, price: 10_000, priceRoubles: 10_000,
          traderId: "mechanic", traderName: "Mechanic",
        }],
        pve: [{
          currency: "RUB", loyaltyLevel: 1, price: 8_000, priceRoubles: 8_000,
          traderId: "mechanic", traderName: "Mechanic",
        }],
      },
      traderOffersByProfile: {
        pvp: [{
          currency: "RUB",
          loyaltyLevel: 2,
          price: 10_000,
          priceRoubles: 10_000,
          traderId: "mechanic",
          traderName: "Mechanic",
        }],
        pve: [{
          currency: "RUB",
          loyaltyLevel: 1,
          price: 8_000,
          priceRoubles: 8_000,
          traderId: "mechanic",
          traderName: "Mechanic",
        }],
      },
      fleaByProfile: {
        pvp: {
          currency: "RUB",
          minimumPlayerLevel: 15,
          price: 12_000,
          updatedAt: "2026-08-26T00:00:00Z",
        },
        pve: {
          currency: "RUB",
          minimumPlayerLevel: 25,
          price: 9_000,
          updatedAt: "2026-08-26T00:00:00Z",
        },
      },
    },
    part("optic", {
      traderOffersByProfile: {
        pvp: [{
          currency: "RUB",
          loyaltyLevel: 3,
          price: 5_000,
          priceRoubles: 5_000,
          questUnlock: {
            minimumPlayerLevel: 12,
            questId: "quest-optic",
            questName: "Optic quest",
          },
          traderId: "peacekeeper",
          traderName: "Peacekeeper",
        }],
      },
      fleaByProfile: {
        pvp: {
          currency: "RUB",
          minimumPlayerLevel: 15,
          price: 4_000,
          updatedAt: "2026-08-26T00:00:00Z",
        },
      },
    }),
    part("rail", {
      traderOffersByProfile: {
        pvp: [{
          currency: "RUB",
          loyaltyLevel: 1,
          price: 2_000,
          priceRoubles: 2_000,
          traderId: "skier",
          traderName: "Skier",
        }],
      },
    }),
  ],
};

const build: WeaponBuild = {
  catalogDataVersion: catalog.dataVersion,
  root: {
    children: [{
      children: [],
      instanceId: "root/optic",
      itemId: "optic",
      slotId: "optic-slot",
    }, {
      children: [],
      instanceId: "root/rail-left",
      itemId: "rail",
      slotId: "rail-left",
    }, {
      children: [],
      instanceId: "root/rail-right",
      itemId: "rail",
      slotId: "rail-right",
    }],
    instanceId: "root",
    itemId: "weapon",
  },
  schemaVersion: 1,
  weaponId: "weapon",
};

describe("build price summary", () => {
  it("does not charge included factory parts or substitute a receiver offer for a complete gun", () => {
    const factoryCatalog: WeaponCatalog = {
      ...catalog,
      items: catalog.items.map((item) => item.kind === "weapon" ? {
        ...item,
        slots: [{ id: "optic-slot", name: "Optic", allowedItemIds: ["optic"] }],
        factoryPresetBuild: [{ itemId: "optic", slotId: "optic-slot", children: [] }],
        factoryTraderOffersByProfile: { pvp: [{
          currency: "RUB", loyaltyLevel: 2, price: 30_000, priceRoubles: 30_000,
          traderId: "skier", traderName: "Skier",
        }] },
      } : item),
    };

    const summary = summarizeBuildPrice(factoryCatalog, createFactoryBuild(factoryCatalog, "weapon"), "pvp");

    expect(summary).toMatchObject({
      partCount: 1, includedPartCount: 1, additionalPartCount: 0, removedFactoryPartCount: 0,
    });
    for (const strategy of Object.values(summary.strategies)) {
      expect(strategy.parts).toMatchObject({ itemCount: 0, totalRoubles: 0, missingItemCount: 0 });
      expect(strategy.weapon.totalRoubles).toBe(30_000);
      expect(strategy.total.totalRoubles).toBe(30_000);
      expect(strategy.traderRequirements).toEqual([{ loyaltyLevel: 2, traderId: "skier", traderName: "Skier" }]);
      expect(strategy.questUnlocks).toEqual([]);
      expect(strategy.purchaseLines).toEqual([]);
    }
  });

  it("charges only duplicate quantities beyond the factory supply, even after moving slots", () => {
    const factoryCatalog: WeaponCatalog = {
      ...catalog,
      items: catalog.items.map((item) => item.kind === "weapon" ? {
        ...item,
        slots: ["left", "right", "top"].map((id) => ({ id, name: id, allowedItemIds: ["rail"] })),
        factoryPresetBuild: ["left", "right"].map((slotId) => ({ itemId: "rail", slotId, children: [] })),
      } : item),
    };
    const factory = createFactoryBuild(factoryCatalog, "weapon");
    const changed: WeaponBuild = {
      ...factory,
      root: { ...factory.root, children: ["top", "right", "left"].map((slotId) => ({
        itemId: "rail", slotId, instanceId: `moved/${slotId}`, children: [],
      })) },
    };

    const summary = summarizeBuildPrice(factoryCatalog, changed, "pvp");

    expect(summary).toMatchObject({ partCount: 3, includedPartCount: 2, additionalPartCount: 1, removedFactoryPartCount: 0 });
    expect(summary.strategies.trader.parts.totalRoubles).toBe(2_000);
    expect(summary.strategies.trader.purchaseLines).toMatchObject([{ itemId: "rail", quantity: 1, priceRoubles: 2_000 }]);

    const removed = summarizeBuildPrice(factoryCatalog, {
      ...changed, root: { ...changed.root, children: changed.root.children.slice(0, 1) },
    }, "pvp");
    expect(removed).toMatchObject({ includedPartCount: 1, additionalPartCount: 0, removedFactoryPartCount: 1 });
    expect(removed.strategies.trader.total.totalRoubles).toBe(10_000);
  });

  it("reuses nested factory parts on a replacement parent but does not give its new children for free", () => {
    const oldMount = part("old-mount", {
      slots: [{ id: "optic", name: "Optic", allowedItemIds: ["optic"] }],
    });
    const newMount = part("new-mount", {
      factoryPartIds: ["rail"],
      slots: [
        { id: "optic", name: "Optic", allowedItemIds: ["optic"] },
        { id: "rail", name: "Rail", allowedItemIds: ["rail"] },
      ],
      traderOffers: [{ currency: "RUB", loyaltyLevel: 1, price: 3_000, traderId: "skier", traderName: "Skier" }],
    });
    const nestedCatalog: WeaponCatalog = {
      ...catalog,
      items: [...catalog.items.map((item) => item.kind === "weapon" ? {
        ...item,
        slots: [{ id: "mount", name: "Mount", allowedItemIds: [oldMount.id, newMount.id] }],
        factoryPresetBuild: [{ itemId: oldMount.id, slotId: "mount", children: [
          { itemId: "optic", slotId: "optic", children: [] },
        ] }],
      } : item), oldMount, newMount],
    };
    const factory = createFactoryBuild(nestedCatalog, "weapon");
    const changed: WeaponBuild = {
      ...factory,
      root: { ...factory.root, children: [{
        itemId: newMount.id, slotId: "mount", instanceId: "new-mount-instance",
        children: ["optic", "rail"].map((itemId) => ({ itemId, slotId: itemId, instanceId: `new/${itemId}`, children: [] })),
      }] },
    };

    const summary = summarizeBuildPrice(nestedCatalog, changed, "pvp");

    expect(summary).toMatchObject({ includedPartCount: 1, additionalPartCount: 2, removedFactoryPartCount: 1 });
    expect(summary.strategies.trader.parts.totalRoubles).toBe(5_000);
    expect(summary.strategies.trader.parts.questUnlocks).toEqual([]);
    expect(summary.strategies.trader.purchaseLines.map((line) => line.itemId)).toEqual([newMount.id, "rail"]);
  });

  it("does not require individual prices or unlocks for included factory parts", () => {
    const unpricedCatalog: WeaponCatalog = {
      ...catalog,
      items: catalog.items.map((item) => item.kind === "weapon" ? {
        ...item,
        slots: [{ id: "rail", name: "Rail", allowedItemIds: ["rail"] }],
        factoryPresetBuild: [{ itemId: "rail", slotId: "rail", children: [] }],
      } : item.id === "rail" ? { ...item, traderOffersByProfile: {}, fleaByProfile: {} } : item),
    };

    const summary = summarizeBuildPrice(unpricedCatalog, createFactoryBuild(unpricedCatalog, "weapon"), "pvp");

    for (const strategy of Object.values(summary.strategies)) {
      expect(strategy.parts).toMatchObject({ totalRoubles: 0, missingItemCount: 0, traderRequirements: [], questUnlocks: [] });
    }
  });

  it("keeps an unknown complete gun price unknown despite known receiver and flea prices", () => {
    const noPresetPrices: WeaponCatalog = {
      ...catalog,
      items: catalog.items.map((item) => item.kind === "weapon" ? { ...item, factoryTraderOffersByProfile: undefined } : item),
    };
    const summary = summarizeBuildPrice(noPresetPrices, build, "pvp");

    expect(summary.weaponReferences.receiverTrader.totalRoubles).toBe(10_000);
    expect(summary.weaponReferences.flea.totalRoubles).toBe(12_000);
    for (const strategy of Object.values(summary.strategies)) {
      expect(strategy.weapon).toMatchObject({ itemCount: 1, missingItemCount: 1, totalRoubles: null });
      expect(strategy.total.totalRoubles).toBeNull();
    }
  });

  it("excludes the base gun purchase and its trader requirements when the factory gun is owned", () => {
    const summary = summarizeBuildPrice(catalog, build, "pvp", "owned");

    expect(summary.purchaseMode).toBe("owned");
    expect(summary.strategies.cheapest.weapon).toMatchObject({ itemCount: 0, totalRoubles: 0, missingItemCount: 0 });
    expect(summary.strategies.cheapest.total.totalRoubles).toBe(8_000);
    expect(summary.strategies.cheapest.traderRequirements).toEqual([{ loyaltyLevel: 1, traderId: "skier", traderName: "Skier" }]);
    expect(summary.strategies.cheapest.purchaseLines).toMatchObject([
      { itemId: "optic", quantity: 1, source: "flea", priceRoubles: 4_000 },
      { itemId: "rail", quantity: 2, source: "trader", priceRoubles: 2_000 },
    ]);
    expect(summary.strategies.flea.purchaseLines[1]).toMatchObject({ itemId: "rail", quantity: 2, source: "missing" });
    expect(summary.strategies.flea.purchaseLines[1].priceRoubles).toBeUndefined();
  });

  it("separates the weapon and repeated parts for trader, flea, and cheapest plans", () => {
    const summary = summarizeBuildPrice(catalog, build, "pvp");

    expect(summary.itemCount).toBe(4);
    expect(summary.partCount).toBe(3);
    expect(summary.strategies.trader.weapon).toMatchObject({
      knownTotalRoubles: 10_000,
      missingItemCount: 0,
      totalRoubles: 10_000,
    });
    expect(summary.strategies.trader.parts).toMatchObject({
      knownTotalRoubles: 9_000,
      missingItemCount: 0,
      pricedItemCount: 3,
      totalRoubles: 9_000,
    });
    expect(summary.strategies.trader.total.totalRoubles).toBe(19_000);
    expect(summary.strategies.trader.traderRequirements).toEqual([
      { loyaltyLevel: 2, traderId: "mechanic", traderName: "Mechanic" },
      { loyaltyLevel: 3, traderId: "peacekeeper", traderName: "Peacekeeper" },
      { loyaltyLevel: 1, traderId: "skier", traderName: "Skier" },
    ]);
    expect(summary.strategies.trader.questUnlocks).toEqual([{
      minimumPlayerLevel: 12,
      questId: "quest-optic",
      questName: "Optic quest",
      traderId: "peacekeeper",
      traderName: "Peacekeeper",
    }]);

    expect(summary.strategies.flea.parts).toMatchObject({
      knownTotalRoubles: 4_000,
      missingItemCount: 2,
      pricedItemCount: 1,
      totalRoubles: null,
    });
    expect(summary.strategies.flea.total).toMatchObject({
      knownTotalRoubles: 14_000,
      missingItemCount: 2,
      totalRoubles: null,
    });
    expect(summary.strategies.flea.fleaMinimumPlayerLevel).toBe(15);

    expect(summary.strategies.cheapest.weapon.totalRoubles).toBe(10_000);
    expect(summary.strategies.cheapest.parts.totalRoubles).toBe(8_000);
    expect(summary.strategies.cheapest.total.totalRoubles).toBe(18_000);
    expect(summary.strategies.cheapest.sourceCounts).toEqual({ flea: 1, trader: 3 });
    expect(summary.strategies.cheapest.traderRequirements).toEqual([
      { loyaltyLevel: 2, traderId: "mechanic", traderName: "Mechanic" },
      { loyaltyLevel: 1, traderId: "skier", traderName: "Skier" },
    ]);
    expect(summary.strategies.cheapest.questUnlocks).toEqual([]);
  });

  it("uses only the active profile and leaves unconvertible or unknown prices incomplete", () => {
    const legacyCatalog: WeaponCatalog = {
      ...catalog,
      items: [
        catalog.items[0],
        part("foreign-only", {
          traderOffers: [{
            currency: "USD",
            loyaltyLevel: 2,
            price: 75,
            traderId: "peacekeeper",
            traderName: "Peacekeeper",
          }],
        }),
      ],
    };
    const legacyBuild: WeaponBuild = {
      ...build,
      root: {
        ...build.root,
        children: [{
          children: [],
          instanceId: "root/foreign",
          itemId: "foreign-only",
          slotId: "foreign",
        }, {
          children: [],
          instanceId: "root/unknown",
          itemId: "unknown-item",
          slotId: "unknown",
        }],
      },
    };

    const summary = summarizeBuildPrice(legacyCatalog, legacyBuild, "pve");

    expect(summary.strategies.trader.weapon.totalRoubles).toBe(8_000);
    expect(summary.strategies.trader.parts).toMatchObject({
      knownTotalRoubles: 0,
      missingItemCount: 2,
      totalRoubles: null,
    });
    expect(summary.strategies.cheapest.total).toMatchObject({
      knownTotalRoubles: 8_000,
      missingItemCount: 2,
      totalRoubles: null,
    });
    expect(summary.strategies.flea.weapon.totalRoubles).toBe(8_000);
    expect(summary.strategies.flea.fleaMinimumPlayerLevel).toBeUndefined();
    expect(summary.weaponReferences.flea.totalRoubles).toBe(9_000);
    expect(summary.weaponReferences.flea.fleaMinimumPlayerLevel).toBe(25);
  });

  it("prefers flea on an exact price tie so the cheapest plan avoids an unnecessary trader level", () => {
    const tiedPart = part("tied-part", {
      fleaByProfile: {
        pvp: {
          currency: "RUB",
          minimumPlayerLevel: 15,
          price: 5_000,
          updatedAt: "2026-08-26T00:00:00Z",
        },
      },
      traderOffersByProfile: {
        pvp: [{
          currency: "RUB",
          loyaltyLevel: 4,
          price: 5_000,
          priceRoubles: 5_000,
          traderId: "mechanic",
          traderName: "Mechanic",
        }],
      },
    });
    const tiedCatalog: WeaponCatalog = {
      ...catalog,
      items: [catalog.items[0], tiedPart],
    };
    const tiedBuild: WeaponBuild = {
      ...build,
      root: {
        ...build.root,
        children: [{
          children: [],
          instanceId: "root/tied",
          itemId: tiedPart.id,
          slotId: "tied",
        }],
      },
    };

    const cheapestParts = summarizeBuildPrice(tiedCatalog, tiedBuild, "pvp")
      .strategies.cheapest.parts;

    expect(cheapestParts.totalRoubles).toBe(5_000);
    expect(cheapestParts.sourceCounts).toEqual({ flea: 1, trader: 0 });
    expect(cheapestParts.traderRequirements).toEqual([]);
    expect(cheapestParts.fleaMinimumPlayerLevel).toBe(15);
  });

  it("keeps only each trader's highest required level and deduplicates repeated unlock quests", () => {
    const traderPart = (id: string, loyaltyLevel: number) => part(id, {
      traderOffersByProfile: {
        pvp: [{
          currency: "RUB",
          loyaltyLevel,
          price: 2_000,
          priceRoubles: 2_000,
          questUnlock: {
            minimumPlayerLevel: 20,
            questId: "shared-quest",
            questName: "Shared unlock",
          },
          traderId: "mechanic",
          traderName: "Mechanic",
        }],
      },
    });
    const lowLevelPart = traderPart("low-level-part", 1);
    const highLevelPart = traderPart("high-level-part", 4);
    const requirementCatalog: WeaponCatalog = {
      ...catalog,
      items: [catalog.items[0], lowLevelPart, highLevelPart],
    };
    const requirementBuild: WeaponBuild = {
      ...build,
      root: {
        ...build.root,
        children: [lowLevelPart, highLevelPart].map((item, index) => ({
          children: [],
          instanceId: `root/requirement-${index}`,
          itemId: item.id,
          slotId: `requirement-${index}`,
        })),
      },
    };

    const traderParts = summarizeBuildPrice(requirementCatalog, requirementBuild, "pvp")
      .strategies.trader.parts;

    expect(traderParts.traderRequirements).toEqual([{
      loyaltyLevel: 4,
      traderId: "mechanic",
      traderName: "Mechanic",
    }]);
    expect(traderParts.questUnlocks).toEqual([{
      minimumPlayerLevel: 20,
      questId: "shared-quest",
      questName: "Shared unlock",
      traderId: "mechanic",
      traderName: "Mechanic",
    }]);
  });
});
