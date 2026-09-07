import type {
  CandidateSortKey,
  PartCandidateFilters,
} from "../features/modding/part-candidate-controls";

export const PART_FILTER_PRESETS_STORAGE_KEY = "tarkov-helper-web:part-filter-presets:v1";
export const MAX_PART_FILTER_PRESETS = 32;
export const MAX_PART_FILTER_PRESET_NAME_LENGTH = 60;

const MAX_STORAGE_BYTES = 128 * 1024;
const MAX_QUERY_LENGTH = 256;
const MAX_TRADER_ID_LENGTH = 128;
const PRESET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AVAILABILITIES = ["all", "compatible", "auto-resolvable", "blocked"] as const;
const PURCHASE_FILTERS = ["trader", "flea"] as const;
const EFFECT_FILTERS = ["recoil", "ergonomics", "lighter", "accuracy", "velocity"] as const;
const FEATURE_FILTERS = ["subslots", "required-slots"] as const;
const QUEST_FILTERS = ["all", "required", "not-required"] as const;
const SORT_KEYS: readonly CandidateSortKey[] = [
  "availability", "trader-price", "flea-price", "recoil", "ergonomics",
  "weight", "accuracy", "velocity", "loyalty-level", "name",
];
const FILTER_FIELDS = [
  "query", "availability", "purchaseFilters", "effectFilters", "featureFilters",
  "questRequirement", "traderId", "maxTraderPrice", "maxFleaPrice", "maxLoyaltyLevel",
];

/** A complete filter snapshot; sortKeys order is the user's priority order. */
export interface PartFilterPresetSettings {
  filters: PartCandidateFilters;
  sortKeys: CandidateSortKey[];
}

export interface NamedPartFilterPreset extends PartFilterPresetSettings {
  id: string;
  name: string;
}

type PresetInput = PartFilterPresetSettings & { name: string; id?: string };
type Failure = { ok: false; reason: "storage" | "invalid" | "limit" | "duplicate-name" | "not-found" };
type MutationResult = { ok: true; presets: NamedPartFilterPreset[] } | Failure;
type SaveResult = { ok: true; presets: NamedPartFilterPreset[]; preset: NamedPartFilterPreset } | Failure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}

function isPresetId(value: unknown): value is string {
  return typeof value === "string" && PRESET_ID.test(value);
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_STORAGE_BYTES) return null;
  const name = value.normalize("NFKC").trim();
  return name && name.length <= MAX_PART_FILTER_PRESET_NAME_LENGTH && !/\p{Cc}/u.test(name)
    ? name : null;
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum && !/\p{Cc}/u.test(value);
}

function choice<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : null;
}

function uniqueChoices<T extends string>(value: unknown, allowed: readonly T[]): T[] | null {
  if (!Array.isArray(value) || value.length > allowed.length) return null;
  const result: T[] = [];
  for (const entry of value) {
    const parsed = choice(entry, allowed);
    if (parsed === null || result.includes(parsed)) return null;
    result.push(parsed);
  }
  return result;
}

function optionalPrice(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function parseSettings(value: Record<string, unknown>): PartFilterPresetSettings | null {
  const filters = value.filters;
  if (!isRecord(filters) || !hasOnlyFields(filters, FILTER_FIELDS) ||
      !boundedText(filters.query, MAX_QUERY_LENGTH) || !boundedText(filters.traderId, MAX_TRADER_ID_LENGTH) ||
      !optionalPrice(filters.maxTraderPrice) || !optionalPrice(filters.maxFleaPrice)) return null;
  const loyalty = filters.maxLoyaltyLevel;
  if (loyalty !== undefined && (typeof loyalty !== "number" || !Number.isInteger(loyalty) || loyalty < 1 || loyalty > 4)) return null;
  const availability = choice(filters.availability, AVAILABILITIES);
  const questRequirement = choice(filters.questRequirement, QUEST_FILTERS);
  const purchaseFilters = uniqueChoices(filters.purchaseFilters, PURCHASE_FILTERS);
  const effectFilters = uniqueChoices(filters.effectFilters, EFFECT_FILTERS);
  const featureFilters = uniqueChoices(filters.featureFilters, FEATURE_FILTERS);
  const sortKeys = uniqueChoices(value.sortKeys, SORT_KEYS);
  if (availability === null || questRequirement === null || !purchaseFilters || !effectFilters || !featureFilters || !sortKeys) return null;
  return {
    filters: {
      query: filters.query,
      availability,
      purchaseFilters,
      effectFilters,
      featureFilters,
      questRequirement,
      traderId: filters.traderId,
      ...(filters.maxTraderPrice === undefined ? {} : { maxTraderPrice: filters.maxTraderPrice }),
      ...(filters.maxFleaPrice === undefined ? {} : { maxFleaPrice: filters.maxFleaPrice }),
      ...(loyalty === undefined ? {} : { maxLoyaltyLevel: loyalty }),
    },
    sortKeys,
  };
}

function parseInput(value: unknown): PresetInput | null {
  if (!isRecord(value) || !hasOnlyFields(value, ["id", "name", "filters", "sortKeys"])) return null;
  const name = normalizeName(value.name);
  const settings = parseSettings(value);
  const id = value.id;
  if (!name || !settings || (id !== undefined && !isPresetId(id))) return null;
  return { name, ...settings, ...(id === undefined ? {} : { id }) };
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

/** Reject the entire collection on damage or newer fields; never silently discard user saves. */
function readPresets(storage: Storage): NamedPartFilterPreset[] | null {
  try {
    const raw = storage.getItem(PART_FILTER_PRESETS_STORAGE_KEY);
    if (raw === null) return [];
    if (!withinStorageLimit(raw)) return null;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !hasOnlyFields(value, ["schemaVersion", "presets"]) ||
        value.schemaVersion !== 1 || !Array.isArray(value.presets) || value.presets.length > MAX_PART_FILTER_PRESETS) return null;
    const presets: NamedPartFilterPreset[] = [];
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const entry of value.presets) {
      const parsed = parseInput(entry);
      if (!parsed || !parsed.id || ids.has(parsed.id) || names.has(parsed.name.toLowerCase())) return null;
      ids.add(parsed.id);
      names.add(parsed.name.toLowerCase());
      presets.push({ ...parsed, id: parsed.id });
    }
    return presets;
  } catch {
    return null;
  }
}

function writePresets(storage: Storage, presets: NamedPartFilterPreset[]): MutationResult {
  try {
    const raw = JSON.stringify({ schemaVersion: 1, presets });
    if (!withinStorageLimit(raw)) return { ok: false, reason: "limit" };
    storage.setItem(PART_FILTER_PRESETS_STORAGE_KEY, raw);
    return { ok: true, presets };
  } catch {
    return { ok: false, reason: "storage" };
  }
}

/** ok:false is not an empty writable collection. No storage is changed by this read. */
export function loadPartFilterPresets(storage?: Storage | null): { ok: boolean; presets: NamedPartFilterPreset[] } {
  const target = browserStorage(storage);
  const presets = target ? readPresets(target) : null;
  return presets === null ? { ok: false, presets: [] } : { ok: true, presets };
}

/** Without id this creates a save; an explicit id must already exist and is replaced in place. */
export function savePartFilterPreset(input: PresetInput, storage?: Storage | null): SaveResult {
  let parsed: PresetInput | null;
  try {
    parsed = parseInput(input);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!parsed) return { ok: false, reason: "invalid" };
  const target = browserStorage(storage);
  // Read immediately before each mutation, not from an earlier UI snapshot.
  const presets = target ? readPresets(target) : null;
  if (!target || !presets) return { ok: false, reason: "storage" };
  const existingIndex = parsed.id === undefined ? -1 : presets.findIndex(({ id }) => id === parsed.id);
  if (parsed.id !== undefined && existingIndex < 0) return { ok: false, reason: "not-found" };
  if (presets.some((preset) => preset.id !== parsed.id && preset.name.toLowerCase() === parsed.name.toLowerCase())) {
    return { ok: false, reason: "duplicate-name" };
  }
  if (existingIndex < 0 && presets.length >= MAX_PART_FILTER_PRESETS) return { ok: false, reason: "limit" };
  let id: string;
  try {
    id = parsed.id ?? globalThis.crypto.randomUUID();
  } catch {
    return { ok: false, reason: "storage" };
  }
  if (!isPresetId(id) || (existingIndex < 0 && presets.some((preset) => preset.id === id))) return { ok: false, reason: "storage" };
  const preset: NamedPartFilterPreset = { ...parsed, id };
  if (existingIndex < 0) presets.push(preset);
  else presets[existingIndex] = preset;
  const result = writePresets(target, presets);
  // The selected preset must not share its editable arrays with the returned collection.
  return result.ok ? {
    ...result,
    preset: {
      ...preset,
      filters: {
        ...preset.filters,
        purchaseFilters: [...preset.filters.purchaseFilters],
        effectFilters: [...preset.filters.effectFilters],
        featureFilters: [...preset.filters.featureFilters],
      },
      sortKeys: [...preset.sortKeys],
    },
  } : result;
}

export function removePartFilterPreset(id: string, storage?: Storage | null): MutationResult {
  if (!isPresetId(id)) return { ok: false, reason: "invalid" };
  const target = browserStorage(storage);
  const presets = target ? readPresets(target) : null;
  if (!target || !presets) return { ok: false, reason: "storage" };
  if (!presets.some((preset) => preset.id === id)) return { ok: false, reason: "not-found" };
  return writePresets(target, presets.filter((preset) => preset.id !== id));
}
