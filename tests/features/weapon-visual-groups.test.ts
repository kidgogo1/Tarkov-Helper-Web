import { describe, expect, it } from "vitest";
import bundledCatalogJson from "../../public/data/weapon-modding/catalog.json?raw";
import { createFactoryBuild } from "../../src/domain/weapon-build";
import { parseWeaponModCatalog } from "../../src/services/weapon-mod-data";
import type { BuildNode, WeaponCatalogItem, WeaponSlotRule } from "../../src/types/weapon-modding";
import { collectWeaponHotspotSlots } from "../../src/features/modding/weapon-hotspot-slots";
import {
  describeWeaponVisualSlot,
  groupWeaponVisualSlots,
} from "../../src/features/modding/weapon-visual-groups";

const root: BuildNode = { instanceId: "weapon", itemId: "weapon", children: [] };

function slot(id: string, name: string): WeaponSlotRule {
  return { id, name, allowedItemIds: [] };
}

describe("connected weapon visual groups", () => {
  it("groups localized functional slots without confusing underbarrel and handguard with barrel", () => {
    const slots = [
      slot("muzzle", "총구"),
      slot("barrel", "총열"),
      slot("gas", "가스 블록"),
      slot("handguard", "총열 덮개"),
      slot("launcher", "총열 하부 유탄발사기"),
      slot("foregrip", "전방 손잡이"),
      slot("tactical", "전술 장비"),
      slot("rail", "마운트 레일"),
      slot("front", "가늠쇠"),
      slot("rear", "가늠자"),
      slot("scope", "조준경"),
      slot("receiver", "총기 몸체"),
      slot("charge", "장전 손잡이"),
      slot("trigger", "방아쇠"),
      slot("pistolgrip", "권총 손잡이"),
      slot("stock", "개머리판"),
      slot("magazine", "탄창"),
      slot("new", "새로운 부위"),
    ].map((entry, index) => ({ ...entry, id: `opaque-${index}` }));
    const groups = groupWeaponVisualSlots(root, new Map(), slots);
    const namesByGroup = Object.fromEntries(groups.map((group) => [
      group.id, group.slots.map(({ slot: entry }) => entry.name),
    ]));

    expect(namesByGroup).toEqual({
      muzzle: ["총구"],
      barrel: ["총열", "가스 블록"],
      handguard: ["총열 덮개", "총열 하부 유탄발사기", "전방 손잡이"],
      accessories: ["전술 장비", "마운트 레일"],
      optics: ["가늠쇠", "가늠자", "조준경"],
      receiver: ["총기 몸체", "장전 손잡이", "방아쇠"],
      grip: ["권총 손잡이"],
      stock: ["개머리판"],
      magazine: ["탄창"],
      other: ["새로운 부위"],
    });
  });

  it("preserves over 32 repeated, nested, and empty slots by real parent instance", () => {
    const repeatedSlots = Array.from({ length: 40 }, (_, index) => slot(`tactical-${index}`, "전술 장비"));
    const installed: WeaponCatalogItem = {
      id: "rail", kind: "part", name: "Installed rail", shortName: "Rail", categories: [],
      slots: repeatedSlots,
    };
    const itemById = new Map([[installed.id, installed]]);
    const nestedRoot: BuildNode = {
      ...root,
      children: [
        { instanceId: "left-rail", itemId: "rail", slotId: "left", children: [] },
        { instanceId: "right-rail", itemId: "rail", slotId: "right", children: [] },
      ],
    };
    const rootSlots = [slot("left", "마운트 레일"), slot("right", "마운트 레일")];

    const actual = groupWeaponVisualSlots(nestedRoot, itemById, rootSlots).flatMap((group) => group.slots);
    const expected = collectWeaponHotspotSlots(nestedRoot, itemById, rootSlots);
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(82);
    expect(new Set(actual.map((entry) => `${entry.parentInstanceId}/${entry.slot.id}`)).size).toBe(82);
    expect(actual.filter((entry) => !entry.childItem)).toHaveLength(80);
  });

  it("omits empty groups and preserves the collector's chamber exclusion", () => {
    expect(groupWeaponVisualSlots(root, new Map(), [])).toEqual([]);
    expect(groupWeaponVisualSlots(root, new Map(), [slot("chamber", "약실")])).toEqual([]);
    const groups = groupWeaponVisualSlots(root, new Map(), [slot("unknown", "Unrecognized slot")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("other");
  });

  it("uses stable distinct schematic anchors regardless of the number of repeated slots", () => {
    const singles = [slot("stock", "개머리판"), slot("scope", "조준경"), slot("muzzle", "총구")];
    const initial = groupWeaponVisualSlots(root, new Map(), singles);
    const expanded = groupWeaponVisualSlots(root, new Map(), [...singles, slot("scope-2", "조준경")]);
    expect(initial.map(({ id, anchor }) => ({ id, anchor }))).toEqual(
      expanded.map(({ id, anchor }) => ({ id, anchor })),
    );
    expect(new Set(initial.map(({ anchor }) => `${anchor.x}:${anchor.y}`)).size).toBe(initial.length);
    for (const { anchor } of initial) {
      expect(anchor.x).toBeGreaterThan(0);
      expect(anchor.x).toBeLessThan(100);
      expect(anchor.y).toBeGreaterThan(0);
      expect(anchor.y).toBeLessThan(100);
    }
  });

  it("describes the actual parent and localized slot without inventing a physical location", () => {
    expect(describeWeaponVisualSlot({
      parentInstanceId: "rail", depth: 1,
      parentItem: { id: "rail", kind: "part", name: "Installed rail", shortName: "RIS II", categories: [] },
      slot: slot("mod_tactical", "Tactical device"),
    })).toBe("RIS II › 전술 장비");
    expect(describeWeaponVisualSlot({
      parentInstanceId: "missing", depth: 0, slot: slot("new", "새로운 부위"),
    })).toBe("새로운 부위");
  });

  it("keeps every bundled factory weapon slot exactly once within at most ten groups", () => {
    const catalog = parseWeaponModCatalog(JSON.parse(bundledCatalogJson) as unknown);
    expect(catalog).not.toBeNull();
    if (!catalog) return;
    const itemById = new Map(catalog.items.map((item) => [item.id, item]));
    for (const weaponId of catalog.weaponIds) {
      const weapon = itemById.get(weaponId);
      if (weapon?.kind !== "weapon") continue;
      const build = createFactoryBuild(catalog, weaponId);
      const groups = groupWeaponVisualSlots(build.root, itemById, weapon.slots);
      const keyOf = (entry: ReturnType<typeof collectWeaponHotspotSlots>[number]) =>
        `${entry.parentInstanceId}/${entry.slot.id}`;
      const actual = groups.flatMap((group) => group.slots).map(keyOf).sort();
      const expected = collectWeaponHotspotSlots(build.root, itemById, weapon.slots).map(keyOf).sort();
      expect(actual, weaponId).toEqual(expected);
      expect(new Set(actual).size, weaponId).toBe(actual.length);
      expect(groups.length, weaponId).toBeLessThanOrEqual(10);
    }
  });
});
