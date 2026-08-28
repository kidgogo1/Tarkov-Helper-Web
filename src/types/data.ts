export type ProfileType = "pvp" | "pve";

export interface DataMeta {
  originalCommit: string;
  modifiedCommit: string;
  exportedAt: string;
  sources?: {
    localExportedAt?: string | null;
    tarkovDataGeneratedAt?: string | null;
    tarkovDataQuestCount?: number;
    liveTaskCount?: number;
    liveTaskSource?: string;
    wikiQuestCount?: number;
    wikiRevisionTimestamp?: string | null;
    refreshMode?: string;
    koreanLocalizationSource?: string;
    koreanLocalizedQuests?: number;
    koreanLocalizedObjectives?: number;
    wikiRewardQuestCount?: number;
    wikiRewardItemCount?: number;
    wikiRewardUnmappedLineCount?: number;
    wikiLocationVerifiedAt?: string | null;
    wikiLocationVerifiedQuests?: number;
    wikiLocationCorrections?: number;
    wikiLinkCorrections?: number;
    wikiLinkUnverifiedQuests?: number;
    questCatalogCounts?: {
      regular: number;
      pve: number;
      pvpSeason: number;
    };
  };
  counts: {
    quests: number;
    items: number;
    hideoutStations: number;
    maps: number;
    mapMarkers: number;
  };
}

export interface QuestRequirement {
  questId: string;
  requirementType: string;
  groupId: number;
}

/** A current live-task gate based on a trader's loyalty level or reputation. */
export interface QuestTraderRequirement {
  id: string;
  traderId: string;
  traderName?: string;
  requirementType: string;
  compareMethod: string;
  value: number;
}

/** A live-task gate that cannot be inferred safely from the local profile. */
export interface QuestOtherRequirement {
  id: string;
  type: string;
  traderIds?: string[];
  traderNames?: string[];
  variableId?: string;
  compareMethod?: string;
  value?: number;
}

export interface QuestItemRequirement {
  id: string;
  itemId: string;
  itemName: string;
  count: number;
  requiresFir: boolean;
  requirementType: string;
  sortOrder: number;
  dogtagMinLevel?: number;
  dogtagFaction?: string;
  /** Alternative items accepted by the same live objective (OR, not AND). */
  alternativeItemIds?: string[];
  alternativeItemNames?: string[];
}

/** An item granted when a quest is turned in. Older data packs may omit this. */
export interface QuestRewardItem {
  id: string;
  itemId: string;
  itemName: string;
  count: number;
  requiresFir?: boolean;
  requirementType?: string;
  sortOrder: number;
}

export interface QuestRewardReputation {
  trader: string;
  amount: number;
}

export interface QuestRewardSkill {
  skill: string;
  levels: number;
}

export interface WorldPoint {
  x: number;
  y: number;
  z: number;
  floorId?: string;
}

export interface QuestObjectiveMapLocation {
  mapName: string;
  locationPoints: WorldPoint[];
  optionalPoints: WorldPoint[];
}

export interface QuestObjective {
  id: string;
  /** Older app storage keys retained when a duplicate id had to be namespaced. */
  progressIdAliases?: string[];
  /** Current BSG objective id; `id` remains stable for saved checklist state. */
  bsgId?: string;
  bsgIdAliases?: string[];
  sortOrder: number;
  objectiveType: string;
  description: string;
  descriptionKo?: string;
  targetType?: string;
  targetCount?: number;
  itemId?: string;
  alternativeItemIds?: string[];
  questItemId?: string;
  mapNames?: string[];
  /** World positions grouped by map; legacy fields below hold the primary map only. */
  mapLocations?: QuestObjectiveMapLocation[];
  requiredKeyGroups?: string[][];
  isOptional?: boolean;
  requiresFir: boolean;
  mapName?: string;
  locationName?: string;
  locationPoints: WorldPoint[];
  optionalPoints: WorldPoint[];
  conditions?: unknown;
  dogtagMinLevel?: number;
  dogtagFaction?: string;
}

export interface QuestData {
  id: string;
  bsgId?: string;
  /** Historical BSG ids retained for older logs and imported progress. */
  bsgIdAliases?: string[];
  normalizedName: string;
  name: string;
  nameEn: string;
  /** Older app/wiki titles retained for backwards-compatible search. */
  nameAliases?: string[];
  nameKo?: string;
  nameJa?: string;
  wikiPageLink?: string;
  trader: string;
  locations: string[];
  minLevel?: number;
  minScavKarma?: number;
  kappaRequired: boolean;
  faction?: string;
  requiredEdition?: string;
  excludedEdition?: string;
  requiredDecodeCount?: number;
  requiredPrestigeLevel?: number;
  requirements: QuestRequirement[];
  traderRequirements?: QuestTraderRequirement[];
  otherRequirements?: QuestOtherRequirement[];
  alternativeQuestIds: string[];
  followUpQuestIds: string[];
  objectives: QuestObjective[];
  requiredItems: QuestItemRequirement[];
  rewardItems?: QuestRewardItem[];
  rewardXp?: number;
  rewardRoubles?: number;
  rewardReputation?: QuestRewardReputation[];
  rewardSkills?: QuestRewardSkill[];
  rewardUnlocks?: string[];
  rewardText?: string[];
}

/**
 * Mode-specific quest lists shipped alongside the legacy regular quest list.
 * Optional fields keep data packs created before mode catalogs compatible.
 */
export interface QuestCatalogs {
  pve?: QuestData[];
  pvpSeason?: QuestData[];
}

/**
 * A Wiki-verified location guide. Image URLs stay on the Wiki CDN; the app
 * stores only the link and caption so refreshes never republish third-party
 * artwork into the release package.
 */
export interface QuestWikiGuideImage {
  url: string;
  caption: string;
}

export interface QuestWikiGuide {
  wikiTitle?: string;
  wikiPageLink: string;
  wikiRevisionId?: number;
  wikiLocation: string[];
  wikiObjectives: string[];
  /** Distinguishes a page with no Objectives section from an outdated empty parse. */
  wikiObjectivesSectionPresent?: boolean;
  guideSummary: string;
  images: QuestWikiGuideImage[];
  error?: string;
}

export interface ItemData {
  id: string;
  bsgId?: string;
  name: string;
  nameEn: string;
  nameKo?: string;
  nameJa?: string;
  shortNameEn?: string;
  shortNameKo?: string;
  shortNameJa?: string;
  wikiPageLink?: string;
  category?: string;
  categories: string[];
  isDogtagItem: boolean;
  dogtagFaction?: string;
  localIcon?: string;
}

/**
 * Keys and keycards grouped by the map pages that reference them.
 * Coordinates are intentionally kept out of this index: map pages only tell
 * us which items belong to a map, while user-confirmed marker coordinates are
 * stored in the active profile.
 */
export type MapKeyItemIndex = Record<string, string[]>;

export interface HideoutItemRequirement {
  id: string;
  itemId: string;
  itemName: string;
  itemNameKo?: string;
  itemNameJa?: string;
  count: number;
  foundInRaid: boolean;
  sortOrder: number;
}

export interface HideoutStationRequirement {
  id: string;
  stationId: string;
  stationName: string;
  stationNameKo?: string;
  stationNameJa?: string;
  requiredLevel: number;
  sortOrder: number;
}

export interface HideoutNamedLevelRequirement {
  id: string;
  name: string;
  nameKo?: string;
  nameJa?: string;
  requiredLevel: number;
  sortOrder: number;
}

export interface HideoutLevel {
  id: string;
  level: number;
  constructionTime: number;
  items: HideoutItemRequirement[];
  stations: HideoutStationRequirement[];
  traders: HideoutNamedLevelRequirement[];
  skills: HideoutNamedLevelRequirement[];
}

export interface HideoutStation {
  id: string;
  name: string;
  nameKo?: string;
  nameJa?: string;
  normalizedName: string;
  maxLevel: number;
  localIcon?: string;
  levels: HideoutLevel[];
}

export interface TraderData {
  id: string;
  name: string;
  nameKo?: string;
  nameJa?: string;
  normalizedName: string;
}

export interface MapFloor {
  layerId: string;
  displayName: string;
  order: number;
  isDefault: boolean;
}

export interface MapConfig {
  key: string;
  displayName: string;
  svgFileName: string;
  imageWidth: number;
  imageHeight: number;
  aliases: string[];
  playerMarkerTransform?: number[];
  calibratedTransform?: number[];
  transform?: number[];
  svgBounds?: number[];
  mapRotation?: number;
  markerScale?: number;
  floors: MapFloor[];
}

export interface MapMarker {
  id: string;
  name: string;
  nameKo?: string;
  markerType: string;
  mapKey: string;
  x: number;
  y: number;
  z: number;
  floorId?: string;
}

export interface MapFloorLocation {
  id: string;
  mapKey: string;
  floorId: string;
  regionName?: string;
  minY: number;
  maxY: number;
  minX?: number;
  maxX?: number;
  minZ?: number;
  maxZ?: number;
  priority: number;
}

export interface TarkovData {
  meta: DataMeta;
  quests: QuestData[];
  /**
   * `quests` remains the regular catalog for backwards compatibility. These
   * optional catalogs override it only for their matching player profile.
   */
  questCatalogs?: QuestCatalogs;
  items: ItemData[];
  hideoutStations: HideoutStation[];
  traders: TraderData[];
  mapConfigs: MapConfig[];
  mapMarkers: MapMarker[];
  mapFloorLocations: MapFloorLocation[];
  /** Optional Wiki-derived map → key item ids enrichment. */
  mapKeyItemIds?: MapKeyItemIndex;
  /** Optional enrichment generated by scripts/refresh-quest-wiki-guides.mjs. */
  questWikiGuides?: Record<string, QuestWikiGuide>;
}
