import type { BuildNode, WeaponCatalogItem, WeaponSlotRule } from "../../types/weapon-modding";
import { collectWeaponHotspotSlots, type WeaponHotspotSlot } from "./weapon-hotspot-slots";
import { displayWeaponSlotName } from "./weapon-slot-display";

export interface VisualSlotGroup {
  id: string;
  label: string;
  /** Schematic percentages, not verified coordinates on a weapon model. */
  anchor: { x: number; y: number };
  slots: WeaponHotspotSlot[];
}

const GROUPS = [
  { id: "muzzle", label: "총구", anchor: { x: 12, y: 50 } },
  { id: "barrel", label: "총열·가스 블록", anchor: { x: 29, y: 45 } },
  { id: "handguard", label: "핸드가드·전방", anchor: { x: 39, y: 61 } },
  { id: "accessories", label: "전술 장비·레일", anchor: { x: 40, y: 36 } },
  { id: "optics", label: "조준 장비", anchor: { x: 57, y: 29 } },
  { id: "receiver", label: "총몸·장전", anchor: { x: 59, y: 47 } },
  { id: "grip", label: "권총 손잡이", anchor: { x: 68, y: 66 } },
  { id: "stock", label: "개머리판", anchor: { x: 84, y: 44 } },
  { id: "magazine", label: "탄창", anchor: { x: 54, y: 73 } },
  { id: "other", label: "기타 부위", anchor: { x: 71, y: 53 } },
] as const;

type GroupId = typeof GROUPS[number]["id"];

// Match specific compound names first: a handguard or underbarrel launcher is
// not the barrel itself, and a pistol grip is not a foregrip.
const SLOT_GROUPS: ReadonlyArray<readonly [RegExp, GroupId]> = [
  [/handguard|fore.?grip|under.?barrel|grenade.*launcher|bipod|핸드가드|총열\s*덮개|전방.*손잡이|유탄|양각대/, "handguard"],
  [/pistol.?grip|권총.*손잡이/, "grip"],
  [/muzzle|silencer|suppressor|총구|소음기|소염기/, "muzzle"],
  [/barrel|gas.?block|총열|가스/, "barrel"],
  [/scope|sight|optic|조준|가늠자|가늠쇠/, "optics"],
  [/tactical|mount|rail|전술|마운트|레일/, "accessories"],
  [/receiver|reciever|charge|charging|trigger|리시버|총기\s*몸체|총몸|장전|방아쇠/, "receiver"],
  [/stock|개머리판/, "stock"],
  [/magazine|탄창/, "magazine"],
];

export function groupWeaponVisualSlots(
  root: BuildNode,
  itemById: ReadonlyMap<string, WeaponCatalogItem>,
  rootSlots: readonly WeaponSlotRule[],
): VisualSlotGroup[] {
  const slotsByGroup = new Map<GroupId, WeaponHotspotSlot[]>();
  for (const entry of collectWeaponHotspotSlots(root, itemById, rootSlots)) {
    const source = `${entry.slot.id} ${entry.slot.name}`.toLocaleLowerCase();
    const groupId = SLOT_GROUPS.find(([pattern]) => pattern.test(source))?.[1] ?? "other";
    const groupedSlots = slotsByGroup.get(groupId) ?? [];
    // Keep each (parent instance, slot) intact, including empty/repeated slots.
    groupedSlots.push(entry);
    slotsByGroup.set(groupId, groupedSlots);
  }
  return GROUPS.flatMap((group) => {
    const slots = slotsByGroup.get(group.id);
    return slots?.length ? [{ ...group, anchor: { ...group.anchor }, slots }] : [];
  });
}

export function describeWeaponVisualSlot(entry: WeaponHotspotSlot): string {
  const parentName = entry.parentItem?.shortName || entry.parentItem?.name;
  const slotName = displayWeaponSlotName(entry.slot);
  return parentName ? `${parentName} › ${slotName}` : slotName;
}
