const CATALOG_PATHS = Object.freeze({
  regular: "regular",
  pve: "pve",
  pvpSeason: "pvp-season",
});

/** Returns every json.tarkov.dev resource needed to localize one catalog. */
export function questCatalogSourceUrls(mode) {
  const path = CATALOG_PATHS[mode];
  if (!path) throw new Error(`Unsupported quest catalog mode: ${String(mode)}`);
  const base = `https://json.tarkov.dev/${path}`;
  return {
    tasks: `${base}/tasks`,
    english: `${base}/tasks_en`,
    korean: `${base}/tasks_ko`,
    maps: `${base}/maps_en`,
  };
}

function normalizedName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function questPrimaryNames(quest) {
  return new Set([
    quest?.name,
    quest?.nameEn,
    quest?.nameKo,
    quest?.nameJa,
  ].map(normalizedName).filter(Boolean));
}

function questNames(quest) {
  return new Set([
    ...questPrimaryNames(quest),
    ...(Array.isArray(quest?.nameAliases) ? quest.nameAliases : []),
  ].map(normalizedName).filter(Boolean));
}

function questBsgIds(quest) {
  return new Set([
    quest?.bsgId,
    ...(Array.isArray(quest?.bsgIdAliases) ? quest.bsgIdAliases : []),
  ].filter(Boolean).map(String));
}

function liveQuestId(quest) {
  const value = quest?.gameId ?? quest?.bsgId ?? quest?.id;
  return value ? String(value) : "";
}

function withCurrentBsgId(quest, bsgId) {
  if (!bsgId || String(quest?.bsgId ?? "") === bsgId) return quest;
  const aliases = new Set([
    quest?.bsgId,
    ...(Array.isArray(quest?.bsgIdAliases) ? quest.bsgIdAliases : []),
  ].filter((value) => value && String(value) !== bsgId).map(String));
  return {
    ...quest,
    bsgId,
    ...(aliases.size > 0 ? { bsgIdAliases: [...aliases] } : {}),
  };
}

/**
 * Builds a mode-only seed from the enriched regular pack. Stable local ids,
 * saved-state keys, and verified map coordinates survive the subsequent merge.
 */
export function createQuestCatalogSeed(regularPack, liveModeQuests) {
  const localQuests = Array.isArray(regularPack?.quests) ? regularPack.quests : [];
  const liveQuests = Array.isArray(liveModeQuests) ? liveModeQuests : [];
  const localByBsgId = new Map();
  const localByPrimaryName = new Map();
  const localByName = new Map();

  localQuests.forEach((quest, index) => {
    for (const id of questBsgIds(quest)) {
      const indexes = localByBsgId.get(id) ?? [];
      indexes.push(index);
      localByBsgId.set(id, indexes);
    }
    for (const name of questPrimaryNames(quest)) {
      const indexes = localByPrimaryName.get(name) ?? [];
      indexes.push(index);
      localByPrimaryName.set(name, indexes);
    }
    for (const name of questNames(quest)) {
      const indexes = localByName.get(name) ?? [];
      indexes.push(index);
      localByName.set(name, indexes);
    }
  });

  const liveNameCounts = new Map();
  for (const quest of liveQuests) {
    const name = normalizedName(quest?.name ?? quest?.nameEn);
    if (name) liveNameCounts.set(name, (liveNameCounts.get(name) ?? 0) + 1);
  }

  const usedLocalIndexes = new Set();
  const quests = [];
  for (const liveQuest of liveQuests) {
    const bsgId = liveQuestId(liveQuest);
    const idMatches = bsgId
      ? (localByBsgId.get(bsgId) ?? []).filter((index) => !usedLocalIndexes.has(index))
      : [];
    let matchIndex = idMatches.length === 1 ? idMatches[0] : -1;

    if (matchIndex < 0) {
      const name = normalizedName(liveQuest?.name ?? liveQuest?.nameEn);
      if (name && liveNameCounts.get(name) === 1) {
        const primaryMatches = (localByPrimaryName.get(name) ?? [])
          .filter((index) => !usedLocalIndexes.has(index));
        if (primaryMatches.length === 1) {
          matchIndex = primaryMatches[0];
        } else {
          const nameMatches = (localByName.get(name) ?? [])
            .filter((index) => !usedLocalIndexes.has(index));
          if (nameMatches.length === 1) matchIndex = nameMatches[0];
        }
      }
    }

    if (matchIndex < 0) continue;
    usedLocalIndexes.add(matchIndex);
    quests.push(withCurrentBsgId(localQuests[matchIndex], bsgId));
  }

  const seed = { ...(regularPack ?? {}) };
  delete seed.questCatalogs;
  return { ...seed, quests };
}

/** Keeps the regular list at the legacy field and attaches opt-in mode lists. */
export function assembleQuestCatalogPack({ regular, pve, pvpSeason }) {
  const regularQuests = Array.isArray(regular?.quests) ? regular.quests : [];
  const pveQuests = Array.isArray(pve?.quests) ? pve.quests : [];
  const pvpSeasonQuests = Array.isArray(pvpSeason?.quests) ? pvpSeason.quests : [];
  return {
    ...regular,
    meta: {
      ...(regular?.meta ?? {}),
      sources: {
        ...(regular?.meta?.sources ?? {}),
        questCatalogCounts: {
          regular: regularQuests.length,
          pve: pveQuests.length,
          pvpSeason: pvpSeasonQuests.length,
        },
      },
    },
    quests: regularQuests,
    questCatalogs: {
      pve: pveQuests,
      pvpSeason: pvpSeasonQuests,
    },
  };
}
