const ITEM_ID_PATTERN = /^[0-9a-f]{24}$/;
const LOCAL_ICON_PATTERN = /^assets\/items\/[A-Za-z0-9._-]+\.(?:png|webp|svg)$/;
const MAX_PRICE = 2_000_000_000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function cleanText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function nullableInteger(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PRICE) {
    throw new Error(`${label} must be a bounded non-negative integer`);
  }
  return value;
}

function nullableNumber(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_PRICE) {
    throw new Error(`${label} must be a bounded finite number`);
  }
  return value;
}

function optionalHttpsLink(value, allowed) {
  if (typeof value !== "string" || value.length > 500) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && allowed(url) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function itemMap(document, label) {
  const data = requiredRecord(requiredRecord(document, label).data, `${label}.data`);
  return requiredRecord(data.items, `${label}.data.items`);
}

function translationMap(document, label) {
  return requiredRecord(requiredRecord(document, label).data, `${label}.data`);
}

function resolveTranslation(translations, key, fallback) {
  const translated = typeof key === "string" ? translations[key] : undefined;
  return cleanText(translated, fallback);
}

function bestTraderOffer(item) {
  if (item.sellToTrader === undefined || item.sellToTrader === null) return null;
  if (!Array.isArray(item.sellToTrader)) throw new Error("sellToTrader must be an array");

  let best = null;
  for (const rawOffer of item.sellToTrader) {
    const offer = requiredRecord(rawOffer, "sellToTrader entry");
    const traderId = cleanText(offer.trader);
    const currency = cleanText(offer.currency);
    const price = nullableInteger(offer.price, "trader price");
    const priceRUB = nullableInteger(offer.priceRUB, "trader RUB price");
    if (!traderId || !currency || price === null || priceRUB === null) continue;
    if (!best || priceRUB > best.priceRUB) {
      best = { traderId, price, priceRUB, currency };
    }
  }
  return best;
}

function buildSnapshot(item) {
  const types = item.types === undefined ? [] : item.types;
  if (!Array.isArray(types) || types.some((value) => typeof value !== "string" || value.length > 80)) {
    throw new Error("item types must be a bounded string array");
  }
  const updatedAt = cleanText(item.updated);
  if (updatedAt && !Number.isFinite(Date.parse(updatedAt))) {
    throw new Error("item updated timestamp is invalid");
  }

  return {
    updatedAt: updatedAt || null,
    lastLowPrice: nullableInteger(item.lastLowPrice, "lastLowPrice"),
    avg24hPrice: nullableInteger(item.avg24hPrice, "avg24hPrice"),
    low24hPrice: nullableInteger(item.low24hPrice, "low24hPrice"),
    high24hPrice: nullableInteger(item.high24hPrice, "high24hPrice"),
    changeLast48hPercent: nullableNumber(item.changeLast48hPercent, "changeLast48hPercent"),
    offerCount: nullableInteger(item.lastOfferCount, "lastOfferCount"),
    noFlea: types.includes("noFlea"),
    bestTraderOffer: bestTraderOffer(item),
  };
}

function localIconLookup(localItems) {
  if (!Array.isArray(localItems)) throw new Error("localItems must be an array");
  const candidates = new Map();
  for (const item of localItems) {
    if (!isRecord(item)) continue;
    const wikiPageLink = cleanText(item.wikiPageLink);
    const localIcon = cleanText(item.localIcon);
    if (!wikiPageLink || !LOCAL_ICON_PATTERN.test(localIcon)) continue;
    const current = candidates.get(wikiPageLink) ?? [];
    current.push(localIcon);
    candidates.set(wikiPageLink, current);
  }
  return new Map(
    [...candidates].flatMap(([wikiPageLink, icons]) =>
      icons.length === 1 ? [[wikiPageLink, icons[0]]] : [],
    ),
  );
}

function assertItemIdentity(item, key, label) {
  const id = cleanText(item.id, key);
  if (!ITEM_ID_PATTERN.test(id) || key !== id) {
    throw new Error(`${label} item id is invalid`);
  }
  return id;
}

export function buildItemPriceCatalog({
  generatedAt,
  regular,
  pve,
  english,
  korean,
  localItems,
}) {
  if (typeof generatedAt !== "string" || !Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("generatedAt must be an ISO timestamp");
  }
  const regularItems = itemMap(regular, "regular");
  const pveItems = itemMap(pve, "pve");
  const englishTranslations = translationMap(english, "english");
  const koreanTranslations = translationMap(korean, "korean");
  const icons = localIconLookup(localItems);
  const ids = [...new Set([...Object.keys(regularItems), ...Object.keys(pveItems)])].sort();
  const items = [];
  let pvpQuoteCount = 0;
  let pveQuoteCount = 0;

  for (const key of ids) {
    const regularItem = regularItems[key];
    const pveItem = pveItems[key];
    const identitySource = requiredRecord(regularItem ?? pveItem, "item");
    const id = assertItemIdentity(identitySource, key, regularItem ? "regular" : "pve");
    if (regularItem) assertItemIdentity(requiredRecord(regularItem, "regular item"), key, "regular");
    if (pveItem) assertItemIdentity(requiredRecord(pveItem, "pve item"), key, "pve");

    const nameKey = cleanText(identitySource.name);
    const shortNameKey = cleanText(identitySource.shortName);
    const nameEn = resolveTranslation(englishTranslations, nameKey, nameKey);
    if (!nameEn || nameEn.length > 300) throw new Error(`English item name is invalid for ${id}`);
    const shortNameEn = resolveTranslation(englishTranslations, shortNameKey, nameEn);
    const nameKo = resolveTranslation(koreanTranslations, nameKey, nameEn);
    const shortNameKo = resolveTranslation(koreanTranslations, shortNameKey, shortNameEn);
    const normalizedName = cleanText(identitySource.normalizedName);
    if (!normalizedName || normalizedName.length > 300) {
      throw new Error(`normalized item name is invalid for ${id}`);
    }
    const wikiLink = optionalHttpsLink(
      identitySource.wikiLink,
      (url) => url.hostname === "escapefromtarkov.fandom.com" && url.pathname.startsWith("/wiki/"),
    );
    const tarkovDevLink = optionalHttpsLink(
      identitySource.link,
      (url) => url.hostname === "tarkov.dev" && url.pathname.startsWith("/item/"),
    );
    const localIcon = wikiLink ? icons.get(wikiLink) : undefined;
    const prices = {};
    if (regularItem) {
      prices.pvp = buildSnapshot(regularItem);
      pvpQuoteCount += 1;
    }
    if (pveItem) {
      prices.pve = buildSnapshot(pveItem);
      pveQuoteCount += 1;
    }

    items.push({
      id,
      normalizedName,
      nameEn,
      nameKo,
      shortNameEn,
      shortNameKo,
      ...(wikiLink ? { wikiLink } : {}),
      ...(tarkovDevLink ? { tarkovDevLink } : {}),
      ...(localIcon ? { localIcon } : {}),
      prices,
    });
  }

  return {
    meta: {
      schemaVersion: 1,
      generatedAt: new Date(generatedAt).toISOString(),
      source: "https://json.tarkov.dev/endpoints",
      itemCount: items.length,
      pvpQuoteCount,
      pveQuoteCount,
    },
    items,
  };
}

export async function readBoundedJsonResponse(response, maximumBytes) {
  if (!(response instanceof Response)) throw new Error("upstream response is invalid");
  if (!response.ok) throw new Error(`upstream returned HTTP ${response.status}`);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("maximumBytes is invalid");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("upstream response exceeded the size limit");
  }
  if (!response.body) throw new Error("upstream response body is missing");

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new Error("upstream response exceeded the size limit");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("upstream response was not valid UTF-8 JSON");
  }
}

export async function fetchFixedJson(url, maximumBytes, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "TarkovHelper-Web-PriceCatalog/1.0",
    },
    redirect: "error",
  });
  return readBoundedJsonResponse(response, maximumBytes);
}

