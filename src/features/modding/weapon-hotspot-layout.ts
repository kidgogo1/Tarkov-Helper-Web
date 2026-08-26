import type { WeaponSlotRule } from "../../types/weapon-modding";

const SLOT_POSITIONS: ReadonlyArray<{
  match: RegExp;
  x: number;
  y: number;
}> = [
  { match: /muzzle|총구/, x: 8, y: 55 },
  { match: /barrel|총열/, x: 22, y: 48 },
  { match: /handguard|foregrip|핸드가드|전방/, x: 35, y: 66 },
  { match: /gas.?block|가스/, x: 36, y: 34 },
  { match: /scope|sight|optic|조준/, x: 55, y: 23 },
  { match: /receiver|reciever|리시버|총몸/, x: 53, y: 43 },
  { match: /magazine|탄창/, x: 58, y: 76 },
  { match: /pistol.?grip|권총.*손잡이/, x: 67, y: 71 },
  { match: /charge|charging|장전/, x: 69, y: 32 },
  { match: /stock|개머리판/, x: 86, y: 48 },
  { match: /tactical|전술/, x: 38, y: 26 },
];

const DUPLICATE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0, 13],
  [0, -13],
  [11, 9],
  [-11, 9],
  [11, -9],
  [-11, -9],
];

export function layoutWeaponHotspots(
  slots: readonly WeaponSlotRule[],
): Array<{ x: number; y: number }> {
  const occurrences = new Map<string, number>();
  return slots.map((slot, index) => {
    const base = slotPosition(slot, index);
    const positionKey = `${base.x}:${base.y}`;
    const occurrence = occurrences.get(positionKey) ?? 0;
    occurrences.set(positionKey, occurrence + 1);
    const [offsetX, offsetY] = DUPLICATE_OFFSETS[
      Math.min(occurrence, DUPLICATE_OFFSETS.length - 1)
    ];
    return {
      x: Math.max(5, Math.min(95, base.x + offsetX)),
      y: Math.max(8, Math.min(92, base.y + offsetY)),
    };
  });
}

function slotPosition(slot: WeaponSlotRule, index: number): { x: number; y: number } {
  const key = `${slot.id} ${slot.name}`.toLocaleLowerCase();
  return SLOT_POSITIONS.find(({ match }) => match.test(key)) ?? {
    x: 16 + (index % 6) * 13,
    y: 88 - Math.floor(index / 6) * 10,
  };
}
