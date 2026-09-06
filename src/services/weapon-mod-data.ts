import type {
  FleaMarketSnapshot,
  FleaMarketSnapshots,
  FactoryPresetNode,
  TraderOffer,
  TraderOffersByProfile,
  WeaponBaseStats,
  WeaponCatalog,
  WeaponCatalogItem,
  WeaponConflictRule,
  WeaponPartStats,
  WeaponSlotRule,
} from "../types/weapon-modding";

const CATALOG_URL = `${import.meta.env.BASE_URL}data/weapon-modding/catalog.json`;
const ITEM_ID_PATTERN = /^[0-9a-f]{24}$/;
const MAX_NUMBER = 2_000_000_000;
const catalogCache = new WeakMap<typeof fetch, WeaponCatalog>();
const catalogRequests = new WeakMap<typeof fetch, Promise<WeaponCatalog>>();

export type WeaponModCatalogFailureCode =
  | "REQUEST_FAILED"
  | "INVALID_RESPONSE"
  | "UNSUPPORTED_SCHEMA";

export type WeaponModCatalogFailureHandler = (code: WeaponModCatalogFailureCode) => void;

export const EMPTY_WEAPON_MOD_CATALOG: WeaponCatalog = {
  schemaVersion: 1,
  dataVersion: "unavailable",
  items: [],
  weaponIds: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown, maximum = 400): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ITEM_ID_PATTERN.test(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_NUMBER;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_NUMBER;
}

function parseIdArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => !isId(entry))) return null;
  const values = value as string[];
  return new Set(values).size === values.length ? values : null;
}

function parseWeaponStats(value: unknown): WeaponBaseStats | null {
  if (!isRecord(value)) return null;
  const keys = ["verticalRecoil", "horizontalRecoil", "ergonomics", "weight", "centerOfImpact"];
  if (Object.keys(value).some((key) => !keys.includes(key))) return null;
  if (!["verticalRecoil", "horizontalRecoil", "ergonomics", "weight"].every(
    (key) => isNumber(value[key]),
  )) return null;
  if (Object.values(value).some((entry) => !isNumber(entry))) return null;
  return value as unknown as WeaponBaseStats;
}

function parsePartStats(value: unknown): WeaponPartStats | null {
  if (!isRecord(value)) return null;
  const keys = [
    "recoilModifier",
    "ergonomics",
    "weight",
    "centerOfImpact",
    "muzzleVelocityModifier",
  ];
  if (Object.keys(value).some((key) => !keys.includes(key)) ||
      Object.values(value).some((entry) => !isNumber(entry))) return null;
  return value as unknown as WeaponPartStats;
}

function parseSlot(value: unknown): WeaponSlotRule | null {
  if (!isRecord(value) || !isId(value.id) || !isText(value.name)) return null;
  const allowedItemIds = value.allowedItemIds === undefined ? undefined : parseIdArray(value.allowedItemIds);
  const allowedCategories = value.allowedCategories === undefined ? undefined : parseIdArray(value.allowedCategories);
  const excludedItemIds = value.excludedItemIds === undefined ? undefined : parseIdArray(value.excludedItemIds);
  const excludedCategories = value.excludedCategories === undefined ? undefined : parseIdArray(value.excludedCategories);
  if ([allowedItemIds, allowedCategories, excludedItemIds, excludedCategories].some((entry, index) =>
    entry === null && [value.allowedItemIds, value.allowedCategories, value.excludedItemIds, value.excludedCategories][index] !== undefined
  )) return null;
  if (value.required !== undefined && typeof value.required !== "boolean") return null;
  return value as unknown as WeaponSlotRule;
}

function parseConflicts(value: unknown): WeaponConflictRule | null {
  if (!isRecord(value)) return null;
  for (const key of ["itemIds", "categories", "slotIds"] as const) {
    if (value[key] !== undefined && !parseIdArray(value[key])) return null;
  }
  return value as unknown as WeaponConflictRule;
}

function parseTraderOffer(value: unknown): TraderOffer | null {
  if (!isRecord(value) || !isId(value.traderId) || !isText(value.traderName) ||
      !isNonNegativeInteger(value.price) || !isText(value.currency, 12) ||
      !isNonNegativeInteger(value.loyaltyLevel) ||
      (value.priceRoubles !== undefined && !isNonNegativeInteger(value.priceRoubles))) return null;
  if (value.questUnlock !== undefined) {
    if (!isRecord(value.questUnlock) || !isId(value.questUnlock.questId) ||
        !isText(value.questUnlock.questName) ||
        (value.questUnlock.minimumPlayerLevel !== undefined &&
          !isNonNegativeInteger(value.questUnlock.minimumPlayerLevel))) return null;
  }
  return value as unknown as TraderOffer;
}

function parseTraderOffersByProfile(value: unknown): TraderOffersByProfile | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "pvp" && key !== "pve")) {
    return null;
  }
  for (const profile of ["pvp", "pve"] as const) {
    const offers = value[profile];
    if (offers !== undefined && (!Array.isArray(offers) || offers.some((offer) => !parseTraderOffer(offer)))) {
      return null;
    }
  }
  return value as unknown as TraderOffersByProfile;
}

function parseFactoryPresetNodes(
  value: unknown,
  depth = 0,
  counter = { count: 0 },
): FactoryPresetNode[] | null {
  if (!Array.isArray(value) || depth > 32) return null;
  const slotIds = new Set<string>();
  const nodes: FactoryPresetNode[] = [];
  for (const entry of value) {
    counter.count += 1;
    if (counter.count > 512 || !isRecord(entry) || !isId(entry.itemId) ||
        !isId(entry.slotId) || slotIds.has(entry.slotId)) return null;
    slotIds.add(entry.slotId);
    const children = parseFactoryPresetNodes(entry.children, depth + 1, counter);
    if (!children) return null;
    nodes.push({ itemId: entry.itemId, slotId: entry.slotId, children });
  }
  return nodes;
}

function parseFlea(value: unknown): FleaMarketSnapshot | null {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "price", "currency", "updatedAt", "minimumPlayerLevel", "lowPrice", "average24h",
  ].includes(key)) || !isNonNegativeInteger(value.price) || value.currency !== "RUB" ||
      !isText(value.updatedAt) || !Number.isFinite(Date.parse(value.updatedAt)) ||
      (value.minimumPlayerLevel !== undefined &&
        (!isNonNegativeInteger(value.minimumPlayerLevel) ||
          value.minimumPlayerLevel < 1 || value.minimumPlayerLevel > 100)) ||
      (value.lowPrice !== undefined && !isNonNegativeInteger(value.lowPrice)) ||
      (value.average24h !== undefined && !isNonNegativeInteger(value.average24h))) return null;
  return value as unknown as FleaMarketSnapshot;
}

function parseFleaByProfile(value: unknown): FleaMarketSnapshots | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "pvp" && key !== "pve")) {
    return null;
  }
  if ((value.pvp !== undefined && !parseFlea(value.pvp)) ||
      (value.pve !== undefined && !parseFlea(value.pve))) return null;
  return value as unknown as FleaMarketSnapshots;
}

function isAssetUrl(value: unknown, itemId: string): value is string {
  if (!isText(value, 500)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "assets.tarkov.dev" &&
      url.pathname.startsWith(`/${itemId}-`);
  } catch {
    return false;
  }
}

function parseItem(value: unknown): WeaponCatalogItem | null {
  if (!isRecord(value) || !isId(value.id) || !isText(value.name) ||
      !["weapon", "part"].includes(String(value.kind))) return null;
  const categories = parseIdArray(value.categories);
  if (!categories || (value.nameEn !== undefined && !isText(value.nameEn)) ||
      (value.nameKo !== undefined && !isText(value.nameKo)) ||
      (value.shortName !== undefined && !isText(value.shortName)) ||
      (value.imageUrl !== undefined && !isAssetUrl(value.imageUrl, value.id)) ||
      (value.iconUrl !== undefined && !isAssetUrl(value.iconUrl, value.id))) return null;
  if (value.slots !== undefined && (!Array.isArray(value.slots) || value.slots.some((slot) => !parseSlot(slot)))) return null;
  if (value.factoryPartIds !== undefined && !parseIdArray(value.factoryPartIds)) return null;
  if (value.factoryPartsByParent !== undefined) {
    if (!isRecord(value.factoryPartsByParent)) return null;
    for (const [parentId, childIds] of Object.entries(value.factoryPartsByParent)) {
      if (!isId(parentId) || !parseIdArray(childIds)) return null;
    }
  }
  if (value.factoryPresetBuild !== undefined && !parseFactoryPresetNodes(value.factoryPresetBuild)) {
    return null;
  }
  if (value.conflicts !== undefined && !parseConflicts(value.conflicts)) return null;
  if (value.traderOffers !== undefined && (!Array.isArray(value.traderOffers) ||
      value.traderOffers.some((offer) => !parseTraderOffer(offer)))) return null;
  if (value.traderOffersByProfile !== undefined &&
      !parseTraderOffersByProfile(value.traderOffersByProfile)) return null;
  if (value.flea !== undefined && !parseFlea(value.flea)) return null;
  if (value.fleaByProfile !== undefined && !parseFleaByProfile(value.fleaByProfile)) return null;
  if (value.kind === "weapon") {
    if (!Array.isArray(value.slots) || !Array.isArray(value.factoryPartIds) ||
        !parseWeaponStats(value.baseStats) || value.stats !== undefined ||
        (value.factoryPresetId !== undefined && !isId(value.factoryPresetId)) ||
        (value.factoryTraderOffersByProfile !== undefined &&
          (!isId(value.factoryPresetId) || !parseTraderOffersByProfile(value.factoryTraderOffersByProfile))) ||
        (value.factoryPriceUpdatedAt !== undefined &&
          (!isId(value.factoryPresetId) || !isText(value.factoryPriceUpdatedAt) ||
            !Number.isFinite(Date.parse(value.factoryPriceUpdatedAt)) ||
            new Date(value.factoryPriceUpdatedAt).toISOString() !== value.factoryPriceUpdatedAt)) ||
        (value.factoryImageUrl !== undefined &&
          (!isId(value.factoryPresetId) || !isAssetUrl(value.factoryImageUrl, value.factoryPresetId)))) return null;
  } else if ((value.stats !== undefined && !parsePartStats(value.stats)) ||
      value.baseStats !== undefined || value.factoryPartsByParent !== undefined ||
      value.factoryPresetBuild !== undefined || value.factoryPresetId !== undefined ||
      value.factoryImageUrl !== undefined || value.factoryTraderOffersByProfile !== undefined ||
      value.factoryPriceUpdatedAt !== undefined) {
    return null;
  }
  return value as unknown as WeaponCatalogItem;
}

export function parseWeaponModCatalog(value: unknown): WeaponCatalog | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isText(value.dataVersion) ||
      !Array.isArray(value.items)) return null;
  const weaponIds = parseIdArray(value.weaponIds);
  const items = value.items.map(parseItem);
  if (!weaponIds || items.some((item) => item === null) || items.length > 10_000) return null;
  const parsedItems = items as WeaponCatalogItem[];
  const byId = new Map(parsedItems.map((item) => [item.id, item]));
  const factoryNodesAreParts = (nodes: readonly FactoryPresetNode[]): boolean =>
    nodes.every((node) => byId.get(node.itemId)?.kind === "part" &&
      factoryNodesAreParts(node.children));
  if (byId.size !== parsedItems.length || weaponIds.some((id) => byId.get(id)?.kind !== "weapon") ||
      parsedItems.some((item) => item.kind === "weapon" && !weaponIds.includes(item.id)) ||
      parsedItems.some((item) => item.factoryPartIds?.some((id) => byId.get(id)?.kind !== "part")) ||
      parsedItems.some((item) => item.kind === "weapon" && item.factoryPartsByParent &&
        Object.entries(item.factoryPartsByParent).some(([parentId, childIds]) =>
          !byId.has(parentId) || childIds.some((id) => byId.get(id)?.kind !== "part")
        )) ||
      parsedItems.some((item) => item.kind === "weapon" && item.factoryPresetBuild &&
        !factoryNodesAreParts(item.factoryPresetBuild))) return null;
  return { schemaVersion: 1, dataVersion: value.dataVersion, items: parsedItems, weaponIds };
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}

function report(onFailure: WeaponModCatalogFailureHandler | undefined, code: WeaponModCatalogFailureCode): void {
  try { onFailure?.(code); } catch { /* Diagnostics must not break the fallback. */ }
}

async function requestWeaponModCatalog(
  request: typeof fetch,
  onFailure?: WeaponModCatalogFailureHandler,
): Promise<WeaponCatalog> {
  try {
    const response = await request(CATALOG_URL, {
      cache: "default",
      headers: { Accept: "application/json" },
      signal: undefined,
    });
    if (!response.ok) {
      report(onFailure, "REQUEST_FAILED");
      return EMPTY_WEAPON_MOD_CATALOG;
    }
    const payload = await response.json() as unknown;
    if (isRecord(payload) && payload.schemaVersion !== 1) {
      report(onFailure, "UNSUPPORTED_SCHEMA");
      return EMPTY_WEAPON_MOD_CATALOG;
    }
    const catalog = parseWeaponModCatalog(payload);
    if (!catalog) report(onFailure, "INVALID_RESPONSE");
    return catalog ?? EMPTY_WEAPON_MOD_CATALOG;
  } catch (error: unknown) {
    if (isAbort(error)) throw error;
    report(onFailure, "REQUEST_FAILED");
    return EMPTY_WEAPON_MOD_CATALOG;
  }
}

function withCallerAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function loadWeaponModCatalog(
  signal?: AbortSignal,
  request: typeof fetch = fetch,
  onFailure?: WeaponModCatalogFailureHandler,
): Promise<WeaponCatalog> {
  const cached = catalogCache.get(request);
  if (cached) return withCallerAbort(Promise.resolve(cached), signal);
  let pending = catalogRequests.get(request);
  if (!pending) {
    pending = requestWeaponModCatalog(request, onFailure)
      .then((catalog) => {
        if (catalog !== EMPTY_WEAPON_MOD_CATALOG) catalogCache.set(request, catalog);
        return catalog;
      })
      .finally(() => catalogRequests.delete(request));
    catalogRequests.set(request, pending);
  }
  return withCallerAbort(pending, signal);
}
