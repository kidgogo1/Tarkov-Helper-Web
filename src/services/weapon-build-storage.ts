import type { BuildNode, WeaponBuild } from "../types/weapon-modding";

export const WEAPON_BUILD_STORAGE_KEY = "tarkov-helper-web:weapon-builds:v1";
export const MAX_SAVED_WEAPON_BUILDS = 32;

const STORAGE_SCHEMA_VERSION = 1;
const MAX_STORAGE_CHARACTERS = 1024 * 1024;
const MAX_BUILD_DEPTH = 32;
const MAX_BUILD_NODES = 512;
const MAX_INSTANCE_ID_LENGTH = 2048;
const MAX_DATA_VERSION_LENGTH = 128;
const TARKOV_ID_PATTERN = /^[0-9a-f]{24}$/;

interface StoredWeaponBuilds {
  schemaVersion: 1;
  builds: WeaponBuild[];
}

interface NodeSanitizationState {
  count: number;
  instanceIds: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTarkovId(value: unknown): value is string {
  return typeof value === "string" && TARKOV_ID_PATTERN.test(value);
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength
  );
}

function sanitizeBuildNode(
  value: unknown,
  depth: number,
  isRoot: boolean,
  state: NodeSanitizationState,
): BuildNode | null {
  if (
    !isRecord(value) ||
    depth > MAX_BUILD_DEPTH ||
    state.count >= MAX_BUILD_NODES ||
    !isBoundedString(value.instanceId, MAX_INSTANCE_ID_LENGTH) ||
    !isTarkovId(value.itemId) ||
    !Array.isArray(value.children)
  ) {
    return null;
  }

  const slotId = value.slotId;
  if (!isRoot && !isTarkovId(slotId)) return null;
  if (value.children.length > MAX_BUILD_NODES) return null;
  if (state.instanceIds.has(value.instanceId)) return null;

  state.count += 1;
  state.instanceIds.add(value.instanceId);

  const children: BuildNode[] = [];
  const occupiedSlots = new Set<string>();
  for (const childValue of value.children) {
    const child = sanitizeBuildNode(childValue, depth + 1, false, state);
    if (!child?.slotId || occupiedSlots.has(child.slotId)) return null;
    occupiedSlots.add(child.slotId);
    children.push(child);
  }

  return isRoot
    ? {
        instanceId: value.instanceId,
        itemId: value.itemId,
        children,
      }
    : {
        instanceId: value.instanceId,
        itemId: value.itemId,
        slotId: slotId as string,
        children,
      };
}

export function sanitizeWeaponBuild(value: unknown): WeaponBuild | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== STORAGE_SCHEMA_VERSION ||
    !isBoundedString(value.catalogDataVersion, MAX_DATA_VERSION_LENGTH) ||
    !isTarkovId(value.weaponId)
  ) {
    return null;
  }

  const root = sanitizeBuildNode(value.root, 0, true, {
    count: 0,
    instanceIds: new Set(),
  });
  if (!root || root.itemId !== value.weaponId) return null;

  return {
    schemaVersion: 1,
    catalogDataVersion: value.catalogDataVersion,
    weaponId: value.weaponId,
    root,
  };
}

function browserStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Only an absent key is an empty store. Unreadable existing data must remain untouched. */
function parseStoredBuilds(raw: string | null): WeaponBuild[] | null {
  if (raw === null) return [];
  if (!raw || raw.length > MAX_STORAGE_CHARACTERS) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== STORAGE_SCHEMA_VERSION ||
    !Array.isArray(value.builds) ||
    value.builds.length > MAX_SAVED_WEAPON_BUILDS
  ) {
    return null;
  }

  const builds: WeaponBuild[] = [];
  const weaponIds = new Set<string>();
  for (const candidate of value.builds) {
    const build = sanitizeWeaponBuild(candidate);
    if (!build || weaponIds.has(build.weaponId)) return null;
    weaponIds.add(build.weaponId);
    builds.push(build);
    if (builds.length >= MAX_SAVED_WEAPON_BUILDS) break;
  }
  return builds;
}

function readStoredBuilds(
  storage: Storage,
): { ok: true; builds: WeaponBuild[] } | { ok: false; builds: [] } {
  try {
    const builds = parseStoredBuilds(storage.getItem(WEAPON_BUILD_STORAGE_KEY));
    return builds === null ? { ok: false, builds: [] } : { ok: true, builds };
  } catch {
    return { ok: false, builds: [] };
  }
}

function writeStoredBuilds(storage: Storage, builds: WeaponBuild[]): boolean {
  try {
    if (builds.length === 0) {
      storage.removeItem(WEAPON_BUILD_STORAGE_KEY);
      return true;
    }
    const payload: StoredWeaponBuilds = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      builds: builds.slice(0, MAX_SAVED_WEAPON_BUILDS),
    };
    const serialized = JSON.stringify(payload);
    if (serialized.length > MAX_STORAGE_CHARACTERS) return false;
    storage.setItem(WEAPON_BUILD_STORAGE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

export function loadWeaponBuild(
  weaponId: string,
  storage?: Storage | null,
): WeaponBuild | null {
  if (!isTarkovId(weaponId)) return null;
  const target = browserStorage(storage);
  if (!target) return null;
  const stored = readStoredBuilds(target);
  if (!stored.ok) return null;
  return stored.builds.find((build) => build.weaponId === weaponId) ?? null;
}

export function saveWeaponBuild(
  build: WeaponBuild,
  storage?: Storage | null,
): boolean {
  const sanitized = sanitizeWeaponBuild(build);
  const target = browserStorage(storage);
  if (!sanitized || !target) return false;

  const stored = readStoredBuilds(target);
  if (!stored.ok) return false;
  const existing = stored.builds.filter(
    (candidate) => candidate.weaponId !== sanitized.weaponId,
  );
  return writeStoredBuilds(target, [sanitized, ...existing]);
}

export function resetWeaponBuild(
  weaponId: string,
  storage?: Storage | null,
): boolean {
  if (!isTarkovId(weaponId)) return false;
  const target = browserStorage(storage);
  if (!target) return false;
  const stored = readStoredBuilds(target);
  if (!stored.ok) return false;
  const remaining = stored.builds.filter(
    (build) => build.weaponId !== weaponId,
  );
  return writeStoredBuilds(target, remaining);
}
