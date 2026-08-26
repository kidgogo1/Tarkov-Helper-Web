import { describe, expect, it } from "vitest";

import {
  DEFAULT_PART_CANDIDATE_FILTERS,
  filterAndSortPartCandidates,
  getBestTraderOffer,
  moveCandidateSort,
  type PartCandidateRecord,
} from "../../src/features/modding/part-candidate-controls";
import type { WeaponPartItem } from "../../src/types/weapon-modding";

function part(
  id: string,
  name: string,
  overrides: Partial<WeaponPartItem> = {},
): WeaponPartItem {
  return {
    categories: ["Sights"],
    id,
    kind: "part",
    name,
    shortName: id.toUpperCase(),
    ...overrides,
  };
}

const candidates: PartCandidateRecord[] = [
  {
    availability: "compatible",
    candidate: part("balanced", "Balanced sight", {
      nameKo: "균형 조준경",
      stats: {
        centerOfImpact: -0.001,
        ergonomics: 3,
        muzzleVelocityModifier: 2,
        recoilModifier: -6,
        weight: 0.42,
      },
      traderOffersByProfile: {
        pvp: [{
          currency: "RUB",
          loyaltyLevel: 2,
          price: 15_000,
          priceRoubles: 15_000,
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
        pvp: { currency: "RUB", price: 25_000, updatedAt: "2026-08-26" },
        pve: { currency: "RUB", price: 40_000, updatedAt: "2026-08-26" },
      },
    }),
    performanceDelta: {
      accuracy: -0.2,
      ergonomics: 3,
      recoil: -5,
      velocity: 2,
      weight: 0.42,
    },
  },
  {
    availability: "auto-resolvable",
    candidate: part("recoil", "Recoil-first sight", {
      stats: { ergonomics: -1, recoilModifier: -12, weight: 0.3 },
      traderOffersByProfile: {
        pvp: [{
          currency: "RUB",
          loyaltyLevel: 3,
          price: 10_000,
          priceRoubles: 10_000,
          questUnlock: { questId: "q-1", questName: "시험" },
          traderId: "peacekeeper",
          traderName: "Peacekeeper",
        }],
      },
      fleaByProfile: {
        pvp: { currency: "RUB", price: 30_000, updatedAt: "2026-08-26" },
      },
    }),
    performanceDelta: {
      ergonomics: -1,
      recoil: -10,
      weight: 0.3,
    },
  },
  {
    availability: "compatible",
    candidate: part("ergo", "Ergonomic sight", {
      stats: { ergonomics: 8, recoilModifier: -2, weight: 0.55 },
      traderOffersByProfile: {
        pvp: [{
          currency: "RUB",
          loyaltyLevel: 1,
          price: 10_000,
          priceRoubles: 10_000,
          traderId: "mechanic",
          traderName: "Mechanic",
        }],
      },
    }),
    performanceDelta: {
      ergonomics: 8,
      recoil: -2,
      weight: 0.55,
    },
  },
  {
    availability: "blocked",
    candidate: part("unpriced", "Unpriced sight", {
      stats: { ergonomics: 5, weight: 0.2 },
    }),
    performanceDelta: {},
  },
];

describe("part candidate controls", () => {
  it("combines availability, purchase, effect, trader, and price filters", () => {
    const result = filterAndSortPartCandidates(
      candidates,
      "pvp",
      {
        ...DEFAULT_PART_CANDIDATE_FILTERS,
        availability: "compatible",
        effectFilters: ["recoil", "ergonomics", "accuracy", "velocity"],
        maxFleaPrice: 30_000,
        maxTraderPrice: 20_000,
        purchaseFilters: ["trader", "flea"],
        query: "균형",
        traderId: "mechanic",
      },
      [],
    );

    expect(result.map(({ candidate }) => candidate.id)).toEqual(["balanced"]);
  });

  it("uses the active PvP/PvE market snapshot for filters", () => {
    const filters = {
      ...DEFAULT_PART_CANDIDATE_FILTERS,
      maxTraderPrice: 10_000,
      purchaseFilters: ["trader"] as const,
      query: "balanced",
    };

    expect(filterAndSortPartCandidates(candidates, "pvp", filters, []))
      .toHaveLength(0);
    expect(filterAndSortPartCandidates(candidates, "pve", filters, []))
      .toHaveLength(1);
  });

  it("applies trader, quest, and loyalty controls without requiring a source checkbox", () => {
    expect(filterAndSortPartCandidates(candidates, "pvp", {
      ...DEFAULT_PART_CANDIDATE_FILTERS,
      traderId: "mechanic",
    }, []).map(({ candidate }) => candidate.id)).toEqual(["balanced", "ergo"]);

    expect(filterAndSortPartCandidates(candidates, "pvp", {
      ...DEFAULT_PART_CANDIDATE_FILTERS,
      questRequirement: "required",
    }, []).map(({ candidate }) => candidate.id)).toEqual(["recoil"]);

    expect(filterAndSortPartCandidates(candidates, "pvp", {
      ...DEFAULT_PART_CANDIDATE_FILTERS,
      maxLoyaltyLevel: 1,
    }, []).map(({ candidate }) => candidate.id)).toEqual(["ergo"]);
  });

  it("still displays a legacy foreign-currency offer when no RUB conversion exists", () => {
    const legacyOffer = part("legacy", "Legacy sight", {
      traderOffers: [{
        currency: "USD",
        loyaltyLevel: 2,
        price: 75,
        traderId: "peacekeeper",
        traderName: "Peacekeeper",
      }],
    });

    expect(getBestTraderOffer(legacyOffer, "pvp")).toMatchObject({
      currency: "USD",
      price: 75,
    });
  });

  it("sorts by multiple enabled criteria in priority order and keeps missing prices last", () => {
    const traderFirst = filterAndSortPartCandidates(
      candidates,
      "pvp",
      DEFAULT_PART_CANDIDATE_FILTERS,
      ["trader-price", "ergonomics"],
    );
    const ergonomicsFirst = filterAndSortPartCandidates(
      candidates,
      "pvp",
      DEFAULT_PART_CANDIDATE_FILTERS,
      ["ergonomics", "trader-price"],
    );

    expect(traderFirst.map(({ candidate }) => candidate.id)).toEqual([
      "ergo",
      "recoil",
      "balanced",
      "unpriced",
    ]);
    expect(ergonomicsFirst.map(({ candidate }) => candidate.id)).toEqual([
      "ergo",
      "balanced",
      "recoil",
      "unpriced",
    ]);
  });

  it("sorts trader loyalty by the lowest eligible LL instead of the cheapest offer LL", () => {
    const mixedLoyalty: PartCandidateRecord = {
      availability: "compatible",
      candidate: part("mixed-loyalty", "Mixed loyalty sight", {
        traderOffersByProfile: {
          pvp: [{
            currency: "RUB",
            loyaltyLevel: 1,
            price: 50_000,
            priceRoubles: 50_000,
            traderId: "mechanic",
            traderName: "Mechanic",
          }, {
            currency: "RUB",
            loyaltyLevel: 4,
            price: 1_000,
            priceRoubles: 1_000,
            traderId: "peacekeeper",
            traderName: "Peacekeeper",
          }],
        },
      }),
      performanceDelta: {},
    };
    const levelTwoOnly: PartCandidateRecord = {
      availability: "compatible",
      candidate: part("level-two", "Level two sight", {
        traderOffersByProfile: {
          pvp: [{
            currency: "RUB",
            loyaltyLevel: 2,
            price: 2_000,
            priceRoubles: 2_000,
            traderId: "mechanic",
            traderName: "Mechanic",
          }],
        },
      }),
      performanceDelta: {},
    };

    expect(filterAndSortPartCandidates(
      [levelTwoOnly, mixedLoyalty],
      "pvp",
      DEFAULT_PART_CANDIDATE_FILTERS,
      ["loyalty-level"],
    ).map(({ candidate }) => candidate.id)).toEqual(["mixed-loyalty", "level-two"]);
  });

  it("moves one enabled sort without dropping the other priorities", () => {
    expect(moveCandidateSort(
      ["trader-price", "recoil", "ergonomics"],
      "ergonomics",
      -1,
    )).toEqual(["trader-price", "ergonomics", "recoil"]);
    expect(moveCandidateSort(
      ["trader-price", "recoil", "ergonomics"],
      "trader-price",
      -1,
    )).toEqual(["trader-price", "recoil", "ergonomics"]);
  });
});
