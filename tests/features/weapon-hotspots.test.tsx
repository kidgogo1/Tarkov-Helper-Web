import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import bundledCatalogJson from "../../public/data/weapon-modding/catalog.json?raw";
import {
  collectWeaponHotspotSlots,
  WeaponHotspots,
} from "../../src/features/modding/WeaponHotspots";
import { createFactoryBuild } from "../../src/domain/weapon-build";
import { layoutWeaponHotspots } from "../../src/features/modding/weapon-hotspot-layout";
import { isDisplayableWeaponSlot } from "../../src/features/modding/weapon-slot-display";
import { parseWeaponModCatalog } from "../../src/services/weapon-mod-data";

const ROOT_ID = "weapon:5447a9cd4bdc2dbd208b4567";
const FIRST_CHARGE_SLOT_ID = "55d5a30f4bdc2d882f8b4574";
const SECOND_CHARGE_SLOT_ID = "67530a90d8f555dc210c7c36";
const CHAMBER_SLOT_ID = "55d35ee94bdc2d61338b4568";

const slots = [
  {
    id: FIRST_CHARGE_SLOT_ID,
    name: "장전 손잡이",
    allowedItemIds: [],
  },
  {
    id: SECOND_CHARGE_SLOT_ID,
    name: "장전 손잡이",
    allowedItemIds: [],
  },
  {
    id: CHAMBER_SLOT_ID,
    name: "약실",
    allowedItemIds: [],
  },
];

describe("weapon hotspot presentation", () => {
  it("hides localized chamber slots from the visual mod picker", () => {
    expect(isDisplayableWeaponSlot(slots[2])).toBe(false);
  });

  it("gives repeated slot types distinct clickable hotspot positions", () => {
    render(
      <WeaponHotspots
        itemById={new Map()}
        onSelect={vi.fn()}
        root={{
          instanceId: ROOT_ID,
          itemId: "5447a9cd4bdc2dbd208b4567",
          children: [],
        }}
        selectedSlot={null}
        slots={slots}
      />,
    );

    const group = screen.getByRole("group", { name: "총기 부위 선택" });
    const chargingHandles = within(group).getAllByRole("button", { name: /장전 손잡이/ });
    expect(chargingHandles).toHaveLength(2);
    expect(new Set(chargingHandles.map((button) => button.getAttribute("style"))).size).toBe(2);
    expect(within(group).queryByRole("button", { name: /약실/ })).not.toBeInTheDocument();
  });

  it("keeps more than seven repeated slot types at distinct positions", () => {
    const repeatedSlots = Array.from({ length: 10 }, (_, index) => ({
      id: `repeated-slot-${index}`,
      name: "전술 장비",
      allowedItemIds: [],
    }));

    const positions = layoutWeaponHotspots(repeatedSlots);

    expect(new Set(positions.map(({ x, y }) => `${x}:${y}`)).size).toBe(
      repeatedSlots.length,
    );
  });

  it("maps localized structural slots to their intended weapon regions", () => {
    const localizedSlots = [
      { id: "slot-handguard", name: "총열 덮개", allowedItemIds: [] },
      { id: "slot-launcher", name: "총열 하부 유탄발사기", allowedItemIds: [] },
      { id: "slot-mount", name: "마운트 레일", allowedItemIds: [] },
      { id: "slot-rear-sight", name: "가늠자", allowedItemIds: [] },
      { id: "slot-front-sight", name: "가늠쇠", allowedItemIds: [] },
      { id: "slot-receiver", name: "총기 몸체", allowedItemIds: [] },
      { id: "slot-bipod", name: "양각대", allowedItemIds: [] },
      { id: "slot-trigger", name: "방아쇠", allowedItemIds: [] },
    ];

    expect(layoutWeaponHotspots(localizedSlots)).toEqual([
      { x: 35, y: 66 },
      { x: 30, y: 82 },
      { x: 50, y: 16 },
      { x: 61, y: 25 },
      { x: 42, y: 25 },
      { x: 53, y: 43 },
      { x: 27, y: 84 },
      { x: 65, y: 59 },
    ]);
  });

  it("exposes slots from installed child parts and selects their real parent instance", () => {
    const onSelect = vi.fn();
    const childInstanceId = `${ROOT_ID}/${FIRST_CHARGE_SLOT_ID}`;
    const nestedSlot = {
      id: "5a0000000000000000000001",
      name: "전술 장비",
      allowedItemIds: [],
    };
    render(
      <WeaponHotspots
        itemById={new Map([[
          "5a0000000000000000000000",
          {
            id: "5a0000000000000000000000",
            name: "Installed handguard",
            shortName: "HG",
            kind: "part" as const,
            categories: ["handguard"],
            slots: [nestedSlot],
          },
        ]])}
        onSelect={onSelect}
        root={{
          instanceId: ROOT_ID,
          itemId: "5447a9cd4bdc2dbd208b4567",
          children: [{
            instanceId: childInstanceId,
            itemId: "5a0000000000000000000000",
            slotId: FIRST_CHARGE_SLOT_ID,
            children: [],
          }],
        }}
        selectedSlot={null}
        slots={slots}
      />,
    );

    const nestedButton = within(
      screen.getByRole("group", { name: "총기 부위 선택" }),
    ).getByRole("button", { name: /전술 장비.*HG.*비어 있음/ });
    fireEvent.click(nestedButton);
    expect(onSelect).toHaveBeenCalledWith({
      parentInstanceId: childInstanceId,
      slotId: nestedSlot.id,
    });
  });

  it("keeps every bundled weapon nested hotspot at a distinct position", () => {
    const catalog = parseWeaponModCatalog(JSON.parse(bundledCatalogJson) as unknown);
    expect(catalog).not.toBeNull();
    if (!catalog) return;

    const itemById = new Map(catalog.items.map((item) => [item.id, item]));
    for (const weaponId of catalog.weaponIds) {
      const weapon = catalog.items.find((item) => item.id === weaponId);
      if (!weapon || weapon.kind !== "weapon") continue;
      const build = createFactoryBuild(catalog, weaponId);
      const hotspotSlots = collectWeaponHotspotSlots(build.root, itemById, weapon.slots);
      const positions = layoutWeaponHotspots(hotspotSlots.map(({ slot }) => slot));
      expect(
        new Set(positions.map(({ x, y }) => `${x}:${y}`)).size,
        `duplicate hotspot coordinate for ${weaponId}`,
      ).toBe(hotspotSlots.length);
      if (weaponId === "5447a9cd4bdc2dbd208b4567") {
        expect(hotspotSlots).toHaveLength(18);
        expect(hotspotSlots.filter(({ depth }) => depth > 0)).toHaveLength(12);
      }
    }
  });
});
