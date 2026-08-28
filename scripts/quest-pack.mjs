const MAP_NAMES = new Map([
  ["customs", "Customs"],
  ["factory", "Factory"],
  ["ground-zero", "GroundZero"],
  ["ground zero", "GroundZero"],
  ["groundzero", "GroundZero"],
  ["ground zero 21+", "GroundZero"],
  ["ground zero tutorial", "GroundZero"],
  ["interchange", "Interchange"],
  ["laboratory", "TheLab"],
  ["labs", "TheLab"],
  ["the-lab", "TheLab"],
  ["the lab", "TheLab"],
  ["thelab", "TheLab"],
  ["the lab (dark)", "TheLab"],
  ["night factory", "Factory"],
  ["the labyrinth", "Labyrinth"],
  ["labyrinth", "Labyrinth"],
  ["terminal", "Terminal"],
  ["lighthouse", "Lighthouse"],
  ["reserve", "Reserve"],
  ["shoreline", "Shoreline"],
  ["streets-of-tarkov", "StreetsOfTarkov"],
  ["streets of tarkov", "StreetsOfTarkov"],
  ["streetsoftarkov", "StreetsOfTarkov"],
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
  ["The Huntsman Path - Control", "The Huntsman Path - Controller"],
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
  // The game task keeps the mode suffix, while the Wiki uses the shorter
  // canonical page title.
  ["Arena Business [PVP ZONE]", "Arena Business"],
  ["Arena Business [PVE ZONE]", "Arena Business"],
  // Fandom title casing is significant in its API, even though the quest
  // name is otherwise identical.
  ["Demonstration Model", "Demonstration Model"],
  ["Mall Cop", "Gendarmerie - Mall Cop"],
  ["Tickets, Please", "Gendarmerie - Tickets, Please"],
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
  // The live task feed uses localized German names and new BSG ids for the
  // prestige chain. Match each task by its stable id so all three pages keep
  // their distinct objectives and requirements.
  ["tarkovdata-6761ff17cdc36bd66102e9d0", "New Beginning (Prestige 2)"],
  ["tarkovdata-6848100b00afffa81f09e365", "New Beginning (Prestige 3)"],
  ["tarkovdata-68481881f43abfdda2058369", "New Beginning (Prestige 4)"],
  ["tarkovdata-6a4532e48e82d8ffea0c3eae", "The Huntsman Path - Controller"],
]);

// Some newly published tasks have a stale or already-cleared link in an
// existing bundle. Resolve them by stable task id so a cleanup run can repair
// the link even when there is no old URL left to inspect.
const WIKI_QUEST_ID_LINKS = new Map([
  ["tarkovdata-697877e0c639962b2e0cf24f", "Arena Business"],
  ["tarkovdata-6a5cd2178fd7c2b201032f3f", "Demonstration Model"],
  ["tarkovdata-6a5ccda873f06065630d61b0", "Secret Message"],
  ["tarkovdata-6a4532e48e82d8ffea0c3eae", "The Huntsman Path - Controller"],
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
    const idLink = WIKI_QUEST_ID_LINKS.get(quest?.id);
    if (idLink) return { ...quest, wikiPageLink: wikiPageLinkForTitle(idLink) };
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
    const mapName = [
      objective?.bsgId,
      objective?.id,
      ...(Array.isArray(objective?.bsgIdAliases) ? objective.bsgIdAliases : []),
    ].map((id) => overrides.get(String(id ?? ""))).find(Boolean);
    if (!mapName) return objective;
    changed = true;
    return { ...objective, mapName };
  });
  return changed ? { ...quest, objectives } : quest;
}

function objectiveLocations(remoteObjective) {
  if (Array.isArray(remoteObjective?.locations)) return remoteObjective.locations;
  if (Array.isArray(remoteObjective?.maps)) {
    return remoteObjective.maps.map((map) => ({ map }));
  }
  return [];
}

function worldPoint(value) {
  if (!value || typeof value !== "object") return undefined;
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  if (![x, y, z].every(Number.isFinite)) return undefined;
  const floorId = typeof value.floorId === "string" ? value.floorId.trim() : "";
  return { x, y, z, ...(floorId ? { floorId } : {}) };
}

function uniqueWorldPoints(points) {
  const unique = new Map();
  for (const point of points) {
    const normalized = worldPoint(point);
    if (!normalized) continue;
    const key = [normalized.x, normalized.y, normalized.z, normalized.floorId ?? ""].join("\u0000");
    if (!unique.has(key)) unique.set(key, normalized);
  }
  return [...unique.values()];
}

function objectiveMapLocations(remoteQuest, remoteObjective) {
  const fallbackMapName = mapDisplayName(remoteQuest?.map);
  const grouped = new Map();

  for (const location of objectiveLocations(remoteObjective)) {
    const mapName = mapDisplayName(location?.map) ?? fallbackMapName;
    if (!mapName) continue;
    const key = String(mapName).trim().toLocaleLowerCase("en-US");
    const group = grouped.get(key) ?? {
      mapName,
      locationPoints: [],
      optionalPoints: [],
    };
    const target = location?.optional
      ? group.optionalPoints
      : group.locationPoints;
    if (Array.isArray(location?.positions)) target.push(...location.positions);
    grouped.set(key, group);
  }

  return [...grouped.values()].map((location) => ({
    ...location,
    locationPoints: uniqueWorldPoints(location.locationPoints),
    optionalPoints: uniqueWorldPoints(location.optionalPoints),
  }));
}

function objectiveAppId(questId, remoteId) {
  return `${questId}:objective:${remoteId}`;
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
  if (typeof remoteQuest?.wiki === "string" && remoteQuest.wiki) {
    return remoteQuest.wiki.trim().replace(/(?:(?:%0a)|(?:%0d))+$/gi, "");
  }
  const title = String(remoteQuest?.name ?? "").replace(/ /g, "_");
  return title ? `https://escapefromtarkov.fandom.com/wiki/${encodeURIComponent(title)}` : undefined;
}

function appObjective(remoteQuest, remoteObjective, index, questId) {
  const remoteId = String(remoteObjective?.id ?? `${questId}-objective-${index + 1}`);
  const objectiveType = String(remoteObjective?.type ?? "other");
  const mapLocations = objectiveMapLocations(remoteQuest, remoteObjective);
  const itemIds = Array.isArray(remoteObjective?.items)
    ? remoteObjective.items.map(String).filter(Boolean)
    : [];
  const questItemId = remoteObjective?.questItem ? String(remoteObjective.questItem) : "";
  const primaryItemId = itemIds[0] ?? questItemId;
  const primaryMapLocation = mapLocations[0];
  const mapName = primaryMapLocation?.mapName ?? mapDisplayName(remoteQuest?.map);
  return {
    id: objectiveAppId(questId, remoteId),
    bsgId: remoteId,
    sortOrder: index,
    objectiveType,
    description: String(remoteObjective?.description ?? remoteObjective?.type ?? "Objective"),
    targetType: objectiveType,
    ...(remoteObjective?.descriptionKo ? { descriptionKo: String(remoteObjective.descriptionKo) } : {}),
    ...(Number.isFinite(Number(remoteObjective?.count)) ? { targetCount: Number(remoteObjective.count) } : {}),
    ...(primaryItemId ? { itemId: primaryItemId } : {}),
    ...(itemIds.length > 1 && objectiveType.toLocaleLowerCase("en-US") !== "sellitem"
      ? { alternativeItemIds: itemIds.slice(1) }
      : {}),
    ...(questItemId ? { questItemId } : {}),
    ...(mapLocations.length > 0
      ? {
          mapNames: mapLocations.map((location) => location.mapName),
          mapLocations,
        }
      : {}),
    ...(Array.isArray(remoteObjective?.requiredKeys) && remoteObjective.requiredKeys.length > 0
      ? { requiredKeyGroups: remoteObjective.requiredKeys }
      : {}),
    ...(remoteObjective?.optional ? { isOptional: true } : {}),
    ...(mapName ? { mapName } : {}),
    requiresFir: Boolean(remoteObjective?.foundInRaid),
    // json.tarkov.dev's possibleLocations positions use EFT world x/y/z.
    // The legacy single-map fields intentionally contain only the selected
    // map's points. All map-specific points remain available in mapLocations.
    locationPoints: primaryMapLocation?.locationPoints ?? [],
    optionalPoints: primaryMapLocation?.optionalPoints ?? [],
  };
}

export function toAppQuest(remoteQuest) {
  const questId = `tarkovdata-${String(remoteQuest?.id ?? remoteQuest?.gameId ?? "quest")}`;
  const minLevel = Number(remoteQuest?.minPlayerLevel);
  const faction = String(remoteQuest?.factionName ?? remoteQuest?.faction ?? "").trim();
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
    ...(remoteQuest?.nameKo ? { nameKo: String(remoteQuest.nameKo) } : {}),
    ...(questWikiUrl(remoteQuest) ? { wikiPageLink: questWikiUrl(remoteQuest) } : {}),
    trader: String(remoteQuest?.trader ?? ""),
    locations: questLocations(remoteQuest),
    ...(Number.isFinite(minLevel) && minLevel > 0 ? { minLevel } : {}),
    kappaRequired: Boolean(remoteQuest?.kappaRequired ?? remoteQuest?.kappa),
    ...(faction && faction.toLocaleLowerCase("en-US") !== "any" ? { faction } : {}),
    requirements: Array.isArray(remoteQuest?.requirements) ? remoteQuest.requirements : [],
    traderRequirements: Array.isArray(remoteQuest?.traderRequirements)
      ? remoteQuest.traderRequirements
      : [],
    otherRequirements: Array.isArray(remoteQuest?.otherRequirements)
      ? remoteQuest.otherRequirements
      : [],
    alternativeQuestIds: Array.isArray(remoteQuest?.alternativeQuestIds)
      ? remoteQuest.alternativeQuestIds.map(String).filter(Boolean)
      : [],
    followUpQuestIds: [],
    objectives,
    requiredItems: Array.isArray(remoteQuest?.requiredItems) ? remoteQuest.requiredItems : [],
    ...(Array.isArray(remoteQuest?.rewardItems) ? { rewardItems: remoteQuest.rewardItems } : {}),
    ...(Object.prototype.hasOwnProperty.call(remoteQuest ?? {}, "rewardXp")
      ? { rewardXp: Number(remoteQuest.rewardXp) || 0 }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(remoteQuest ?? {}, "rewardRoubles")
      ? { rewardRoubles: Number(remoteQuest.rewardRoubles) || 0 }
      : {}),
    ...(Array.isArray(remoteQuest?.rewardReputation)
      ? { rewardReputation: remoteQuest.rewardReputation }
      : {}),
    ...(Array.isArray(remoteQuest?.rewardSkills) ? { rewardSkills: remoteQuest.rewardSkills } : {}),
    ...(Array.isArray(remoteQuest?.rewardUnlocks) ? { rewardUnlocks: remoteQuest.rewardUnlocks } : {}),
  });
}

function normalizedObjectiveText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizedObjectiveType(objective) {
  const value = normalizedObjectiveText(objective?.objectiveType ?? objective?.targetType ?? "")
    .replaceAll(" ", "");
  const aliases = new Map([
    ["findquestitem", "collect"],
    ["finditem", "collect"],
    ["givequestitem", "handover"],
    ["giveitem", "handover"],
    ["extract", "survive"],
    ["shoot", "kill"],
    ["taskstatus", "task"],
    ["plantquestitem", "plant"],
    ["plantitem", "plant"],
  ]);
  return aliases.get(value) ?? value;
}

function objectiveIdentityValues(objective) {
  return new Set([
    objective?.id,
    objective?.bsgId,
    ...(Array.isArray(objective?.bsgIdAliases) ? objective.bsgIdAliases : []),
  ].filter(Boolean).map(String));
}

function objectiveMapsAreCompatible(local, refreshed, refreshedQuestLocations) {
  const localMap = mapDisplayName(local?.mapName);
  const refreshedMap = mapDisplayName(refreshed?.mapName);
  if (localMap && refreshedMap) return localMap === refreshedMap;
  if (!localMap) return true;
  const questMaps = new Set(
    (Array.isArray(refreshedQuestLocations) ? refreshedQuestLocations : [])
      .map(mapDisplayName)
      .filter(Boolean),
  );
  return questMaps.size === 0 || questMaps.has(localMap);
}

function objectiveItemIdentity(objectives, index) {
  const objective = objectives[index];
  const directItemId = objective?.itemId ?? objective?.questItemId;
  if (directItemId) return String(directItemId);

  // Older Wiki packs omitted the item on generic handover rows, but kept the
  // matching collect row immediately before them. Use only that strict pair so
  // duplicate labels can be migrated without guessing between unrelated rows.
  if (normalizedObjectiveType(objective) !== "handover" || index <= 0) return "";
  const previous = objectives[index - 1];
  if (normalizedObjectiveType(previous) !== "collect") return "";
  return previous?.itemId ? String(previous.itemId) : "";
}

function mergeQuestObjectives(localObjectives, refreshedObjectives, refreshedQuestLocations = []) {
  const local = Array.isArray(localObjectives) ? localObjectives : [];
  const refreshed = Array.isArray(refreshedObjectives) ? refreshedObjectives : [];
  const usedLocal = new Set();

  const findLocal = (objective, refreshedIndex) => {
    const remoteIdentity = objectiveIdentityValues(objective);
    const identityMatches = local.filter((candidate, index) =>
      !usedLocal.has(index)
      && [...objectiveIdentityValues(candidate)].some((id) => remoteIdentity.has(id)),
    );
    if (identityMatches.length === 1) return local.indexOf(identityMatches[0]);

    const description = normalizedObjectiveText(objective?.description);
    if (description) {
      const descriptionMatches = local
        .map((candidate, index) => ({ candidate, index }))
        .filter(({ candidate, index }) =>
          !usedLocal.has(index)
          && normalizedObjectiveText(candidate?.description) === description,
        );
      if (descriptionMatches.length === 1) return descriptionMatches[0].index;
      const refreshedItemId = objectiveItemIdentity(refreshed, refreshedIndex);
      if (refreshedItemId) {
        const itemMatches = descriptionMatches.filter(({ index }) =>
          objectiveItemIdentity(local, index) === refreshedItemId,
        );
        if (itemMatches.length === 1) return itemMatches[0].index;
      }
    }

    const type = normalizedObjectiveType(objective);
    if (!type) return -1;
    const signatureMatches = local
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate, index }) =>
        !usedLocal.has(index)
        && normalizedObjectiveType(candidate) === type
        && (
          !candidate?.itemId
          || !objective?.itemId
          || String(candidate.itemId) === String(objective.itemId)
        )
        && Number(candidate?.targetCount ?? 0) === Number(objective?.targetCount ?? 0)
        && objectiveMapsAreCompatible(candidate, objective, refreshedQuestLocations),
      );
    return signatureMatches.length === 1 ? signatureMatches[0].index : -1;
  };

  return refreshed.map((objective, refreshedIndex) => {
    const localIndex = findLocal(objective, refreshedIndex);
    if (localIndex < 0) return objective;
    usedLocal.add(localIndex);
    const existing = local[localIndex];
    const mapsCompatible = objectiveMapsAreCompatible(existing, objective, refreshedQuestLocations);
    const canPreserveLegacyPoints = mapsCompatible
      && normalizedObjectiveType(objective) !== "handover";
    const refreshedPoints = Array.isArray(objective.locationPoints) ? objective.locationPoints : [];
    const refreshedOptionalPoints = Array.isArray(objective.optionalPoints)
      ? objective.optionalPoints
      : [];
    const bsgId = String(objective?.bsgId ?? objective?.id ?? "");
    const legacyBsgIds = new Set([
      existing?.bsgId,
      ...(Array.isArray(existing?.bsgIdAliases) ? existing.bsgIdAliases : []),
    ].filter((id) => id && String(id) !== bsgId).map(String));
    return {
      ...existing,
      ...objective,
      id: existing.id,
      ...(bsgId ? { bsgId } : {}),
      ...(legacyBsgIds.size > 0 ? { bsgIdAliases: [...legacyBsgIds] } : {}),
      ...(objective?.mapName
        ? { mapName: objective.mapName }
        : (mapsCompatible && existing?.mapName ? { mapName: existing.mapName } : {})),
      locationPoints: refreshedPoints.length > 0
        ? refreshedPoints
        : (canPreserveLegacyPoints && Array.isArray(existing?.locationPoints)
          ? existing.locationPoints
          : []),
      optionalPoints: refreshedOptionalPoints.length > 0
        ? refreshedOptionalPoints
        : (canPreserveLegacyPoints && Array.isArray(existing?.optionalPoints)
          ? existing.optionalPoints
          : []),
    };
  });
}

function mergeQuestRecord(localQuest, refreshedQuest) {
  const canonicalName = refreshedQuest?.name ?? localQuest?.name;
  const legacyNames = new Set([
    ...(Array.isArray(localQuest?.nameAliases) ? localQuest.nameAliases : []),
    localQuest?.name,
    localQuest?.nameEn,
    localQuest?.nameKo,
    localQuest?.nameJa,
  ].filter((name) => typeof name === "string" && name.trim() && name !== canonicalName));
  const canonicalNameChanged = Boolean(
    refreshedQuest?.name && refreshedQuest.name !== localQuest?.name,
  );
  const refreshedBsgId = refreshedQuest?.bsgId ?? localQuest?.bsgId;
  const legacyBsgIds = new Set([
    ...(Array.isArray(localQuest?.bsgIdAliases) ? localQuest.bsgIdAliases : []),
    localQuest?.bsgId,
  ].filter((id) => id && String(id) !== String(refreshedBsgId)).map(String));
  return {
    ...localQuest,
    ...refreshedQuest,
    id: localQuest.id,
    bsgId: refreshedBsgId,
    ...(legacyBsgIds.size > 0 ? { bsgIdAliases: [...legacyBsgIds] } : {}),
    name: canonicalName,
    nameEn: refreshedQuest.nameEn ?? canonicalName ?? localQuest.nameEn,
    // This value was used as a storage key and deep-link identifier in older
    // releases, so keep it stable even when BSG renames the quest.
    normalizedName: localQuest.normalizedName ?? refreshedQuest.normalizedName,
    ...(legacyNames.size > 0 ? { nameAliases: [...legacyNames] } : {}),
    ...(!refreshedQuest.nameKo && canonicalNameChanged ? { nameKo: undefined } : {}),
    ...(!refreshedQuest.nameJa && canonicalNameChanged ? { nameJa: undefined } : {}),
    // Branch and follow-up links are rebuilt after every quest has been merged.
    // Keeping these arrays from an older bundle leaves renamed/reworked quest
    // chains connected to obsolete tasks.
    alternativeQuestIds: Array.isArray(refreshedQuest.alternativeQuestIds)
      ? refreshedQuest.alternativeQuestIds
      : [],
    followUpQuestIds: [],
    objectives: mergeQuestObjectives(
      localQuest.objectives,
      refreshedQuest.objectives,
      refreshedQuest.locations,
    ),
    requiredItems: Array.isArray(refreshedQuest.requiredItems)
      ? refreshedQuest.requiredItems
      : (localQuest.requiredItems ?? []),
  };
}

function localizedValue(dictionary, key, fallback = "") {
  const value = dictionary?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizedWikiIdentity(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value));
    return decodeURIComponent(`${url.hostname}${url.pathname}`)
      .replace(/\/+$/, "")
      .toLocaleLowerCase("en-US");
  } catch {
    return String(value).trim().replace(/\/+$/, "").toLocaleLowerCase("en-US");
  }
}

function normalizedItemIdentity(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function uniqueItemIndex(items, valueForItem) {
  const groups = new Map();
  for (const item of items) {
    const value = valueForItem(item);
    if (!value) continue;
    const group = groups.get(value) ?? [];
    group.push(item);
    groups.set(value, group);
  }
  return new Map(
    [...groups].flatMap(([value, group]) => group.length === 1 ? [[value, group[0]]] : []),
  );
}

export function collectTarkovDevTaskItemIds(...taskPayloads) {
  const result = new Set();
  const add = (value) => {
    const id = String(value ?? "");
    if (id) result.add(id);
  };
  for (const payload of taskPayloads) {
    for (const task of Object.values(payload?.tasks ?? {})) {
      for (const objective of Array.isArray(task?.objectives) ? task.objectives : []) {
        for (const id of Array.isArray(objective?.items) ? objective.items : []) add(id);
        add(objective?.questItem);
        add(objective?.markerItem);
        for (const group of Array.isArray(objective?.requiredKeys) ? objective.requiredKeys : []) {
          for (const id of Array.isArray(group) ? group : []) add(id);
        }
      }
      for (const requirement of Array.isArray(task?.neededKeys) ? task.neededKeys : []) {
        for (const id of Array.isArray(requirement?.keys) ? requirement.keys : []) add(id);
      }
      for (const reward of Array.isArray(task?.finishRewards?.items)
        ? task.finishRewards.items
        : []) add(reward?.item);
      for (const reward of Array.isArray(task?.finishRewards?.offerUnlock)
        ? task.finishRewards.offerUnlock
        : []) add(reward?.item);
    }
  }
  return [...result];
}

/**
 * Attach current BSG ids to the legacy Wiki item records without changing the
 * app ids used by saved inventories. Referenced quest-only items that are not
 * in the public item table are created from the localization dictionaries.
 */
export function mergeTarkovDevItems({
  localItems = [],
  data,
  english = {},
  korean = {},
  referencedItemIds = [],
}) {
  const availableLiveById = new Map(
    Object.values(data?.items ?? {})
      .filter((item) => item?.id)
      .map((item) => [String(item.id), item]),
  );
  const liveRecords = [...new Set(referencedItemIds.map((value) => String(value ?? "")))]
    .filter(Boolean)
    .map((bsgId) => {
      const live = availableLiveById.get(bsgId) ?? {
        id: bsgId,
        name: `${bsgId} Name`,
        shortName: `${bsgId} ShortName`,
        types: ["questItem"],
      };
      const nameEn = localizedValue(
        english,
        live?.name,
        localizedValue(english, `${bsgId} Name`, String(live?.normalizedName ?? bsgId)),
      );
      return {
        bsgId,
        live,
        nameEn,
        nameKey: normalizedItemIdentity(nameEn),
        wikiKey: normalizedWikiIdentity(live?.wikiLink),
      };
    });

  const generatedItemPrefix = "tarkovdata-item-";
  const isGeneratedItem = (item) => String(item?.id ?? "").startsWith(generatedItemPrefix);
  const localByBsgId = uniqueItemIndex(
    localItems,
    (item) => item?.bsgId ? String(item.bsgId) : "",
  );
  const semanticLocalItems = localItems.filter((item) => !item?.bsgId && !isGeneratedItem(item));
  const localByName = uniqueItemIndex(
    semanticLocalItems,
    (item) => normalizedItemIdentity(item?.nameEn ?? item?.name),
  );
  const localByWiki = uniqueItemIndex(
    semanticLocalItems,
    (item) => normalizedWikiIdentity(item?.wikiPageLink),
  );
  const uniqueLiveNameKeys = new Set(uniqueItemIndex(liveRecords, (record) => record.nameKey).keys());
  const uniqueLiveWikiKeys = new Set(uniqueItemIndex(liveRecords, (record) => record.wikiKey).keys());
  const assignedLocalByBsgId = new Map();
  const consumedLocalIds = new Set();
  const assignLocal = (record, localItem) => {
    const localId = String(localItem?.id ?? "");
    if (!localId || consumedLocalIds.has(localId)) return false;
    assignedLocalByBsgId.set(record.bsgId, localItem);
    consumedLocalIds.add(localId);
    return true;
  };

  for (const record of liveRecords) {
    const directMatch = localByBsgId.get(record.bsgId);
    if (directMatch && !isGeneratedItem(directMatch)) assignLocal(record, directMatch);
  }
  for (const record of liveRecords) {
    if (assignedLocalByBsgId.has(record.bsgId) || !uniqueLiveNameKeys.has(record.nameKey)) continue;
    assignLocal(record, localByName.get(record.nameKey));
  }
  for (const record of liveRecords) {
    if (assignedLocalByBsgId.has(record.bsgId) || !uniqueLiveWikiKeys.has(record.wikiKey)) continue;
    assignLocal(record, localByWiki.get(record.wikiKey));
  }
  for (const record of liveRecords) {
    if (assignedLocalByBsgId.has(record.bsgId)) continue;
    assignLocal(record, localByBsgId.get(record.bsgId));
  }

  const mergedByLocalId = new Map(localItems.map((item) => [String(item.id), item]));
  const supersededGeneratedIds = new Set();
  const itemIdByBsgId = new Map();
  const itemNamesByBsgId = new Map();

  for (const { bsgId, live, nameEn } of liveRecords) {
    const nameKo = localizedValue(korean, live?.name, localizedValue(korean, `${bsgId} Name`));
    const shortNameEn = localizedValue(english, live?.shortName, localizedValue(english, `${bsgId} ShortName`));
    const shortNameKo = localizedValue(korean, live?.shortName, localizedValue(korean, `${bsgId} ShortName`));
    const bsgMatch = localByBsgId.get(bsgId);
    const existing = assignedLocalByBsgId.get(bsgId);
    if (isGeneratedItem(bsgMatch) && existing && bsgMatch?.id !== existing.id) {
      supersededGeneratedIds.add(String(bsgMatch.id));
      mergedByLocalId.delete(String(bsgMatch.id));
    }
    const types = Array.isArray(live?.types) ? live.types.map(String) : [];
    const id = existing?.id ? String(existing.id) : `${generatedItemPrefix}${bsgId}`;
    const categories = [...new Set([
      ...(Array.isArray(existing?.categories) ? existing.categories : []),
      ...types,
    ])];
    const merged = {
      ...(existing ?? {}),
      id,
      bsgId,
      name: nameEn,
      nameEn,
      ...(nameKo && nameKo !== nameEn ? { nameKo } : {}),
      ...(shortNameEn ? { shortNameEn } : {}),
      ...(shortNameKo && shortNameKo !== shortNameEn ? { shortNameKo } : {}),
      ...(live?.wikiLink ? { wikiPageLink: String(live.wikiLink) } : {}),
      ...(types[0] ? { category: existing?.category ?? types[0] } : {}),
      categories,
      isDogtagItem: Boolean(
        existing?.isDogtagItem
        || types.some((type) => type.toLocaleLowerCase("en-US").includes("dogtag")),
      ),
    };
    mergedByLocalId.set(id, merged);
    itemIdByBsgId.set(bsgId, id);
    itemNamesByBsgId.set(bsgId, nameEn);
  }

  const originalLocalIds = new Set(localItems.map((item) => String(item.id)));
  const items = [
    ...localItems
      .filter((item) => !supersededGeneratedIds.has(String(item.id)))
      .map((item) => mergedByLocalId.get(String(item.id)) ?? item),
    ...[...mergedByLocalId.values()].filter((item) =>
      !originalLocalIds.has(String(item.id)),
    ),
  ];
  return { items, itemIdByBsgId, itemNamesByBsgId };
}

const REQUIRED_OBJECTIVE_TYPES = new Set([
  "finditem",
  "giveitem",
  "plantitem",
  "findquestitem",
  "givequestitem",
  "plantquestitem",
]);

function liveItemId(value, itemIdByBsgId) {
  const bsgId = String(value ?? "");
  if (!bsgId) return "";
  return itemIdByBsgId.get(bsgId) ?? `tarkovdata-item-${bsgId}`;
}

function liveItemName(value, itemNamesByBsgId) {
  const bsgId = String(value ?? "");
  return itemNamesByBsgId.get(bsgId) ?? bsgId;
}

function buildLiveRequiredItems(task, itemIdByBsgId, itemNamesByBsgId) {
  const byAcceptedItems = new Map();
  let sortOrder = 0;
  const addRequirement = ({
    sourceId,
    rawItemIds,
    count = 1,
    requiresFir = false,
    requirementType,
  }) => {
    const bsgIds = [...new Set((Array.isArray(rawItemIds) ? rawItemIds : [])
      .map(String)
      .filter(Boolean))];
    if (bsgIds.length === 0) return;
    const itemIds = bsgIds.map((id) => liveItemId(id, itemIdByBsgId));
    const itemNames = bsgIds.map((id) => liveItemName(id, itemNamesByBsgId));
    const key = itemIds.slice().sort().join("|");
    const existing = byAcceptedItems.get(key);
    const priority = requirementType === "Handover" ? 3 : requirementType === "Plant" ? 2 : 1;
    const normalizedCount = Math.max(1, Number(count) || 1);
    if (existing) {
      if (requirementType === "Plant" && !existing.plantSourceIds.has(sourceId)) {
        existing.plantSourceIds.add(sourceId);
        existing.plantCount += normalizedCount;
      }
      // A collect objective followed by a handover describes the same items,
      // while separate plant objectives consume one set at every location.
      existing.count = Math.max(existing.count, normalizedCount, existing.plantCount);
      existing.requiresFir = existing.requiresFir || Boolean(requiresFir);
      if (priority > existing.priority) {
        existing.requirementType = requirementType;
        existing.priority = priority;
      }
      return;
    }
    byAcceptedItems.set(key, {
      id: `${sourceId}-required-item`,
      itemId: itemIds[0],
      itemName: itemNames[0],
      count: normalizedCount,
      requiresFir: Boolean(requiresFir),
      requirementType,
      sortOrder: sortOrder++,
      ...(itemIds.length > 1 ? { alternativeItemIds: itemIds.slice(1) } : {}),
      ...(itemNames.length > 1 ? { alternativeItemNames: itemNames.slice(1) } : {}),
      priority,
      plantCount: requirementType === "Plant" ? normalizedCount : 0,
      plantSourceIds: new Set(requirementType === "Plant" ? [sourceId] : []),
    });
  };

  for (const objective of Array.isArray(task?.objectives) ? task.objectives : []) {
    const type = String(objective?.type ?? "").toLocaleLowerCase("en-US");
    if (REQUIRED_OBJECTIVE_TYPES.has(type)) {
      const rawItemIds = Array.isArray(objective?.items) && objective.items.length > 0
        ? objective.items
        : (objective?.questItem ? [objective.questItem] : []);
      addRequirement({
        sourceId: String(objective?.id ?? `objective-${sortOrder + 1}`),
        rawItemIds,
        count: objective?.count,
        requiresFir: objective?.foundInRaid,
        requirementType: type.includes("give")
          ? "Handover"
          : (type.includes("plant") ? "Plant" : "Collect"),
      });
    }
    if (objective?.markerItem) {
      addRequirement({
        sourceId: `${String(objective?.id ?? "objective")}-marker`,
        rawItemIds: [objective.markerItem],
        count: objective?.count,
        requirementType: "Plant",
      });
    }
    for (const [index, keyGroup] of (Array.isArray(objective?.requiredKeys)
      ? objective.requiredKeys
      : []).entries()) {
      addRequirement({
        sourceId: `${String(objective?.id ?? "objective")}-key-${index + 1}`,
        rawItemIds: keyGroup,
        requirementType: "Required",
      });
    }
  }
  for (const [index, needed] of (Array.isArray(task?.neededKeys) ? task.neededKeys : []).entries()) {
    addRequirement({
      sourceId: `${String(task?.id ?? "task")}-needed-key-${index + 1}`,
      rawItemIds: needed?.keys,
      requirementType: "Required",
    });
  }

  return [...byAcceptedItems.values()].map((requirement) => {
    const appRequirement = { ...requirement };
    delete appRequirement.priority;
    delete appRequirement.plantCount;
    delete appRequirement.plantSourceIds;
    return appRequirement;
  });
}

function buildLiveFinishRewards(task, traderNames, itemIdByBsgId, itemNamesByBsgId) {
  const finish = task?.finishRewards ?? {};
  const rawItems = Array.isArray(finish?.items) ? finish.items : [];
  const rewardRoubles = rawItems
    .filter((reward) => String(reward?.item ?? "") === "5449016a4bdc2d6f028b456f")
    .reduce((total, reward) => total + (Number(reward?.count) || 0), 0);
  const rewardItems = rawItems
    .filter((reward) => String(reward?.item ?? "") !== "5449016a4bdc2d6f028b456f")
    .map((reward, index) => {
      const bsgId = String(reward?.item ?? "");
      return {
        id: `${String(task?.id ?? "task")}-reward-item-${index + 1}`,
        itemId: liveItemId(bsgId, itemIdByBsgId),
        itemName: liveItemName(bsgId, itemNamesByBsgId),
        count: Number(reward?.count) || 0,
        sortOrder: index,
      };
    });
  const rewardReputation = (Array.isArray(finish?.traderStanding)
    ? finish.traderStanding
    : []).map((reward) => ({
      trader: traderNames.get(String(reward?.trader ?? "")) ?? String(reward?.trader ?? ""),
      amount: Number(reward?.standing) || 0,
    }));
  const rewardSkills = (Array.isArray(finish?.skillLevelReward)
    ? finish.skillLevelReward
    : []).map((reward) => ({
      skill: String(reward?.skill ?? ""),
      levels: Number(reward?.level) || 0,
    }));
  const rewardUnlocks = (Array.isArray(finish?.offerUnlock)
    ? finish.offerUnlock
    : []).map((reward) => liveItemName(reward?.item, itemNamesByBsgId));
  return {
    rewardItems,
    rewardRoubles,
    rewardReputation,
    rewardSkills,
    rewardUnlocks,
  };
}

/**
 * Normalize json.tarkov.dev's task endpoint into the source shape consumed by
 * mergeQuestSources. The endpoint uses localization keys for names/objectives
 * and trader ids, so resolving those here prevents placeholder labels from
 * entering the app bundle.
 */
export function normalizeTarkovDevTasks({
  data,
  english = {},
  korean = {},
  maps = {},
  traders = [],
  itemIdByBsgId = new Map(),
  itemNamesByBsgId = new Map(),
}) {
  const traderNames = new Map(
    traders
      .filter((trader) => trader?.id && trader?.name)
      .map((trader) => [String(trader.id), String(trader.name)]),
  );
  const mapName = (value) => {
    const raw = String(value ?? "");
    return mapDisplayName(localizedValue(maps, `${raw} Name`, mapDisplayName(raw)));
  };
  const tasks = Object.values(data?.tasks ?? {});
  const failedQuestIdsByCompletedTask = new Map();
  for (const task of tasks) {
    const failedQuestId = String(task?.id ?? "");
    for (const condition of Array.isArray(task?.failConditions) ? task.failConditions : []) {
      if (String(condition?.type ?? "").toLocaleLowerCase("en-US") !== "taskstatus") continue;
      const statuses = Array.isArray(condition?.status) ? condition.status : [condition?.status];
      const failsOnCompletion = statuses.some((status) => (
        String(status ?? "").toLocaleLowerCase("en-US") === "complete"
      ));
      const completedQuestId = String(condition?.task ?? "");
      if (!failsOnCompletion || !completedQuestId || !failedQuestId) continue;
      const failedQuestIds = failedQuestIdsByCompletedTask.get(completedQuestId) ?? new Set();
      failedQuestIds.add(failedQuestId);
      failedQuestIdsByCompletedTask.set(completedQuestId, failedQuestIds);
    }
  }
  return tasks.map((task) => {
    const id = String(task?.id ?? "");
    const fallbackName = String(task?.name ?? id ?? "Unknown quest").replace(/ name$/, "");
    const objectives = Array.isArray(task?.objectives)
      ? task.objectives.map((objective) => {
          const objectiveId = String(objective?.id ?? "");
          const mappedItems = (Array.isArray(objective?.items) ? objective.items : [])
            .map((itemId) => liveItemId(itemId, itemIdByBsgId))
            .filter(Boolean);
          const mappedQuestItem = objective?.questItem
            ? liveItemId(objective.questItem, itemIdByBsgId)
            : undefined;
          const mappedRequiredKeys = (Array.isArray(objective?.requiredKeys)
            ? objective.requiredKeys
            : []).map((group) => (Array.isArray(group) ? group : [])
              .map((itemId) => liveItemId(itemId, itemIdByBsgId))
              .filter(Boolean));
          const possibleLocations = Array.isArray(objective?.possibleLocations)
            ? objective.possibleLocations.map((location) => ({
                map: mapName(location?.map),
                optional: true,
                positions: (Array.isArray(location?.positions) ? location.positions : [])
                  .map(worldPoint)
                  .filter(Boolean),
              }))
            : [];
          const zoneLocations = Array.isArray(objective?.zones)
            ? objective.zones.map((zone) => {
                const outline = (Array.isArray(zone?.outline) ? zone.outline : [])
                  .map(worldPoint)
                  .filter(Boolean);
                const position = worldPoint(zone?.position);
                return {
                  map: mapName(zone?.map),
                  optional: false,
                  positions: outline.length > 0 ? outline : (position ? [position] : []),
                };
              })
            : [];
          const positionedMaps = new Set(
            [...possibleLocations, ...zoneLocations].map((location) => location.map),
          );
          const mapOnlyLocations = (Array.isArray(objective?.maps) ? objective.maps : [])
            .map((map) => mapName(map))
            .filter((map) => !positionedMaps.has(map))
            .map((map) => ({ map, optional: false, positions: [] }));
          return {
            ...objective,
            items: mappedItems,
            ...(mappedQuestItem ? { questItem: mappedQuestItem } : {}),
            requiredKeys: mappedRequiredKeys,
            description: localizedValue(english, objectiveId, String(objective?.description ?? objective?.type ?? "Objective")),
            ...(localizedValue(korean, objectiveId)
              ? { descriptionKo: localizedValue(korean, objectiveId) }
              : {}),
            ...((possibleLocations.length > 0 || zoneLocations.length > 0 || mapOnlyLocations.length > 0)
              ? { locations: [...possibleLocations, ...zoneLocations, ...mapOnlyLocations] }
              : {}),
          };
        })
      : [];
    const finishRewards = buildLiveFinishRewards(
      task,
      traderNames,
      itemIdByBsgId,
      itemNamesByBsgId,
    );
    const rewardXp = Number(task?.experience);
    const name = localizedValue(english, `${id} name`, fallbackName);
    const nameKo = localizedValue(korean, `${id} name`);
    return {
      ...task,
      id,
      gameId: id,
      name,
      ...(nameKo && nameKo !== name ? { nameKo } : {}),
      trader: traderNames.get(String(task?.trader ?? "")) ?? String(task?.trader ?? ""),
      map: mapName(task?.map),
      wiki: typeof task?.wikiLink === "string" ? task.wikiLink : undefined,
      ...(Number.isFinite(rewardXp) ? { rewardXp } : {}),
      ...finishRewards,
      requiredItems: buildLiveRequiredItems(task, itemIdByBsgId, itemNamesByBsgId),
      alternativeQuestIds: [...(failedQuestIdsByCompletedTask.get(id) ?? [])],
      requirements: Array.isArray(task?.taskRequirements)
        ? task.taskRequirements.flatMap((requirement, index) => {
            const statuses = Array.isArray(requirement?.status) && requirement.status.length > 0
              ? requirement.status
              : ["Complete"];
            return statuses.map((status) => ({
              questId: String(requirement?.task ?? ""),
              requirementType: String(status),
              groupId: index + 1,
            }));
          })
        : [],
      traderRequirements: Array.isArray(task?.traderRequirements)
        ? task.traderRequirements.map((requirement, index) => {
            const traderId = String(requirement?.trader ?? "");
            return {
              id: String(requirement?.id ?? `${id}-trader-requirement-${index + 1}`),
              traderId,
              ...(traderNames.get(traderId) ? { traderName: traderNames.get(traderId) } : {}),
              requirementType: String(requirement?.requirementType ?? "unknown"),
              compareMethod: String(requirement?.compareMethod ?? ">="),
              value: Number(requirement?.value ?? 0),
            };
          })
        : [],
      otherRequirements: Array.isArray(task?.otherRequirements)
        ? task.otherRequirements.map((requirement, index) => {
            const traderIds = Array.isArray(requirement?.traders)
              ? requirement.traders.map(String)
              : [];
            const value = Number(requirement?.value);
            return {
              id: String(requirement?.id ?? `${id}-other-requirement-${index + 1}`),
              type: String(requirement?.type ?? "unknown"),
              ...(traderIds.length > 0
                ? {
                    traderIds,
                    traderNames: traderIds.map((traderId) => traderNames.get(traderId) ?? traderId),
                  }
                : {}),
              ...(requirement?.variableId ? { variableId: String(requirement.variableId) } : {}),
              ...(requirement?.compareMethod
                ? { compareMethod: String(requirement.compareMethod) }
                : {}),
              ...(Number.isFinite(value) ? { value } : {}),
            };
          })
        : [],
      objectives,
    };
  }).filter((task) => task.id);
}

function hasLocalMatch(remoteQuest, localByBsgId, localByName) {
  const remoteId = remoteQuest?.gameId ? String(remoteQuest.gameId) : "";
  if (remoteId && localByBsgId.has(remoteId)) return true;
  if (remoteId) return false;
  return localByName.has(normalizeQuestName(remoteQuest?.name));
}

function questRelationshipLookup(quests) {
  const exact = new Map();
  const normalized = new Map();
  const ambiguous = Symbol("ambiguous quest relationship");
  const register = (lookup, key, quest) => {
    if (!key) return;
    const existing = lookup.get(key);
    if (!existing) lookup.set(key, quest);
    else if (existing !== quest) lookup.set(key, ambiguous);
  };

  for (const quest of quests) {
    const exactKeys = [
      quest?.id,
      quest?.bsgId,
      ...(Array.isArray(quest?.bsgIdAliases) ? quest.bsgIdAliases : []),
    ];
    for (const key of exactKeys) register(exact, String(key ?? ""), quest);

    const nameKeys = [
      quest?.normalizedName,
      quest?.name,
      quest?.nameEn,
      quest?.nameKo,
      quest?.nameJa,
      ...(Array.isArray(quest?.nameAliases) ? quest.nameAliases : []),
    ];
    for (const key of nameKeys) register(normalized, normalizeQuestName(key), quest);
  }

  return (reference) => {
    const raw = String(reference ?? "");
    const exactMatch = exact.get(raw);
    if (exactMatch && exactMatch !== ambiguous) return exactMatch;
    const normalizedMatch = normalized.get(normalizeQuestName(raw));
    return normalizedMatch && normalizedMatch !== ambiguous ? normalizedMatch : undefined;
  };
}

function rebuildQuestRelationships(quests) {
  const resolveQuest = questRelationshipLookup(quests);
  const alternatives = new Map(quests.map((quest) => [quest.id, new Set()]));
  const followUps = new Map(quests.map((quest) => [quest.id, new Set()]));

  for (const quest of quests) {
    for (const requirement of Array.isArray(quest?.requirements) ? quest.requirements : []) {
      const requirementType = String(requirement?.requirementType ?? "complete")
        .toLocaleLowerCase("en-US");
      if (!["complete", "completed", "done", "success"].includes(requirementType)) continue;
      const prerequisite = resolveQuest(requirement?.questId);
      if (prerequisite && prerequisite.id !== quest.id) {
        followUps.get(prerequisite.id)?.add(quest.id);
      }
    }

    for (const reference of Array.isArray(quest?.alternativeQuestIds)
      ? quest.alternativeQuestIds
      : []) {
      const alternative = resolveQuest(reference);
      if (!alternative || alternative.id === quest.id) continue;
      alternatives.get(quest.id)?.add(alternative.id);
    }
  }

  const collector = quests.find((quest) => (
    [quest?.name, quest?.nameEn, ...(Array.isArray(quest?.nameAliases) ? quest.nameAliases : [])]
      .some((name) => normalizeQuestName(name) === "collector")
  ));
  if (collector) {
    for (const quest of quests) {
      if (quest.id !== collector.id && quest.kappaRequired) {
        followUps.get(quest.id)?.add(collector.id);
      }
    }
  }

  return quests.map((quest) => ({
    ...quest,
    alternativeQuestIds: [...(alternatives.get(quest.id) ?? [])],
    followUpQuestIds: [...(followUps.get(quest.id) ?? [])],
  }));
}

function ensureUniqueObjectiveAppIds(quests) {
  const counts = new Map();
  for (const quest of quests) {
    for (const objective of Array.isArray(quest?.objectives) ? quest.objectives : []) {
      const id = String(objective?.id ?? "");
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  const used = new Set(
    [...counts].filter(([, count]) => count === 1).map(([id]) => id),
  );
  return quests.map((quest) => ({
    ...quest,
    objectives: (Array.isArray(quest?.objectives) ? quest.objectives : []).map(
      (objective, index) => {
        const currentId = String(objective?.id ?? "");
        if (currentId && counts.get(currentId) === 1) return objective;

        const upstreamId = String(objective?.bsgId ?? currentId ?? `objective-${index + 1}`);
        const baseId = objectiveAppId(String(quest.id), upstreamId || `objective-${index + 1}`);
        let id = baseId;
        let suffix = 2;
        while (used.has(id)) {
          id = `${baseId}:${suffix}`;
          suffix += 1;
        }
        used.add(id);
        const progressIdAliases = [...new Set([
          ...(Array.isArray(objective?.progressIdAliases)
            ? objective.progressIdAliases
            : []),
          currentId,
        ].map(String).filter((alias) => alias && alias !== id))];
        return {
          ...objective,
          id,
          ...(progressIdAliases.length > 0 ? { progressIdAliases } : {}),
        };
      },
    ),
  }));
}

export function mergeQuestSources(localPack, tarkovData, wikiMeta = {}) {
  const localQuests = Array.isArray(localPack?.quests) ? localPack.quests : [];
  const remoteQuests = Array.isArray(tarkovData?.quests) ? tarkovData.quests : [];
  const uniqueRemoteByIdentity = new Map();
  for (const quest of remoteQuests) {
    const gameId = quest?.gameId ? String(quest.gameId) : "";
    const key = gameId ? `bsg:${gameId}` : `name:${normalizeQuestName(quest?.name)}`;
    if (key !== "name:") uniqueRemoteByIdentity.set(key, quest);
  }
  // Multiple upstream feeds are ordered oldest -> newest; Map assignment keeps
  // the original position while replacing the value with the authoritative one.
  const authoritativeRemoteQuests = [...uniqueRemoteByIdentity.values()];
  const remoteByBsgId = new Map(
    authoritativeRemoteQuests
      .filter((quest) => quest?.gameId)
      .map((quest) => [String(quest.gameId), quest]),
  );
  const localByBsgId = new Set(
    localQuests.filter((quest) => quest?.bsgId).map((quest) => String(quest.bsgId)),
  );
  const localByName = new Set(localQuests.map((quest) => normalizeQuestName(quest?.name)));
  const preservedQuests = localQuests.map((quest) => {
    const remote = quest?.bsgId
      ? remoteByBsgId.get(String(quest.bsgId))
      : undefined;
    return remote ? mergeQuestRecord(quest, toAppQuest(remote)) : quest;
  });
  const additions = authoritativeRemoteQuests
    .filter((quest) => !hasLocalMatch(quest, localByBsgId, localByName))
    .map(toAppQuest)
    .sort((left, right) => left.name.localeCompare(right.name));
  const quests = rebuildQuestRelationships(
    ensureUniqueObjectiveAppIds(
      applyWikiQuestRenames([...preservedQuests, ...additions])
        .map(applyQuestObjectiveMapOverrides),
    ),
  );
  const localMeta = localPack?.meta ?? {};
  const remoteGenerated = tarkovData?.meta?.generated;
  const sources = {
    ...(localMeta.sources ?? {}),
    localExportedAt: localMeta.sources?.localExportedAt ?? localMeta.exportedAt ?? null,
    tarkovDataGeneratedAt: remoteGenerated ?? null,
    tarkovDataQuestCount: Number(tarkovData?.meta?.count ?? remoteQuests.length),
    ...(Number.isFinite(Number(tarkovData?.meta?.liveTaskCount))
      ? { liveTaskCount: Number(tarkovData.meta.liveTaskCount) }
      : {}),
    ...(tarkovData?.meta?.liveTaskSource ? { liveTaskSource: tarkovData.meta.liveTaskSource } : {}),
    wikiQuestCount: Number(wikiMeta.wikiQuestCount ?? 0),
    wikiRevisionTimestamp: wikiMeta.wikiRevisionTimestamp ?? null,
    refreshMode: "bsg-id-authoritative-mode-catalogs",
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
