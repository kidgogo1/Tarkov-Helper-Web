import { describe, expect, it } from "vitest";

import bundledCatalogJson from "../../public/data/weapon-modding/catalog.json?raw";

import {
  calculateBuildStats,
  createFactoryBuild,
  flattenBuildTree,
  validateWeaponBuild,
} from "../../src/domain/weapon-build";
import { parseWeaponModCatalog } from "../../src/services/weapon-mod-data";

describe("bundled weapon catalog builds", () => {
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
});
