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

const MIN_X = 8;
const MAX_X = 92;
const MIN_Y = 8;
const MAX_Y = 92;
const MIN_HORIZONTAL_CLEARANCE = 12;
const MIN_VERTICAL_CLEARANCE = 9;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function layoutWeaponHotspots(
  slots: readonly WeaponSlotRule[],
): Array<{ x: number; y: number }> {
  const usedPositionKeys = new Set<string>();
  const usedPositions: Array<{ x: number; y: number }> = [];
  return slots.map((slot, index) => {
    const base = slotPosition(slot, index);
    const maximumAttempts = Math.max(256, slots.length * 32);
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const position = offsetPosition(base, attempt);
      const key = positionKey(position);
      if (
        usedPositionKeys.has(key) ||
        usedPositions.some((used) => !hasLabelClearance(position, used))
      ) continue;
      usedPositionKeys.add(key);
      usedPositions.push(position);
      return position;
    }
    const fallback = fallbackPosition(usedPositionKeys, slots.length);
    usedPositions.push(fallback);
    return fallback;
  });
}

function hasLabelClearance(
  left: { x: number; y: number },
  right: { x: number; y: number },
): boolean {
  return Math.abs(left.x - right.x) >= MIN_HORIZONTAL_CLEARANCE ||
    Math.abs(left.y - right.y) >= MIN_VERTICAL_CLEARANCE;
}

function offsetPosition(
  base: { x: number; y: number },
  attempt: number,
): { x: number; y: number } {
  if (attempt === 0) {
    return {
      x: round(clamp(base.x, MIN_X, MAX_X)),
      y: round(clamp(base.y, MIN_Y, MAX_Y)),
    };
  }
  const radius = 7 * Math.sqrt(attempt);
  const angle = attempt * GOLDEN_ANGLE;
  return {
    x: round(clamp(base.x + Math.cos(angle) * radius, MIN_X, MAX_X)),
    y: round(clamp(base.y + Math.sin(angle) * radius, MIN_Y, MAX_Y)),
  };
}

function fallbackPosition(
  usedPositions: Set<string>,
  slotCount: number,
): { x: number; y: number } {
  const dimension = Math.ceil(Math.sqrt(Math.max(4, slotCount * 4)));
  for (let index = 0; index < dimension * dimension; index += 1) {
    const position = {
      x: round(MIN_X + ((index % dimension) + 0.5) * (MAX_X - MIN_X) / dimension),
      y: round(MIN_Y + (Math.floor(index / dimension) + 0.5) * (MAX_Y - MIN_Y) / dimension),
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
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
