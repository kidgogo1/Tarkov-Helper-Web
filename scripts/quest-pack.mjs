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

// TarkovData currently leaves the objective-level locations empty for these
// quests. Bind each correction to both the BSG quest id and an exact objective
// id so a translated or rewritten description can never move a marker.
// The opaque ids are from the existing enriched pack; the hexadecimal ids are
// the matching upstream TarkovData objective ids.
const OBJECTIVE_MAP_OVERRIDES = new Map([
  ["5b478eca86f7744642012254", new Map([
    ["EGAHYCvMa5BEU_0nItA_4Z", "Shoreline"],
    ["5b478f6886f774464201225a", "Shoreline"],
    ["vRBCUL9KyySlPdtxQs1X6u", "Interchange"],
    ["5b4c826b86f7743cc87bcee4", "Interchange"],
    ["IUXs1ycQH6QCq2RDps-v4y", "Interchange"],
    ["5b4c82cd86f774170c6e4169", "Interchange"],
  ])],
  ["5d25e4ca86f77409dd5cdf2c", new Map([
    ["ZQMUlzXjyfbANPjmdvAR-h", "Woods"],
    ["5fd8aa3206fb3a6b8154a2c3", "Woods"],
  ])],
]);

// The wiki retired the old Database - Part 2 title and now exposes the same
// in-game quest as A Big Loss. Keep the existing opaque id so saved progress
// remains compatible while refreshes follow the current wiki title.
const WIKI_QUEST_RENAMES = new Map([
  ["https://escapefromtarkov.fandom.com/wiki/Database_-_Part_2", {
    name: "A Big Loss",
    nameKo: "큰 손실",
    normalizedName: "a-big-loss",
    wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/A_Big_Loss",
  }],
  ["https://escapefromtarkov.fandom.com/wiki/The_Blood_of_War_-_Part_3", {
    name: "Small Things, Big Help",
    nameKo: "작은 일, 큰 도움",
    normalizedName: "small-things-big-help",
    wikiPageLink: "https://escapefromtarkov.fandom.com/wiki/Small_Things,_Big_Help",
  }],
]);

// Fandom has redirected these legacy titles to the current quest names. Keep
// the old display name as an alias while updating the canonical page link.
const WIKI_QUEST_REDIRECT_TITLES = [
  ["BP Depot", "Oil Run"],
  ["Gunsmith - Part 5", "Gunsmith - Model 870"],
  ["New Day, New Paths", "New Paths"],
  ["The Huntsman Path - Evil Watchman", "The Huntsman Path - Angry Watchman"],
  ["A Shooter Born in Heaven", "Shooter Born in Heaven"],
  ["Ambulance", "First Aid"],
  ["Ambulances Again", "Paramedic"],
  ["Cargo X - Part 4", "Gifts from Tarkov"],
  ["Colleagues - Part 1", "Colleagues"],
  ["Colleagues - Part 2", "Tarkov-Style Diplomacy"],
  ["Colleagues - Part 3", "A Difficult Choice"],
  ["Database - Part 1", "Inventory Files"],
  ["Easy Job - Part 1", "Easy Job"],
  ["Farming - Part 1", "Playing the Market"],
  ["Farming - Part 3", "Farming"],
  ["Farming - Part 4", "Semiconductor Crisis"],
  ["Gendarmerie - District Patrol", "District Patrol"],
  ["Gendarmerie - Mall Cop", "Mall Cop"],
  ["Gendarmerie - Tickets, Please", "Tickets, Please"],
  ["Glory to CPSU - Part 2", "Glory to CPSU"],
  ["Gunsmith - Part 1", "Gunsmith - MP-133"],
  ["Gunsmith - Part 10", "Gunsmith - AK-105"],
  ["Gunsmith - Part 11", "Gunsmith - Vector 9x19"],
  ["Gunsmith - Part 12", "Gunsmith - MPX"],
  ["Gunsmith - Part 13", "Gunsmith Master - Part 2"],
  ["Gunsmith - Part 14", "Gunsmith Master - Part 1"],
  ["Gunsmith - Part 15", "Gunsmith - AS VAL"],
  ["Gunsmith - Part 16", "Gunsmith Master - Part 3"],
  ["Gunsmith - Part 17", "Gunsmith Master - Part 4"],
  ["Gunsmith - Part 18", "Gunsmith Master - Part 5"],
  ["Gunsmith - Part 19", "Gunsmith Master - Part 6"],
  ["Gunsmith - Part 2", "Gunsmith - AKS-74U"],
  ["Gunsmith - Part 20", "Gunsmith Master - Part 7"],
  ["Gunsmith - Part 21", "Gunsmith Master - Part 8"],
  ["Gunsmith - Part 22", "Gunsmith Master - Part 9"],
  ["Gunsmith - Part 3", "Gunsmith - HK MP5"],
  ["Gunsmith - Part 4", "Gunsmith - OP-SKS"],
  ["Gunsmith - Part 6", "Gunsmith - AKM"],
  ["Gunsmith - Part 7", "Gunsmith - M4A1"],
  ["Gunsmith - Part 8", "Gunsmith - AKS-74N"],
  ["Gunsmith - Part 9", "Gunsmith - P226R"],
  ["Half Empty", "Half-Empty"],
  ["House Arrest - Part 1", "House Arrest"],
  ["Hunter", "All This Filth..."],
  ["Inventory Check", "Reserve Expert"],
  ["Lend-Lease - Part 1", "Metal Birds"],
  ["Lend-Lease - Part 2", "From Hand to Hand"],
  ["Living High is Not a Crime - Part 1", "Living High is Not a Crime"],
  ["Living High is Not a Crime - Part 2", "Antique Enthusiast"],
  ["Sales Night", "Pathfinder"],
  ["Signal - Part 1", "Ill-Wisher"],
  ["Signal - Part 2", "Rat Hunting"],
  ["Swift One", "Swift"],
  ["Test Drive - Part 1", "The Tarkov Import"],
  ["Test Drive - Part 2", "Power of Persuasion"],
  ["Test Drive - Part 3", "Job for a Patriot"],
  ["The Blood of War - Part 1", "Fuel Crisis"],
  ["The Bunker - Part 1", "The Bunker"],
  ["The Huntsman Path - Eraser - Part 1", "The Huntsman Path - Eraser"],
  ["The Huntsman Path - Eraser - Part 2", "The Huntsman Path - Liberation"],
  ["Vitamins - Part 1", "Vitamins"],
  ["Vitamins - Part 2", "Supplements"],
].map(([legacyName, currentName]) => [
  legacyName,
  {
    name: currentName,
    normalizedName: currentName.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
    wikiPageLink: `https://escapefromtarkov.fandom.com/wiki/${currentName.replaceAll(" ", "_").replaceAll(",", "%2C")}`,
  },
]);

// Fandom keeps a single parent page for some quests whose old per-part pages
// were removed. Keep the quest's in-game name/identity, but point the external
// link at the verified parent page instead of leaving a 404 URL in the pack.
const WIKI_QUEST_LINK_ONLY = new Map([
  ["Beyond the Red Meat - Part 1", "Beyond the Red Meat"],
  ["Beyond the Red Meat - Part 2", "Beyond the Red Meat"],
  ["Cargo X - Part 1", "Cargo X"],
  ["Cargo X - Part 2", "Cargo X"],
  ["Friend From the West - Part 1", "Friend From the West"],
  ["Operation Aquarius - Part 1", "Operation Aquarius"],
  ["Operation Aquarius - Part 2", "Operation Aquarius"],
  ["Pets Won't Need It - Part 1", "Pets Won't Need It"],
  ["Sanitary Standards - Part 1", "Sanitary Standards"],
  ["The Cult - Part 1", "The Cult"],
  ["The Cult - Part 2", "The Cult"],
]);

// These old names currently have no dedicated page on the Wiki. Removing the
// dead URL is safer than linking to a different quest and presenting its
// objectives as if they belonged to this one.
const WIKI_QUEST_UNVERIFIED_TITLES = new Set([
  "Developer's Secrets - Part 1",
  "Developer's Secrets - Part 2",
  "Gunsmith - Old Friend's Request",
  "Gunsmith - Part 23",
  "Gunsmith - Part 24",
  "Gunsmith - Part 25",
  "Mall Cop",
  "No Offence",
  "No Questions Asked",
  "Painkiller",
  "Spa Tour - Part 1",
  "Spa Tour - Part 3",
  "Spa Tour - Part 4",
  "Spa Tour - Part 5",
  "Spa Tour - Part 7",
  "Test Drive - Part 4",
  "Test Drive - Part 5",
  "Test Drive - Part 6",
  "The Tarkov Shooter - Part 8",
  "Tickets, Please",
  "Trust Regain",
]);

// Prestige quests all share the legacy German title in the upstream pack.
// Their stable ids let us attach the correct current Wiki page without
// collapsing four distinct quests into one link.
const WIKI_QUEST_ID_RENAMES = new Map([
  ["tarkovdata-new-beginning", "New Beginning (Prestige 1)"],
  ["tarkovdata-new-beginning-2", "New Beginning (Prestige 2)"],
  ["tarkovdata-new-beginning-3", "New Beginning (Prestige 3)"],
  ["tarkovdata-new-beginning-4", "New Beginning (Prestige 4)"],
]);

function wikiPageLinkForTitle(title) {
  return `https://escapefromtarkov.fandom.com/wiki/${encodeURIComponent(title).replaceAll("%20", "_")}`;
}

function wikiTitleFromUrl(link) {
  try {
    return decodeURIComponent(new URL(link).pathname.replace(/^\/wiki\//, ""))
      .replaceAll("_", " ");
  } catch {
    return "";
  }
}

export function applyWikiQuestRenames(quests) {
  return quests.map((quest) => {
    const idRename = WIKI_QUEST_ID_RENAMES.get(quest?.id);
    if (idRename) {
      const legacyNames = new Set([
        ...(Array.isArray(quest.nameAliases) ? quest.nameAliases : []),
        quest.nameEn,
        quest.name,
      ].filter((name) => typeof name === "string" && name.trim()));
      legacyNames.delete(idRename);
      return {
        ...quest,
        name: idRename,
        nameEn: idRename,
        normalizedName: idRename.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        wikiPageLink: wikiPageLinkForTitle(idRename),
        ...(legacyNames.size > 0 ? { nameAliases: [...legacyNames] } : {}),
      };
    }
    const oldTitle = wikiTitleFromUrl(quest?.wikiPageLink);
    const linkOnlyTitle = WIKI_QUEST_LINK_ONLY.get(oldTitle);
    if (linkOnlyTitle) {
      return { ...quest, wikiPageLink: wikiPageLinkForTitle(linkOnlyTitle) };
    }
    if (WIKI_QUEST_UNVERIFIED_TITLES.has(oldTitle)) {
      return { ...quest, wikiPageLink: undefined };
    }
    const titleRename = WIKI_QUEST_REDIRECT_TITLES.find(
      ([legacyName]) => legacyName === oldTitle,
    )?.[1];
    const rename = WIKI_QUEST_RENAMES.get(quest?.wikiPageLink) ?? titleRename;
    if (!rename) return quest;
    const legacyNames = new Set([
      ...(Array.isArray(quest.nameAliases) ? quest.nameAliases : []),
      quest.nameEn,
      quest.name,
    ].filter((name) => typeof name === "string" && name.trim()));
    legacyNames.delete(rename.name);
    return {
      ...quest,
      ...rename,
      nameEn: rename.name,
      nameJa: rename.name,
      ...(legacyNames.size > 0 ? { nameAliases: [...legacyNames] } : {}),
    };
  });
}

export function applyWikiGuideLinkErrors(quests, guides) {
  const confirmedMissingErrors = new Set(["PAGE_NOT_FOUND", "INVALID_WIKI_LINK"]);
  return quests.map((quest) => {
    const error = guides?.entries?.[quest?.id]?.error;
    if (!confirmedMissingErrors.has(error) || !quest?.wikiPageLink) return quest;
    const withoutWikiPageLink = { ...quest };
    delete withoutWikiPageLink.wikiPageLink;
    return withoutWikiPageLink;
  });
}

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

function applyQuestObjectiveMapOverrides(quest) {
  const bsgId = String(quest?.bsgId ?? quest?.gameId ?? "");
  const overrides = OBJECTIVE_MAP_OVERRIDES.get(bsgId);
  if (!overrides || !Array.isArray(quest?.objectives)) return quest;
  let changed = false;
  const objectives = quest.objectives.map((objective) => {
    if (typeof objective?.mapName === "string" && objective.mapName.trim()) return objective;
    const mapName = overrides.get(String(objective?.id ?? ""));
    if (!mapName) return objective;
    changed = true;
    return { ...objective, mapName };
  });
  return changed ? { ...quest, objectives } : quest;
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
  return applyQuestObjectiveMapOverrides({
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
  });
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
  const quests = applyWikiQuestRenames([...preservedQuests, ...additions])
    .map(applyQuestObjectiveMapOverrides);
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
