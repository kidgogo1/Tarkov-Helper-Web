import { describe, expect, it } from "vitest";

import bundledCatalogJson from "../../public/data/weapon-modding/catalog.json?raw";

import {
  calculateBuildStats,
  createFactoryBuild,
  flattenBuildTree,
  getCompatibleCandidates,
  getSlotCandidates,
  replaceBuildSlotResolvingConflicts,
  validateWeaponBuild,
} from "../../src/domain/weapon-build";
import { parseWeaponModCatalog } from "../../src/services/weapon-mod-data";
import { summarizeBuildPrice } from "../../src/features/modding/build-price-summary";

describe("bundled weapon catalog builds", () => {
  it("never charges factory parts twice across the whole bundle in either profile", () => {
    const catalog = parseWeaponModCatalog(JSON.parse(bundledCatalogJson) as unknown);
    if (!catalog) throw new Error("invalid bundled catalog");
    for (const weaponId of catalog.weaponIds) {
      const build = createFactoryBuild(catalog, weaponId);
      for (const profile of ["pvp", "pve"] as const) {
        const summary = summarizeBuildPrice(catalog, build, profile);
        expect(summary.additionalPartCount, `${weaponId}:${profile}`).toBe(0);
        for (const strategy of Object.values(summary.strategies)) {
          expect(strategy.parts.totalRoubles).toBe(0);
          expect(strategy.total.totalRoubles).toBe(strategy.weapon.totalRoubles);
          expect(strategy.purchaseLines).toEqual([]);
        }
        expect(summarizeBuildPrice(catalog, build, profile, "owned").strategies.cheapest.total.totalRoubles).toBe(0);
      }
    }
  });

  it("can create a safe factory build for every bundled weapon", async () => {
    const payload = JSON.parse(bundledCatalogJson) as unknown;
    const catalog = parseWeaponModCatalog(payload);
    expect(catalog).not.toBeNull();
    if (!catalog) return;

    const failures: string[] = [];
    const invalidBuilds: string[] = [];
    for (const weaponId of catalog.weaponIds) {
      try {
        const build = createFactoryBuild(catalog, weaponId);
        expect(build.root.itemId).toBe(weaponId);
        const validation = validateWeaponBuild(catalog, build);
        if (!validation.isValid) {
          invalidBuilds.push(`${weaponId}: ${validation.issues.map((issue) => issue.code).join(",")}`);
        }
      } catch (error: unknown) {
        failures.push(`${weaponId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    expect(failures).toEqual([]);
    expect(invalidBuilds).toEqual([]);
  });

  it("matches the catalog default-preset MOA for representative weapons", () => {
    const catalog = parseWeaponModCatalog(JSON.parse(bundledCatalogJson) as unknown);
    expect(catalog).not.toBeNull();
    if (!catalog) return;

    const expectedMoa = new Map([
      ["5447a9cd4bdc2dbd208b4567", 2.17], // M4A1
      ["5cadfbf7ae92152ac412eeef", 1.79], // ASh-12
    ]);
    for (const [weaponId, expected] of expectedMoa) {
      const stats = calculateBuildStats(catalog, createFactoryBuild(catalog, weaponId));
      expect(stats.accuracyMoa, weaponId).toBeCloseTo(expected, 2);
    }
  });

  it("preserves repeated factory parts installed in different slots", () => {
    const catalog = parseWeaponModCatalog(JSON.parse(bundledCatalogJson) as unknown);
    expect(catalog).not.toBeNull();
    if (!catalog) return;

    const mpxBuild = createFactoryBuild(catalog, "58948c8e86f77409493f7266");
    const repeatedRailCount = flattenBuildTree(mpxBuild.root)
      .filter((node) => node.itemId === "58a56f8d86f774651579314c").length;
    expect(repeatedRailCount).toBe(2);
  });

  it("keeps M4A1 combination stocks selectable and removes only their conflicting stock", () => {
    const catalog = parseWeaponModCatalog(JSON.parse(bundledCatalogJson) as unknown);
    expect(catalog).not.toBeNull();
    if (!catalog) return;

    const build = createFactoryBuild(catalog, "5447a9cd4bdc2dbd208b4567");
    const weapon = catalog.items.find((item) => item.id === build.weaponId);
    if (!weapon || weapon.kind !== "weapon") throw new Error("missing M4A1");
    const slot = weapon.slots.find((candidate) => candidate.id === "55d354084bdc2d8c2f8b4568");
    if (!slot) throw new Error("missing M4A1 pistol grip slot");
    const candidates = getSlotCandidates(
      catalog,
      build,
      build.root.instanceId,
      slot.id,
    );
    const immediatelyCompatible = getCompatibleCandidates(
      catalog,
      build,
      build.root.instanceId,
      slot.id,
    );
    expect(candidates.length).toBeGreaterThan(immediatelyCompatible.length);
    expect(candidates.map((item) => item.id)).toEqual(expect.arrayContaining([
      "5a33e75ac4a2826c6e06d759",
      "5c0e2ff6d174af02a1659d4a",
    ]));

    const result = replaceBuildSlotResolvingConflicts(
      catalog,
      build,
      build.root.instanceId,
      slot.id,
      "5a33e75ac4a2826c6e06d759",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.removedNodes.map((node) => node.itemId)).toEqual(expect.arrayContaining([
      "55d4ae6c4bdc2d8b2f8b456e",
      "55d4b9964bdc2d1d4e8b456e",
    ]));
    expect(flattenBuildTree(result.build.root).map((node) => node.itemId)).toContain(
      "5a33e75ac4a2826c6e06d759",
    );
    expect(validateWeaponBuild(catalog, result.build).isValid).toBe(true);
  });
});
