const MAP_NAMES = new Map([
  ["customs", "Customs"],
  ["factory", "Factory"],
  ["ground-zero", "GroundZero"],
  ["interchange", "Interchange"],
  ["laboratory", "TheLab"],
  ["labs", "TheLab"],
  ["the-lab", "TheLab"],
  ["lighthouse", "Lighthouse"],
  ["reserve", "Reserve"],
  ["shoreline", "Shoreline"],
  ["streets-of-tarkov", "StreetsOfTarkov"],
  ["streets", "StreetsOfTarkov"],
  ["woods", "Woods"],
]);

export function extractWikiQuestMeta(wikitext, revisionTimestamp = null) {
  const source = String(wikitext ?? "");
  const listStart = source.indexOf("==List of Quests==");
  const operationsStart = source.indexOf("==Operational Tasks==", listStart + 1);
  const list = listStart >= 0
    ? source.slice(listStart, operationsStart >= 0 ? operationsStart : undefined)
    : "";
  const names = [...list.matchAll(/\|-\s*\n\|\s*\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g)]
    .map((match) => match[1].trim());
  return {
    wikiQuestCount: new Set(names).size,
    wikiRevisionTimestamp: revisionTimestamp,
  };
}

export function normalizeQuestName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\[?pvp zone\]?/g, "")
    .replace(/\b(usec|bear)\b/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function mapDisplayName(value) {
  if (!value) return undefined;
  const normalized = String(value).trim().toLowerCase();
  return MAP_NAMES.get(normalized) ?? String(value);
}

function objectiveLocations(remoteObjective) {
  return Array.isArray(remoteObjective?.locations) ? remoteObjective.locations : [];
}

function questLocations(remoteQuest) {
  const names = [];
  if (remoteQuest?.map) names.push(mapDisplayName(remoteQuest.map));
  for (const objective of remoteQuest?.objectives ?? []) {
    for (const location of objectiveLocations(objective)) {
      if (location?.map) names.push(mapDisplayName(location.map));
    }
  }
  return [...new Set(names.filter(Boolean))];
}

function questWikiUrl(remoteQuest) {
  if (typeof remoteQuest?.wiki === "string" && remoteQuest.wiki) return remoteQuest.wiki;
  const title = String(remoteQuest?.name ?? "").replace(/ /g, "_");
  return title ? `https://escapefromtarkov.fandom.com/wiki/${encodeURIComponent(title)}` : undefined;
}

function appObjective(remoteQuest, remoteObjective, index, questId) {
  const locations = objectiveLocations(remoteObjective);
  const mapName = locations[0]?.map
    ? mapDisplayName(locations[0].map)
    : mapDisplayName(remoteQuest?.map);
  return {
    id: String(remoteObjective?.id ?? `${questId}-objective-${index + 1}`),
    sortOrder: index,
    objectiveType: String(remoteObjective?.type ?? "other"),
    description: String(remoteObjective?.description ?? remoteObjective?.type ?? "Objective"),
    targetType: String(remoteObjective?.type ?? "other"),
    ...(mapName ? { mapName } : {}),
    requiresFir: false,
    // TarkovData's x/y values are map pixels, not the web pack's world coordinates.
    // Keep these empty rather than placing markers at a wrong position.
    locationPoints: [],
    optionalPoints: [],
  };
}

export function toAppQuest(remoteQuest) {
  const questId = `tarkovdata-${String(remoteQuest?.id ?? remoteQuest?.gameId ?? "quest")}`;
  const minLevel = Number(remoteQuest?.minPlayerLevel);
  const objectives = Array.isArray(remoteQuest?.objectives)
    ? remoteQuest.objectives.map((objective, index) =>
        appObjective(remoteQuest, objective, index, questId),
      )
    : [];
  return {
    id: questId,
    ...(remoteQuest?.gameId ? { bsgId: String(remoteQuest.gameId) } : {}),
    normalizedName: String(remoteQuest?.id ?? normalizeQuestName(remoteQuest?.name)),
    name: String(remoteQuest?.name ?? remoteQuest?.id ?? "Unknown quest"),
    nameEn: String(remoteQuest?.name ?? remoteQuest?.id ?? "Unknown quest"),
    ...(questWikiUrl(remoteQuest) ? { wikiPageLink: questWikiUrl(remoteQuest) } : {}),
    trader: String(remoteQuest?.trader ?? ""),
    locations: questLocations(remoteQuest),
    ...(Number.isFinite(minLevel) && minLevel > 0 ? { minLevel } : {}),
    kappaRequired: Boolean(remoteQuest?.kappa),
    ...(remoteQuest?.faction ? { faction: String(remoteQuest.faction) } : {}),
    requirements: [],
    alternativeQuestIds: [],
    followUpQuestIds: [],
    objectives,
    requiredItems: [],
  };
}

function hasLocalMatch(localQuest, remoteQuest, localByBsgId, localByName) {
  const remoteId = remoteQuest?.gameId ? String(remoteQuest.gameId) : "";
  if (remoteId && localByBsgId.has(remoteId)) return true;
  return localByName.has(normalizeQuestName(remoteQuest?.name));
}

export function mergeQuestSources(localPack, tarkovData, wikiMeta = {}) {
  const localQuests = Array.isArray(localPack?.quests) ? localPack.quests : [];
  const remoteQuests = Array.isArray(tarkovData?.quests) ? tarkovData.quests : [];
  const remoteByBsgId = new Map(
    remoteQuests.filter((quest) => quest?.gameId).map((quest) => [String(quest.gameId), quest]),
  );
  const localByBsgId = new Set(
    localQuests.filter((quest) => quest?.bsgId).map((quest) => String(quest.bsgId)),
  );
  const localByName = new Set(localQuests.map((quest) => normalizeQuestName(quest?.name)));
  const preservedQuests = localQuests.map((quest) => {
    const remote = quest?.id?.startsWith("tarkovdata-") && quest?.bsgId
      ? remoteByBsgId.get(String(quest.bsgId))
      : undefined;
    return remote ? toAppQuest(remote) : quest;
  });
  const additions = remoteQuests
    .filter((quest) => !hasLocalMatch(localQuests, quest, localByBsgId, localByName))
    .map(toAppQuest)
    .sort((left, right) => left.name.localeCompare(right.name));
  const quests = [...preservedQuests, ...additions];
  const localMeta = localPack?.meta ?? {};
  const remoteGenerated = tarkovData?.meta?.generated;
  const sources = {
    ...(localMeta.sources ?? {}),
    localExportedAt: localMeta.sources?.localExportedAt ?? localMeta.exportedAt ?? null,
    tarkovDataGeneratedAt: remoteGenerated ?? null,
    tarkovDataQuestCount: Number(tarkovData?.meta?.count ?? remoteQuests.length),
    wikiQuestCount: Number(wikiMeta.wikiQuestCount ?? 0),
    wikiRevisionTimestamp: wikiMeta.wikiRevisionTimestamp ?? null,
    refreshMode: "preserve-local-enriched-append-tarkovdata",
  };
  return {
    ...localPack,
    meta: {
      ...localMeta,
      exportedAt: remoteGenerated ?? localMeta.exportedAt,
      counts: { ...(localMeta.counts ?? {}), quests: quests.length },
      sources,
    },
    quests,
  };
}
