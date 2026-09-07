import { describe, expect, it } from "vitest";
import type { BuildNode, WeaponCatalogItem, WeaponSlotRule } from "../../src/types/weapon-modding";
import {
  collectWeaponAssemblyCards,
  filterWeaponAssemblyCards,
  paginateWeaponAssemblyCards,
  weaponAssemblyColumns,
} from "../../src/features/modding/weapon-assembly-layout";

function fixture(count = 40) {
  const slots: WeaponSlotRule[] = Array.from({ length: count }, (_, index) => ({
    id: `slot-${index}`, name: "전술 장비", required: index === 0,
  }));
  const parent: WeaponCatalogItem = { kind: "part", id: "rail", name: "Rail", shortName: "RIS II", categories: [], slots };
  const root: BuildNode = { instanceId: "root", itemId: "weapon", children: [
    { instanceId: "first", itemId: "rail", slotId: "mount-1", children: [
      { instanceId: "unknown", itemId: "not-in-catalog", slotId: "slot-0", children: [] },
    ] },
    { instanceId: "second", itemId: "rail", slotId: "mount-2", children: [] },
  ] };
  const rootSlots = [{ id: "mount-1", name: "마운트" }, { id: "mount-2", name: "마운트" }];
  return { root, itemById: new Map([[parent.id, parent]]), rootSlots };
}

describe("individual assembly slot layout", () => {
  it("preserves every nested slot and numbers repeated display names without merging parent instances", () => {
    const { root, itemById, rootSlots } = fixture();
    const cards = collectWeaponAssemblyCards(root, itemById, rootSlots);
    expect(cards).toHaveLength(82);
    expect(new Set(cards.map((card) => card.key)).size).toBe(82);
    const repeated = cards.filter((card) => card.entry.slot.id === "slot-1");
    expect(repeated.map((card) => card.entry.parentInstanceId)).toEqual(["first", "second"]);
    expect(new Set(repeated.map((card) => card.label)).size).toBe(2);
  });

  it("uses actual build occupancy for filters even when installed item metadata is unavailable", () => {
    const { root, itemById, rootSlots } = fixture();
    const cards = collectWeaponAssemblyCards(root, itemById, rootSlots);
    expect(filterWeaponAssemblyCards(cards, "all")).toHaveLength(82);
    expect(filterWeaponAssemblyCards(cards, "required")).toHaveLength(2);
    expect(filterWeaponAssemblyCards(cards, "installed")).toHaveLength(3);
    expect(filterWeaponAssemblyCards(cards, "empty")).toHaveLength(79);
    expect(cards.find((card) => card.key === "first:slot-0")).toMatchObject({ installed: true, partLabel: "자료 없는 부품" });
  });

  it("keeps every card accessible over bounded pages and clamps stale page indexes", () => {
    const { root, itemById, rootSlots } = fixture();
    const cards = collectWeaponAssemblyCards(root, itemById, rootSlots);
    const allPages = Array.from({ length: 6 }, (_, page) => paginateWeaponAssemblyCards(cards, page, 14));
    expect(allPages.map(({ cards: page }) => page.length)).toEqual([14, 14, 14, 14, 14, 12]);
    expect(allPages.flatMap(({ cards: page }) => page).map((card) => card.key)).toEqual(cards.map((card) => card.key));
    expect(paginateWeaponAssemblyCards(cards.slice(0, 2), 9, 14)).toMatchObject({ page: 0, pageCount: 1 });
    expect(paginateWeaponAssemblyCards(cards, -1, 100).cards).toHaveLength(14);
    expect(paginateWeaponAssemblyCards([], 2, 14)).toMatchObject({ page: 0, pageCount: 1, cards: [] });
  });

  it("adapts to narrow containers without exceeding seven cards per edge", () => {
    expect(weaponAssemblyColumns(320)).toBe(2);
    expect(weaponAssemblyColumns(500)).toBe(4);
    expect(weaponAssemblyColumns(800)).toBe(7);
    expect(weaponAssemblyColumns(1920)).toBe(7);
    expect(weaponAssemblyColumns(0)).toBe(7);
    expect(weaponAssemblyColumns(Number.NaN)).toBe(7);
  });
});
