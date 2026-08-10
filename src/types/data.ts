export type ProfileType = "pvp" | "pve";

export interface DataMeta {
  originalCommit: string;
  modifiedCommit: string;
  exportedAt: string;
  sources?: {
    localExportedAt?: string | null;
    tarkovDataGeneratedAt?: string | null;
    tarkovDataQuestCount?: number;
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

export interface QuestObjective {
  id: string;
  sortOrder: number;
  objectiveType: string;
  description: string;
  descriptionKo?: string;
  targetType?: string;
  targetCount?: number;
  itemId?: string;
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
  items: ItemData[];
  hideoutStations: HideoutStation[];
  traders: TraderData[];
  mapConfigs: MapConfig[];
  mapMarkers: MapMarker[];
  mapFloorLocations: MapFloorLocation[];
  /** Optional enrichment generated by scripts/refresh-quest-wiki-guides.mjs. */
  questWikiGuides?: Record<string, QuestWikiGuide>;
}
