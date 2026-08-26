import type { CSSProperties } from "react";

import type {
  BuildNode,
  WeaponCatalogItem,
  WeaponSlotRule,
} from "../../types/weapon-modding";
import type { SlotSelection } from "./WeaponSlotTree";
import {
  displayWeaponSlotName,
  isDisplayableWeaponSlot,
} from "./weapon-slot-display";
import { layoutWeaponHotspots } from "./weapon-hotspot-layout";

interface WeaponHotspotsProps {
  itemById: ReadonlyMap<string, WeaponCatalogItem>;
  root: BuildNode;
  slots: WeaponSlotRule[];
  selectedSlot: SlotSelection | null;
  onSelect: (selection: SlotSelection) => void;
}

export function WeaponHotspots({
  itemById,
  root,
  slots,
  selectedSlot,
  onSelect,
}: WeaponHotspotsProps) {
  const displaySlots = slots.filter(isDisplayableWeaponSlot);
  const positions = layoutWeaponHotspots(displaySlots);
  return (
    <div className="modding-hotspots" aria-label="총기 부위 선택" role="group">
      {displaySlots.map((slot, index) => {
        const child = root.children.find((node) => node.slotId === slot.id);
        const childItem = child ? itemById.get(child.itemId) : undefined;
        const position = positions[index];
        const selected = selectedSlot?.parentInstanceId === root.instanceId &&
          selectedSlot.slotId === slot.id;
        const style = {
          "--hotspot-x": `${position.x}%`,
          "--hotspot-y": `${position.y}%`,
        } as CSSProperties;
        return (
          <button
            aria-pressed={selected}
            className={selected ? "selected" : ""}
            key={slot.id}
            onClick={() => onSelect({ parentInstanceId: root.instanceId, slotId: slot.id })}
            style={style}
            type="button"
          >
            <span aria-hidden="true" />
            <strong>{displayWeaponSlotName(slot)}</strong>
            <small>{childItem?.shortName ?? childItem?.nameKo ?? childItem?.name ?? "비어 있음"}</small>
          </button>
        );
      })}
    </div>
  );
}
