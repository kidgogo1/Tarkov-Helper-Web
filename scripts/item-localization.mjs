function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeText(value) {
  return cleanText(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

function wikiPageKey(value) {
  const link = cleanText(value);
  if (!link || link.length > 500) return "";
  try {
    const url = new URL(link);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "escapefromtarkov.fandom.com" ||
      !url.pathname.startsWith("/wiki/")
    ) {
      return "";
    }
    return decodeURIComponent(url.pathname.slice("/wiki/".length))
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase("en-US");
  } catch {
    return "";
  }
}

function candidateForItem(item, candidates) {
  if (candidates.length === 1) return candidates[0];
  const knownNames = new Set(
    [item.name, item.nameEn].map(normalizeText).filter(Boolean),
  );
  const exactMatches = candidates.filter((candidate) =>
    knownNames.has(normalizeText(candidate.nameEn)),
  );
  return exactMatches.length === 1 ? exactMatches[0] : undefined;
}

function addIfChanged(item, key, value) {
  const next = cleanText(value);
  if (!next || item[key] === next) return false;
  item[key] = next;
  return true;
}

/**
 * Applies Tarkov.dev's Korean/English item translations to the static item
 * pack. Fandom page links are the shared, stable identity. A link with more
 * than one catalog entry is used only when the English item name is exact, so
 * preset variants can never overwrite the base item's name by accident.
 */
export function localizeItemData(data, catalog) {
  if (!data || !Array.isArray(data.items)) {
    throw new Error("item data must contain an items array");
  }
  if (!catalog || !Array.isArray(catalog.items)) {
    throw new Error("item catalog must contain an items array");
  }

  const candidatesByPage = new Map();
  for (const candidate of catalog.items) {
    if (!candidate || typeof candidate !== "object") continue;
    const pageKey = wikiPageKey(candidate.wikiLink);
    const nameEn = cleanText(candidate.nameEn);
    const nameKo = cleanText(candidate.nameKo);
    if (!pageKey || !nameEn || !nameKo) continue;
    const entries = candidatesByPage.get(pageKey) ?? [];
    entries.push(candidate);
    candidatesByPage.set(pageKey, entries);
  }

  let matched = 0;
  let changed = 0;
  for (const item of data.items) {
    if (!item || typeof item !== "object") continue;
    const candidate = candidateForItem(
      item,
      candidatesByPage.get(wikiPageKey(item.wikiPageLink)) ?? [],
    );
    if (!candidate) continue;
    matched += 1;
    const itemChanged = [
      addIfChanged(item, "nameEn", candidate.nameEn),
      addIfChanged(item, "nameKo", candidate.nameKo),
      addIfChanged(item, "shortNameEn", candidate.shortNameEn),
      addIfChanged(item, "shortNameKo", candidate.shortNameKo),
    ].some(Boolean);
    if (itemChanged) changed += 1;
  }

  return { matched, changed };
}
