import type { WeaponBuild } from "../types/weapon-modding";
import { sanitizeWeaponBuild } from "./weapon-build-storage";

export const MODDING_LIBRARY_STORAGE_KEY = "tarkov-helper-web:weapon-modding-library:v1";
export const MAX_NAMED_WEAPON_PRESETS = 64;
export const MAX_FAVORITE_WEAPONS = 256;
export const MAX_WEAPON_PRESET_NAME_LENGTH = 80;

const MAX_STORAGE_BYTES = 1024 * 1024;
const TARKOV_ID = /^[0-9a-f]{24}$/;
const PRESET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface NamedWeaponPreset {
  id: string;
  name: string;
  build: WeaponBuild;
  updatedAt: string;
}

export interface ModdingLibrary {
  presets: NamedWeaponPreset[];
  favoriteWeaponIds: string[];
}

export type ModdingLibraryFailureReason = "storage" | "invalid" | "limit" | "duplicate-name" | "not-found";
export type ModdingLibraryMutationResult =
  | { ok: true; library: ModdingLibrary }
  | { ok: false; reason: ModdingLibraryFailureReason };
export type SaveNamedWeaponPresetResult =
  | { ok: true; library: ModdingLibrary; preset: NamedWeaponPreset }
  | { ok: false; reason: ModdingLibraryFailureReason };

function emptyLibrary(): ModdingLibrary {
  return { presets: [], favoriteWeaponIds: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_STORAGE_BYTES) return null;
  const name = value.normalize("NFKC").trim();
  if (!name || name.length > MAX_WEAPON_PRESET_NAME_LENGTH || /\p{Cc}/u.test(name)) return null;
  return name;
}

function isPresetId(value: unknown): value is string {
  return typeof value === "string" && PRESET_ID.test(value);
}

function isWeaponId(value: unknown): value is string {
  return typeof value === "string" && TARKOV_ID.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

function withinStorageLimit(raw: string): boolean {
  return raw.length <= MAX_STORAGE_BYTES && new TextEncoder().encode(raw).byteLength <= MAX_STORAGE_BYTES;
}

function browserStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Reject a damaged library as a whole rather than silently dropping user-named saves. */
function parseLibrary(raw: string | null): ModdingLibrary | null {
  if (raw === null) return emptyLibrary();
  if (!withinStorageLimit(raw)) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.schemaVersion !== 1 ||
      !Array.isArray(value.presets) || value.presets.length > MAX_NAMED_WEAPON_PRESETS ||
      !Array.isArray(value.favoriteWeaponIds) || value.favoriteWeaponIds.length > MAX_FAVORITE_WEAPONS) return null;

  const presets: NamedWeaponPreset[] = [];
  const ids = new Set<string>();
  const namesByWeapon = new Set<string>();
  for (const candidate of value.presets) {
    if (!isRecord(candidate) || !isPresetId(candidate.id) ||
        ids.has(candidate.id) || !isIsoTimestamp(candidate.updatedAt)) return null;
    const name = normalizeName(candidate.name);
    const build = sanitizeWeaponBuild(candidate.build);
    if (!name || !build) return null;
    const nameKey = `${build.weaponId}:${name.toLowerCase()}`;
    if (namesByWeapon.has(nameKey)) return null;
    ids.add(candidate.id);
    namesByWeapon.add(nameKey);
    presets.push({ id: candidate.id, name, build, updatedAt: candidate.updatedAt });
  }

  if (!value.favoriteWeaponIds.every(isWeaponId)) return null;
  return { presets, favoriteWeaponIds: [...new Set<string>(value.favoriteWeaponIds)] };
}

function readLibrary(storage: Storage): ModdingLibrary | null {
  try {
    return parseLibrary(storage.getItem(MODDING_LIBRARY_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeLibrary(storage: Storage, library: ModdingLibrary): ModdingLibraryMutationResult {
  try {
    const raw = JSON.stringify({ schemaVersion: 1, ...library });
    if (!withinStorageLimit(raw)) return { ok: false, reason: "limit" };
    storage.setItem(MODDING_LIBRARY_STORAGE_KEY, raw);
    return { ok: true, library };
  } catch {
    return { ok: false, reason: "storage" };
  }
}

/** A failed load must not be treated as an empty writable library. */
export function loadModdingLibrary(storage?: Storage | null): { ok: boolean; library: ModdingLibrary } {
  const target = browserStorage(storage);
  const library = target ? readLibrary(target) : null;
  return library ? { ok: true, library } : { ok: false, library: emptyLibrary() };
}

/** Saves a cloned, structural snapshot; purchase prices and profile state are never persisted. */
export function saveNamedWeaponPreset(
  input: { name: string; build: WeaponBuild; id?: string },
  storage?: Storage | null,
): SaveNamedWeaponPresetResult {
  const name = normalizeName(input?.name);
  const build = sanitizeWeaponBuild(input?.build);
  if (!name || !build || (input.id !== undefined && !isPresetId(input.id))) return { ok: false, reason: "invalid" };
  const target = browserStorage(storage);
  const library = target ? readLibrary(target) : null;
  if (!target || !library) return { ok: false, reason: "storage" };

  const existingIndex = input.id === undefined ? -1 : library.presets.findIndex(({ id }) => id === input.id);
  if (input.id !== undefined && existingIndex < 0) return { ok: false, reason: "not-found" };
  if (existingIndex >= 0 && library.presets[existingIndex].build.weaponId !== build.weaponId) return { ok: false, reason: "invalid" };
  if (library.presets.some((preset) => preset.id !== input.id &&
      preset.build.weaponId === build.weaponId && preset.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, reason: "duplicate-name" };
  }
  if (existingIndex < 0 && library.presets.length >= MAX_NAMED_WEAPON_PRESETS) return { ok: false, reason: "limit" };

  let id: string;
  try {
    id = input.id ?? globalThis.crypto.randomUUID();
  } catch {
    return { ok: false, reason: "storage" };
  }
  if (!isPresetId(id) || (existingIndex < 0 && library.presets.some((preset) => preset.id === id))) {
    return { ok: false, reason: "storage" };
  }
  const preset: NamedWeaponPreset = { id, name, build, updatedAt: new Date().toISOString() };
  if (existingIndex < 0) library.presets.push(preset);
  else library.presets[existingIndex] = preset;
  const result = writeLibrary(target, library);
  return result.ok ? { ...result, preset } : result;
}

export function removeNamedWeaponPreset(id: string, storage?: Storage | null): ModdingLibraryMutationResult {
  if (!isPresetId(id)) return { ok: false, reason: "invalid" };
  const target = browserStorage(storage);
  const library = target ? readLibrary(target) : null;
  if (!target || !library) return { ok: false, reason: "storage" };
  if (!library.presets.some((preset) => preset.id === id)) return { ok: false, reason: "not-found" };
  return writeLibrary(target, { ...library, presets: library.presets.filter((preset) => preset.id !== id) });
}

export function setFavoriteWeapon(
  weaponId: string,
  enabled: boolean,
  storage?: Storage | null,
): ModdingLibraryMutationResult {
  if (!isWeaponId(weaponId) || typeof enabled !== "boolean") return { ok: false, reason: "invalid" };
  const target = browserStorage(storage);
  const library = target ? readLibrary(target) : null;
  if (!target || !library) return { ok: false, reason: "storage" };
  const alreadyFavorite = library.favoriteWeaponIds.includes(weaponId);
  if (enabled && !alreadyFavorite && library.favoriteWeaponIds.length >= MAX_FAVORITE_WEAPONS) return { ok: false, reason: "limit" };
  if (alreadyFavorite === enabled) return { ok: true, library };
  const favoriteWeaponIds = enabled
    ? [...library.favoriteWeaponIds, weaponId]
    : library.favoriteWeaponIds.filter((id) => id !== weaponId);
  return writeLibrary(target, { ...library, favoriteWeaponIds });
}
