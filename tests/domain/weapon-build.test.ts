import { describe, expect, it } from "vitest";

import {
  calculateBuildStats,
  createFactoryBuild,
  flattenBuildTree,
  getCompatibleCandidates,
  getSlotCandidates,
  isCompatibleCandidate,
  removeBuildSlot,
  replaceBuildSlot,
  replaceBuildSlotResolvingConflicts,
  validateWeaponBuild,
} from "../../src/domain/weapon-build";
import type {
  BuildNode,
  WeaponCatalog,
  WeaponPartItem,
} from "../../src/types/weapon-modding";

const stats = {
  verticalRecoil: 100,
  horizontalRecoil: 200,
  ergonomics: 50,
  weight: 2,
  centerOfImpact: 0.01,
};

function part(
  id: string,
  categories: string[],
  overrides: Partial<WeaponPartItem> = {},
): WeaponPartItem {
  return {
    id,
    name: id,
    kind: "part",
    categories,
    ...overrides,
  };
}

function catalog(): WeaponCatalog {
  return {
    schemaVersion: 1,
    dataVersion: "2026-08-26",
    weaponIds: ["weapon"],
    items: [
      {
        id: "weapon",
        name: "Test rifle",
        kind: "weapon",
        categories: ["weapon"],
        baseStats: stats,
        factoryPartIds: ["receiver-a", "magazine"],
        slots: [
          {
            id: "receiver",
            name: "Receiver",
            required: true,
            allowedCategories: ["receiver"],
          },
          {
            id: "magazine",
            name: "Magazine",
            required: true,
            allowedCategories: ["magazine"],
            excludedItemIds: ["blocked-magazine"],
          },
        ],
      },
      part("receiver-a", ["receiver"], {
        factoryPartIds: ["mount"],
        stats: {
          recoilModifier: -10,
          ergonomics: -2,
          weight: 0.4,
          centerOfImpact: 0.053,
          muzzleVelocityModifier: 3,
        },
        slots: [
          {
            id: "optic-mount",
            name: "Optic mount",
            required: true,
            allowedCategories: ["mount"],
          },
        ],
      }),
      part("receiver-b", ["receiver"], {
        stats: { ergonomics: 3, weight: 0.3 },
      }),
      part("mount", ["mount"], {
        factoryPartIds: ["optic"],
        stats: { weight: 0.1 },
        slots: [
          {
            id: "optic",
            name: "Optic",
            allowedCategories: ["optic"],
          },
        ],
      }),
      part("optic", ["optic"], {
        stats: { ergonomics: -1, weight: 0.2 },
      }),
      part("magazine", ["magazine"], {
        stats: { ergonomics: -3, weight: 0.5 },
      }),
      part("blocked-magazine", ["magazine"]),
      part("drum", ["magazine"], {
        conflicts: { categories: ["optic"] },
      }),
      part("special-magazine", ["unrelated"], {
        conflicts: { itemIds: ["receiver-b"] },
      }),
      part("slot-conflict-magazine", ["magazine"], {
        conflicts: { slotIds: ["receiver"] },
      }),
      part("forbidden-category-magazine", ["banned-magazine"]),
    ],
  };
}

describe("weapon factory builds", () => {
  it("recursively places each factory part into a compatible parent slot", () => {
    const build = createFactoryBuild(catalog(), "weapon");

    expect(flattenBuildTree(build.root)).toEqual([
      expect.objectContaining({
        itemId: "weapon",
        parentInstanceId: null,
        slotId: null,
        depth: 0,
      }),
      expect.objectContaining({
        itemId: "receiver-a",
        parentInstanceId: build.root.instanceId,
        slotId: "receiver",
        depth: 1,
      }),
      expect.objectContaining({
        itemId: "mount",
        slotId: "optic-mount",
        depth: 2,
      }),
      expect.objectContaining({ itemId: "optic", slotId: "optic", depth: 3 }),
      expect.objectContaining({
        itemId: "magazine",
        parentInstanceId: build.root.instanceId,
        slotId: "magazine",
        depth: 1,
      }),
    ]);
    expect(new Set(flattenBuildTree(build.root).map((node) => node.instanceId)).size).toBe(5);
    expect(validateWeaponBuild(catalog(), build).isValid).toBe(true);
  });
});

describe("weapon slot compatibility", () => {
  it("allows listed item or category candidates and lets exclusions win", () => {
    const data = catalog();
    const build = createFactoryBuild(data, "weapon");
    const weapon = data.items.find((item) => item.id === "weapon");
    if (!weapon || weapon.kind !== "weapon") throw new Error("missing fixture weapon");
    const magazineSlot = weapon.slots.find((slot) => slot.id === "magazine");
    if (!magazineSlot) throw new Error("missing fixture slot");
    magazineSlot.allowedItemIds = ["special-magazine"];
    magazineSlot.excludedCategories = ["banned-magazine"];

    expect(isCompatibleCandidate(data, build, build.root.instanceId, "magazine", "magazine")).toBe(true);
    expect(isCompatibleCandidate(data, build, build.root.instanceId, "magazine", "special-magazine")).toBe(true);
    expect(isCompatibleCandidate(data, build, build.root.instanceId, "magazine", "blocked-magazine")).toBe(false);
    expect(isCompatibleCandidate(data, build, build.root.instanceId, "magazine", "forbidden-category-magazine")).toBe(false);
    expect(
      getCompatibleCandidates(data, build, build.root.instanceId, "magazine").map(
        (item) => item.id,
      ),
    ).toEqual(["magazine", "special-magazine"]);
  });

  it("checks item and category conflicts in both directions against the remaining build", () => {
    const data = catalog();
    const build = createFactoryBuild(data, "weapon");

    expect(isCompatibleCandidate(data, build, build.root.instanceId, "magazine", "drum")).toBe(false);
    expect(
      isCompatibleCandidate(
        data,
        build,
        build.root.instanceId,
        "magazine",
        "slot-conflict-magazine",
      ),
    ).toBe(false);

    const receiverChange = replaceBuildSlot(
      data,
      build,
      build.root.instanceId,
      "receiver",
      "receiver-b",
    );
    expect(receiverChange.ok).toBe(true);
    if (!receiverChange.ok) return;
    expect(
      isCompatibleCandidate(
        data,
        receiverChange.build,
        receiverChange.build.root.instanceId,
        "magazine",
        "special-magazine",
      ),
    ).toBe(false);
  });

  it("lists every slot-allowed part even when the current build conflicts", () => {
    const data = catalog();
    const build = createFactoryBuild(data, "weapon");

    expect(getSlotCandidates(
      data,
      build,
      build.root.instanceId,
      "magazine",
    ).map((item) => item.id)).toEqual([
      "magazine",
      "drum",
      "slot-conflict-magazine",
    ]);
  });
});

describe("weapon build mutations", () => {
  it("can equip a slot-allowed part by removing its conflicting installed branch", () => {
    const data = catalog();
    const original = createFactoryBuild(data, "weapon");

    const result = replaceBuildSlotResolvingConflicts(
      data,
      original,
      original.root.instanceId,
      "magazine",
      "drum",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.removedNodes.map((node) => node.itemId)).toEqual(expect.arrayContaining([
      "magazine",
      "optic",
    ]));
    expect(flattenBuildTree(result.build.root).map((node) => node.itemId)).toEqual([
      "weapon",
      "receiver-a",
      "mount",
      "drum",
    ]);
    expect(validateWeaponBuild(data, result.build).isValid).toBe(true);
  });

  it("replaces a slot and atomically removes the previous part's whole descendant tree", () => {
    const data = catalog();
    const original = createFactoryBuild(data, "weapon");

    const result = replaceBuildSlot(
      data,
      original,
      original.root.instanceId,
      "receiver",
      "receiver-b",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.removedNodes.map((node) => node.itemId)).toEqual([
      "receiver-a",
      "mount",
      "optic",
    ]);
    expect(flattenBuildTree(result.build.root).map((node) => node.itemId)).toEqual([
      "weapon",
      "receiver-b",
      "magazine",
    ]);
    expect(flattenBuildTree(original.root).map((node) => node.itemId)).toEqual([
      "weapon",
      "receiver-a",
      "mount",
      "optic",
      "magazine",
    ]);
  });

  it("removes a slot and all descendants without mutating the source build", () => {
    const original = createFactoryBuild(catalog(), "weapon");

    const result = removeBuildSlot(original, original.root.instanceId, "receiver");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.removedNodes.map((node) => node.itemId)).toEqual([
      "receiver-a",
      "mount",
      "optic",
    ]);
    expect(flattenBuildTree(result.build.root).map((node) => node.itemId)).toEqual([
      "weapon",
      "magazine",
    ]);
    expect(flattenBuildTree(original.root)).toHaveLength(5);
  });

  it("returns the unchanged build when a replacement is incompatible", () => {
    const data = catalog();
    const original = createFactoryBuild(data, "weapon");

    const result = replaceBuildSlot(
      data,
      original,
      original.root.instanceId,
      "magazine",
      "blocked-magazine",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.build).toBe(original);
    expect(result.issues.map((issue) => issue.code)).toContain("ITEM_EXCLUDED");
  });
});

describe("weapon build validation and stats", () => {
  it("reports missing required slots and global conflicts", () => {
    const data = catalog();
    const invalidRoot: BuildNode = {
      instanceId: "root",
      itemId: "weapon",
      children: [
        {
          instanceId: "receiver-a",
          itemId: "receiver-a",
          slotId: "receiver",
          children: [],
        },
        {
          instanceId: "drum",
          itemId: "drum",
          slotId: "magazine",
          children: [],
        },
        {
          instanceId: "orphaned-optic",
          itemId: "optic",
          slotId: "receiver",
          children: [],
        },
      ],
    };

    const validation = validateWeaponBuild(data, {
      schemaVersion: 1,
      catalogDataVersion: data.dataVersion,
      weaponId: "weapon",
      root: invalidRoot,
    });

    expect(validation.isValid).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "MISSING_REQUIRED_SLOT",
        "ITEM_NOT_ALLOWED",
        "ITEM_CONFLICT",
      ]),
    );
  });

  it("adds every installed part modifier to the weapon base stats", () => {
    const data = catalog();
    const build = createFactoryBuild(data, "weapon");

    const buildStats = calculateBuildStats(data, build);
    expect(buildStats).toMatchObject({
      verticalRecoil: 90,
      horizontalRecoil: 180,
      ergonomics: 44,
      weight: 3.2,
      muzzleVelocityModifier: 3,
    });
    expect(buildStats.accuracyMoa).toBeCloseTo(2.17, 2);
  });
});
