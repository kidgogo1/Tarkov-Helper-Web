import type { BuildNode, WeaponCatalogItem, WeaponSlotRule } from "../../types/weapon-modding";
import type { WeaponHotspotSlot } from "./weapon-hotspot-slots";
import { displayWeaponSlotName } from "./weapon-slot-display";
import { groupWeaponVisualSlots } from "./weapon-visual-groups";

export type AssemblySlotFilter = "all" | "required" | "installed" | "empty";

export interface AssemblySlotCard {
  key: string;
  entry: WeaponHotspotSlot;
  label: string;
  parentLabel: string;
  partLabel: string;
  installed: boolean;
  /** Schematic percentages only; these are not coordinates from a 3D model. */
  anchor: { x: number; y: number };
}

export function collectWeaponAssemblyCards(
  root: BuildNode,
  itemById: ReadonlyMap<string, WeaponCatalogItem>,
  rootSlots: readonly WeaponSlotRule[],
): AssemblySlotCard[] {
  const nodes = new Map<string, BuildNode>();
  const visit = (node: BuildNode) => {
    nodes.set(node.instanceId, node);
    node.children.forEach(visit);
  };
  visit(root);
  const entries = groupWeaponVisualSlots(root, itemById, rootSlots)
    .flatMap((group) => group.slots.map((entry) => ({ entry, anchor: group.anchor })));
  const duplicateKey = (entry: WeaponHotspotSlot) =>
    `${entry.parentItem?.shortName || entry.parentItem?.name || "총기 본체"}:${displayWeaponSlotName(entry.slot)}`;
  const totals = new Map<string, number>();
  entries.forEach(({ entry }) => totals.set(duplicateKey(entry), (totals.get(duplicateKey(entry)) ?? 0) + 1));
  const ordinals = new Map<string, number>();
  return entries.map(({ entry, anchor }) => {
    const nameKey = duplicateKey(entry);
    const ordinal = (ordinals.get(nameKey) ?? 0) + 1;
    ordinals.set(nameKey, ordinal);
    const suffix = (totals.get(nameKey) ?? 0) > 1
      ? ` ${ordinal <= 20 ? String.fromCodePoint(0x2460 + ordinal - 1) : `(${ordinal})`}` : "";
    // An installed item absent from the catalog is not an empty slot.
    const installed = nodes.get(entry.parentInstanceId)?.children.some((child) => child.slotId === entry.slot.id) ?? false;
    return {
      key: `${entry.parentInstanceId}:${entry.slot.id}`,
      entry,
      label: `${displayWeaponSlotName(entry.slot)}${suffix}`,
      parentLabel: entry.parentItem?.shortName || entry.parentItem?.nameKo || entry.parentItem?.name || "총기 본체",
      partLabel: entry.childItem?.shortName || entry.childItem?.nameKo || entry.childItem?.name
        || (installed ? "자료 없는 부품" : "비어 있음"),
      installed,
      anchor,
    };
  });
}

export function filterWeaponAssemblyCards(cards: readonly AssemblySlotCard[], filter: AssemblySlotFilter): AssemblySlotCard[] {
  return cards.filter((card) => filter === "all"
    || (filter === "required" && card.entry.slot.required)
    || (filter === "installed" && card.installed)
    || (filter === "empty" && !card.installed));
}

export function paginateWeaponAssemblyCards(cards: readonly AssemblySlotCard[], requestedPage: number, requestedSize = 14) {
  const size = Number.isFinite(requestedSize) ? Math.min(14, Math.max(1, Math.floor(requestedSize))) : 14;
  const pageCount = Math.max(1, Math.ceil(cards.length / size));
  const page = Number.isFinite(requestedPage) ? Math.min(pageCount - 1, Math.max(0, Math.floor(requestedPage))) : 0;
  return { cards: cards.slice(page * size, (page + 1) * size), page, pageCount };
}

export function weaponAssemblyColumns(width: number): number {
  return Number.isFinite(width) && width > 0 ? Math.max(2, Math.min(7, Math.floor((width - 16) / 104))) : 7;
}
