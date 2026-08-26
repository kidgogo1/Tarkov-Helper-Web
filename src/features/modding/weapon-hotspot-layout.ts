import type { WeaponSlotRule } from "../../types/weapon-modding";

const SLOT_POSITIONS: ReadonlyArray<{
  match: RegExp;
  x: number;
  y: number;
}> = [
  { match: /under.?barrel|grenade.*launcher|유탄/, x: 30, y: 82 },
  { match: /handguard|foregrip|핸드가드|총열\s*덮개|전방/, x: 35, y: 66 },
  { match: /muzzle|총구/, x: 8, y: 55 },
  { match: /barrel|총열/, x: 22, y: 48 },
  { match: /gas.?block|가스/, x: 36, y: 34 },
  { match: /front.?sight|가늠쇠/, x: 42, y: 25 },
  { match: /rear.?sight|가늠자/, x: 61, y: 25 },
  { match: /mount|rail|마운트|레일/, x: 50, y: 16 },
  { match: /scope|sight|optic|조준/, x: 55, y: 23 },
  { match: /receiver|reciever|리시버|총기\s*몸체|총몸/, x: 53, y: 43 },
  { match: /magazine|탄창/, x: 58, y: 76 },
  { match: /pistol.?grip|권총.*손잡이/, x: 67, y: 71 },
  { match: /trigger|방아쇠/, x: 65, y: 59 },
  { match: /charge|charging|장전/, x: 69, y: 32 },
  { match: /stock|개머리판/, x: 86, y: 48 },
  { match: /bipod|양각대/, x: 27, y: 84 },
  { match: /tactical|전술/, x: 38, y: 26 },
];

// The visible workbench is never narrower than 500px while hotspots are shown.
// Four columns keep the fixed 112px labels apart at that minimum width; the
// eight rows likewise clear the fixed 42px label height in the 390px stage.
const HOTSPOT_COLUMNS = [12, 37, 63, 88] as const;
const HOTSPOT_ROWS = [8, 20, 32, 44, 56, 68, 80, 92] as const;
const HOTSPOT_GRID = HOTSPOT_ROWS.flatMap((y) =>
  HOTSPOT_COLUMNS.map((x) => ({ x, y })),
);

export function layoutWeaponHotspots(
  slots: readonly WeaponSlotRule[],
): Array<{ x: number; y: number }> {
  const usedPositionKeys = new Set<string>();
  return slots.map((slot, index) => {
    const base = slotPosition(slot, index);
    const position = HOTSPOT_GRID
      .filter((candidate) => !usedPositionKeys.has(positionKey(candidate)))
      .sort((left, right) => distanceSquared(left, base) - distanceSquared(right, base))[0]
      ?? fallbackPosition(usedPositionKeys, slots.length);
    usedPositionKeys.add(positionKey(position));
    return position;
  });
}

function distanceSquared(
  left: { x: number; y: number },
  right: { x: number; y: number },
): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2;
}

function fallbackPosition(
  usedPositions: Set<string>,
  slotCount: number,
): { x: number; y: number } {
  const dimension = Math.ceil(Math.sqrt(Math.max(4, slotCount * 4)));
  for (let index = 0; index < dimension * dimension; index += 1) {
    const position = {
      x: round(12 + ((index % dimension) + 0.5) * 76 / dimension),
      y: round(8 + (Math.floor(index / dimension) + 0.5) * 84 / dimension),
    };
    const key = positionKey(position);
    if (usedPositions.has(key)) continue;
    usedPositions.add(key);
    return position;
  }
  throw new Error("Unable to allocate a unique weapon hotspot position.");
}

function positionKey(position: { x: number; y: number }): string {
  return `${position.x}:${position.y}`;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function slotPosition(slot: WeaponSlotRule, index: number): { x: number; y: number } {
  const key = `${slot.id} ${slot.name}`.toLocaleLowerCase();
  const preferred = SLOT_POSITIONS.find(({ match }) => match.test(key));
  return preferred ? { x: preferred.x, y: preferred.y } : {
    x: 16 + (index % 6) * 13,
    y: 88 - Math.floor(index / 6) * 10,
  };
}
