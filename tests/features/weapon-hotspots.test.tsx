import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import bundledCatalogJson from "../../public/data/weapon-modding/catalog.json?raw";
import {
  WeaponHotspots,
} from "../../src/features/modding/WeaponHotspots";
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

  it("keeps every bundled weapon root hotspot at a distinct position", () => {
    const catalog = parseWeaponModCatalog(JSON.parse(bundledCatalogJson) as unknown);
    expect(catalog).not.toBeNull();
    if (!catalog) return;

    for (const weaponId of catalog.weaponIds) {
      const weapon = catalog.items.find((item) => item.id === weaponId);
      if (!weapon || weapon.kind !== "weapon") continue;
      const visibleSlots = weapon.slots.filter(isDisplayableWeaponSlot);
      const positions = layoutWeaponHotspots(visibleSlots);
      expect(
        new Set(positions.map(({ x, y }) => `${x}:${y}`)).size,
        `duplicate hotspot coordinate for ${weaponId}`,
      ).toBe(positions.length);
    }
  });
});
