import { describe, expect, it } from "vitest";

import { summarizeBuildPrice } from "../../src/features/modding/build-price-summary";
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
      knownTotalRoubles: 16_000,
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
    expect(summary.strategies.flea.weapon.totalRoubles).toBe(9_000);
    expect(summary.strategies.flea.fleaMinimumPlayerLevel).toBe(25);
  });
});
