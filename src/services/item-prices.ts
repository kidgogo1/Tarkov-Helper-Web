import type { ProfileType } from "../types/data";
import type {
  ItemPriceCatalog,
  ItemPriceCatalogItem,
  ItemPriceSnapshot,
  LiveItemPriceQuote,
} from "../types/prices";

const CATALOG_URL = `${import.meta.env.BASE_URL}data/item-price-catalog.json`;
const ITEM_ID_PATTERN = /^[0-9a-f]{24}$/;
const LOCAL_ICON_PATTERN = /^assets\/items\/[A-Za-z0-9._-]+\.(?:png|webp|svg)$/;
const MAX_PRICE = 2_000_000_000;

export type ItemPriceFailureCode = "INVALID_RESPONSE" | "REQUEST_FAILED";
export type ItemPriceCatalogFailureHandler = (code: ItemPriceFailureCode) => void;
export type ItemPriceQuoteFailureCode = ItemPriceFailureCode;
export type ItemPriceQuoteFailureHandler = (code: ItemPriceQuoteFailureCode) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedText(value: unknown, maximum = 400): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isFixedLink(value: unknown, hostname: string, prefix: string): value is string {
  if (!isBoundedText(value, 500)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === hostname && url.pathname.startsWith(prefix);
  } catch {
    return false;
  }
}

function isNullableNumber(value: unknown, integer = false): value is number | null | undefined {
  return value === null || value === undefined || (
    typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_PRICE &&
    (!integer || (Number.isSafeInteger(value) && value >= 0))
  );
}

function parseSnapshot(value: unknown): ItemPriceSnapshot | null {
  if (!isRecord(value)) return null;
  if (!hasOnlyKeys(value, [
    "updatedAt", "lastLowPrice", "avg24hPrice", "low24hPrice", "high24hPrice",
    "changeLast48hPercent", "offerCount", "noFlea", "bestTraderOffer",
  ])) return null;
  if (!isNullableNumber(value.lastLowPrice, true) || !isNullableNumber(value.avg24hPrice, true) ||
      !isNullableNumber(value.low24hPrice, true) || !isNullableNumber(value.high24hPrice, true) ||
      !isNullableNumber(value.changeLast48hPercent) || !isNullableNumber(value.offerCount, true) ||
      (value.updatedAt !== undefined && value.updatedAt !== null && !isTimestamp(value.updatedAt)) ||
      (value.noFlea !== undefined && typeof value.noFlea !== "boolean")) return null;
  if (value.bestTraderOffer !== undefined && value.bestTraderOffer !== null) {
    const offer = value.bestTraderOffer;
    if (!isRecord(offer) || !hasOnlyKeys(offer, ["traderId", "price", "priceRUB", "currency"]) ||
        !isBoundedText(offer.traderId, 80) ||
        !isNullableNumber(offer.price, true) || offer.price === null || offer.price === undefined ||
        !isNullableNumber(offer.priceRUB, true) || offer.priceRUB === null || offer.priceRUB === undefined ||
        !isBoundedText(offer.currency, 12)) return null;
  }
  return value as ItemPriceSnapshot;
}

function parseCatalogItem(value: unknown): ItemPriceCatalogItem | null {
  if (!isRecord(value) || typeof value.id !== "string" || !ITEM_ID_PATTERN.test(value.id) ||
      !hasOnlyKeys(value, [
        "id", "normalizedName", "nameEn", "nameKo", "shortNameEn", "shortNameKo",
        "wikiLink", "tarkovDevLink", "localIcon", "prices",
      ]) || !isBoundedText(value.normalizedName, 300) || !isBoundedText(value.nameEn, 300) ||
      !isBoundedText(value.nameKo, 300) || !isBoundedText(value.shortNameEn, 150) ||
      !isBoundedText(value.shortNameKo, 150) || !isRecord(value.prices) ||
      !hasOnlyKeys(value.prices, ["pvp", "pve"])) return null;
  const prices: ItemPriceCatalogItem["prices"] = {};
  for (const mode of ["pvp", "pve"] as const) {
    if (value.prices[mode] === undefined) continue;
    const snapshot = parseSnapshot(value.prices[mode]);
    if (!snapshot) return null;
    prices[mode] = snapshot;
  }
  if (value.wikiLink !== undefined && !isFixedLink(value.wikiLink, "escapefromtarkov.fandom.com", "/wiki/")) return null;
  if (value.tarkovDevLink !== undefined && !isFixedLink(value.tarkovDevLink, "tarkov.dev", "/item/")) return null;
  if (value.localIcon !== undefined && (typeof value.localIcon !== "string" || !LOCAL_ICON_PATTERN.test(value.localIcon))) return null;
  return { ...(value as unknown as ItemPriceCatalogItem), prices };
}

function parseCatalog(value: unknown): ItemPriceCatalog | null {
  if (!isRecord(value) || !isRecord(value.meta) || !Array.isArray(value.items)) return null;
  const { meta } = value;
  if (!hasOnlyKeys(value, ["meta", "items"]) ||
      !hasOnlyKeys(meta, ["schemaVersion", "generatedAt", "source", "itemCount", "pvpQuoteCount", "pveQuoteCount"]) ||
      meta.schemaVersion !== 1 || !isTimestamp(meta.generatedAt) ||
      meta.source !== "https://json.tarkov.dev/endpoints" ||
      !Number.isSafeInteger(meta.itemCount) || meta.itemCount !== value.items.length || value.items.length > 10_000 ||
      !Number.isSafeInteger(meta.pvpQuoteCount) || !Number.isSafeInteger(meta.pveQuoteCount)) return null;
  const items = value.items.map(parseCatalogItem);
  if (items.some((item) => item === null)) return null;
  const parsedItems = items as ItemPriceCatalogItem[];
  if (new Set(parsedItems.map(({ id }) => id)).size !== parsedItems.length ||
      parsedItems.filter(({ prices }) => prices.pvp).length !== meta.pvpQuoteCount ||
      parsedItems.filter(({ prices }) => prices.pve).length !== meta.pveQuoteCount) return null;
  return { meta: meta as unknown as ItemPriceCatalog["meta"], items: parsedItems };
}

function parseQuote(value: unknown, itemId: string, gameMode: ProfileType): LiveItemPriceQuote | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "protocolVersion", "itemId", "gameMode", "source", "fetchedAt", "expiresAt", "isStale", "flea",
  ]) || value.protocolVersion !== 1 || value.itemId !== itemId ||
      value.gameMode !== gameMode || !["LIVE", "CACHE", "STALE_CACHE"].includes(String(value.source)) ||
      !isTimestamp(value.fetchedAt) || !isTimestamp(value.expiresAt) || typeof value.isStale !== "boolean") return null;
  if ((value.source === "STALE_CACHE") !== value.isStale) return null;
  const flea = parseSnapshot(value.flea);
  if (!flea) return null;
  return { ...(value as unknown as LiveItemPriceQuote), flea };
}

export async function loadItemPriceCatalog(
  signal?: AbortSignal,
  request: typeof fetch = fetch,
  onFailure?: ItemPriceCatalogFailureHandler,
): Promise<ItemPriceCatalog> {
  let response: Response;
  try {
    response = await request(CATALOG_URL, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error: unknown) {
    if (!isAbort(error, signal)) reportItemPriceFailure(onFailure, "REQUEST_FAILED");
    throw error;
  }
  if (!response.ok) {
    if (!signal?.aborted) {
      reportItemPriceFailure(onFailure, "REQUEST_FAILED");
    }
    throw new Error(`시세 카탈로그를 불러오지 못했습니다. (HTTP ${response.status})`);
  }
  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch {
    if (!signal?.aborted) reportItemPriceFailure(onFailure, "INVALID_RESPONSE");
    throw new Error("시세 카탈로그 형식이 올바르지 않습니다.");
  }
  const parsed = parseCatalog(payload);
  if (!parsed && !signal?.aborted) {
    reportItemPriceFailure(onFailure, "INVALID_RESPONSE");
  }
  if (!parsed) throw new Error("시세 카탈로그 형식이 올바르지 않습니다.");
  return parsed;
}

export async function fetchItemPriceQuote(
  itemId: string,
  gameMode: ProfileType,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
  onFailure?: ItemPriceQuoteFailureHandler,
): Promise<LiveItemPriceQuote | null> {
  if (!ITEM_ID_PATTERN.test(itemId)) return null;
  try {
    const response = await request(
      `/api/v1/item-prices/quote?itemId=${encodeURIComponent(itemId)}&gameMode=${gameMode}`,
      { cache: "no-store", headers: { Accept: "application/json" }, signal },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      reportItemPriceFailure(onFailure, "REQUEST_FAILED");
      return null;
    }
    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch {
      if (!signal?.aborted) reportItemPriceFailure(onFailure, "INVALID_RESPONSE");
      return null;
    }
    const parsed = parseQuote(payload, itemId, gameMode);
    if (!parsed && !signal?.aborted) reportItemPriceFailure(onFailure, "INVALID_RESPONSE");
    return parsed;
  } catch (error: unknown) {
    if (!isAbort(error, signal)) reportItemPriceFailure(onFailure, "REQUEST_FAILED");
    return null;
  }
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (
    typeof error === "object" && error !== null &&
    "name" in error && error.name === "AbortError"
  );
}

function reportItemPriceFailure(
  onFailure: ItemPriceCatalogFailureHandler | ItemPriceQuoteFailureHandler | undefined,
  code: ItemPriceFailureCode,
): void {
  try {
    onFailure?.(code);
  } catch {
    // Reporting must not change catalog or optional live-quote behavior.
  }
}
