import type {
  BuildNode,
  WeaponCatalogItem,
  WeaponSlotRule,
} from "../../types/weapon-modding";
import { isDisplayableWeaponSlot } from "./weapon-slot-display";

export interface WeaponHotspotSlot {
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
