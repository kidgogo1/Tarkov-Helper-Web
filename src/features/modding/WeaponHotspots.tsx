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

interface WeaponHotspotSlot {
  childItem?: WeaponCatalogItem;
  depth: number;
  parentInstanceId: string;
  parentItem?: WeaponCatalogItem;
  slot: WeaponSlotRule;
}

export function collectWeaponHotspotSlots(
  root: BuildNode,
  itemById: ReadonlyMap<string, WeaponCatalogItem>,
  rootSlots: readonly WeaponSlotRule[],
): WeaponHotspotSlot[] {
  const result: WeaponHotspotSlot[] = [];
  const visit = (node: BuildNode, depth: number) => {
    const parentItem = itemById.get(node.itemId);
    const slots = (parentItem?.slots ?? (depth === 0 ? rootSlots : []))
      .filter(isDisplayableWeaponSlot);
    for (const slot of slots) {
      const child = node.children.find((candidate) => candidate.slotId === slot.id);
      result.push({
        childItem: child ? itemById.get(child.itemId) : undefined,
        depth,
        parentInstanceId: node.instanceId,
        parentItem,
        slot,
      });
    }
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(root, 0);
  return result;
}

export function WeaponHotspots({
  itemById,
  root,
  slots,
  selectedSlot,
  onSelect,
}: WeaponHotspotsProps) {
  const hotspotSlots = collectWeaponHotspotSlots(root, itemById, slots);
  const positions = layoutWeaponHotspots(hotspotSlots.map(({ slot }) => slot));
  return (
    <div className="modding-hotspots" aria-label="총기 부위 선택" role="group">
      {hotspotSlots.map((hotspot, index) => {
        const { childItem, depth, parentInstanceId, parentItem, slot } = hotspot;
        const position = positions[index];
        const selected = selectedSlot?.parentInstanceId === parentInstanceId &&
          selectedSlot.slotId === slot.id;
        const childLabel = childItem?.shortName ?? childItem?.nameKo ??
          childItem?.name ?? "비어 있음";
        const parentLabel = depth > 0
          ? parentItem?.shortName ?? parentItem?.nameKo ?? parentItem?.name
          : undefined;
        const style = {
          "--hotspot-x": `${position.x}%`,
          "--hotspot-y": `${position.y}%`,
        } as CSSProperties;
        return (
          <button
            aria-pressed={selected}
            className={selected ? "selected" : ""}
            key={`${parentInstanceId}:${slot.id}`}
            onClick={() => onSelect({ parentInstanceId, slotId: slot.id })}
            style={style}
            type="button"
          >
            <span aria-hidden="true" />
            <strong>{displayWeaponSlotName(slot)}</strong>
            <small>{parentLabel ? `${parentLabel} · ${childLabel}` : childLabel}</small>
          </button>
        );
      })}
    </div>
  );
}
