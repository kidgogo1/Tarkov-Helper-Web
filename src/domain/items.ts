import type {
  HideoutStation,
  ItemData,
  QuestData,
} from "../types/data";
import type { InventoryAmount, ProfileState } from "../types/state";
import {
  createQuestStatusResolver,
  type QuestStatusResolver,
} from "./quests";

export type ItemFulfillmentStatus =
  | "notStarted"
  | "partiallyFulfilled"
  | "fulfilled";

export interface QuestItemSource {
  questId: string;
  questNormalizedName: string;
  questName: string;
  traderName: string;
  requiredCount: number;
  requiresFir: boolean;
  kappaRequired: boolean;
}

export interface HideoutItemSource {
  stationId: string;
  stationNormalizedName: string;
  stationName: string;
  level: number;
  requiredCount: number;
  requiresFir: boolean;
}

export interface AggregatedItemRequirement {
  itemId: string;
  displayName: string;
  subtitleName: string;
  category?: string;
  parentCategory: string;
  wikiPageLink?: string;
  localIcon?: string;
  questCount: number;
  questFirCount: number;
  hideoutCount: number;
  hideoutFirCount: number;
  completedQuestCount: number;
  completedQuestFirCount: number;
  completedHideoutCount: number;
  completedHideoutFirCount: number;
  completedCount: number;
  completedFirCount: number;
  allRequiredCount: number;
  allRequiredFirCount: number;
  totalCount: number;
  totalFirCount: number;
  foundInRaid: boolean;
  ownedFir: number;
  ownedNonFir: number;
  ownedTotal: number;
  shortage: number;
  firShortage: number;
  fulfillmentStatus: ItemFulfillmentStatus;
  progressPercent: number;
  isFulfilled: boolean;
  isQuestOnly: boolean;
  isHideoutOnly: boolean;
  isBothRequired: boolean;
  questSources: QuestItemSource[];
  hideoutSources: HideoutItemSource[];
  completedQuestSources: QuestItemSource[];
  completedHideoutSources: HideoutItemSource[];
}

interface MutableAggregate {
  item: ItemData;
  questCount: number;
  questFirCount: number;
  hideoutCount: number;
  hideoutFirCount: number;
  completedQuestCount: number;
  completedQuestFirCount: number;
  completedHideoutCount: number;
  completedHideoutFirCount: number;
  questSources: QuestItemSource[];
  hideoutSources: HideoutItemSource[];
  completedQuestSources: QuestItemSource[];
  completedHideoutSources: HideoutItemSource[];
}

export interface ItemFulfillment {
  status: ItemFulfillmentStatus;
  progressPercent: number;
  isFulfilled: boolean;
}

export interface ItemFilterOptions {
  searchText?: string;
  source?: "all" | "quest" | "hideout" | "All" | "Quest" | "Hideout";
  category?: string;
  fulfillment?:
    | "all"
    | "notStarted"
    | "inProgress"
    | "fulfilled"
    | "All"
    | "NotStarted"
    | "InProgress"
    | "Fulfilled";
  firOnly?: boolean;
  hideFulfilled?: boolean;
  sortBy?:
    | "name"
    | "total"
    | "quest"
    | "hideout"
    | "progress"
    | "Name"
    | "Total"
    | "Quest"
    | "Hideout"
    | "Progress";
}

export interface AggregatedItemStatistics {
  totalUniqueItems: number;
  totalRequired: number;
  totalOwned: number;
  totalShortage: number;
  shortageItemCount: number;
  questOnlyCount: number;
  hideoutOnlyCount: number;
  bothRequiredCount: number;
  fulfilledCount: number;
  overallProgress: number;
}

const CURRENCY_NAMES = new Set(["roubles", "dollars", "euros"]);

const CATEGORY_MAPPING = new Map<string, string>([
  ["food", "Provisions"],
  ["drinks", "Provisions"],
  ["medkits", "Medical"],
  ["medical supplies", "Medical"],
  ["injury treatment", "Medical"],
  ["stimulants", "Medical"],
  ["drugs", "Medical"],
  ["armor vests", "Gear"],
  ["armor plates", "Gear"],
  ["chest rigs", "Gear"],
  ["backpacks", "Gear"],
  ["headwear", "Gear"],
  ["eyewear", "Gear"],
  ["face cover", "Gear"],
  ["earpieces", "Gear"],
  ["armbands", "Gear"],
  ["special equipment", "Gear"],
  ["electronics", "Barter"],
  ["building materials", "Barter"],
  ["flammable materials", "Barter"],
  ["energy elements", "Barter"],
  ["household goods", "Barter"],
  ["tools", "Barter"],
  ["valuables", "Barter"],
  ["other", "Barter"],
  ["info items", "Info & Keys"],
  ["keys", "Info & Keys"],
  ["keycards", "Info & Keys"],
  ["maps", "Info & Keys"],
  ["extraction intel", "Info & Keys"],
  ["containers & cases", "Containers"],
  ["secure containers", "Containers"],
  ["money", "Money"],
  ["rounds", "Ammo"],
  ["ammo boxes", "Ammo"],
  ["shrapnel", "Ammo"],
  ["mounts", "Weapon Mods"],
  ["stocks & chassis", "Weapon Mods"],
  ["handguards", "Weapon Mods"],
  ["barrels", "Weapon Mods"],
  ["magazines", "Weapon Mods"],
  ["flash hiders & muzzle brakes", "Weapon Mods"],
  ["suppressors", "Weapon Mods"],
  ["muzzle adapters", "Weapon Mods"],
  ["iron sights", "Weapon Mods"],
  ["pistol grips", "Weapon Mods"],
  ["receivers and slides", "Weapon Mods"],
  ["charging handles", "Weapon Mods"],
  ["gas blocks", "Weapon Mods"],
  ["foregrips", "Weapon Mods"],
  ["auxiliary parts", "Weapon Mods"],
  ["bipods", "Weapon Mods"],
  ["underbarrel grenade launchers", "Weapon Mods"],
  ["scopes", "Optics"],
  ["assault scopes", "Optics"],
  ["reflex sights", "Optics"],
  ["compact reflex sights", "Optics"],
  ["night vision scopes", "Optics"],
  ["thermal vision sights", "Optics"],
  ["flashlights", "Tactical"],
  ["tactical combo devices", "Tactical"],
  ["helmet mods", "Helmet Mods"],
  ["weapons", "Weapons"],
  ["quest items", "Quest Items"],
  ["posters", "Misc"],
  ["dogtag", "Misc"],
]);

function normalize(value: string | undefined): string {
  return value?.normalize("NFKC").trim().toLocaleLowerCase("en-US") ?? "";
}

function getRecordValue<T>(
  record: Readonly<Record<string, T>>,
  ...keys: Array<string | undefined>
): T | undefined {
  for (const key of keys) {
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
    const normalized = normalize(key);
    const match = Object.keys(record).find(
      (candidate) => normalize(candidate) === normalized,
    );
    if (match !== undefined) return record[match];
  }
  return undefined;
}

function buildItemLookup(items: readonly ItemData[]): Map<string, ItemData> {
  const result = new Map<string, ItemData>();
  for (const item of items) {
    for (const key of [item.id, item.bsgId, item.name, item.nameEn]) {
      const normalized = normalize(key);
      if (normalized && !result.has(normalized)) result.set(normalized, item);
    }
  }
  return result;
}

function findItem(
  lookup: ReadonlyMap<string, ItemData>,
  itemId: string,
  itemName: string,
): ItemData | undefined {
  return lookup.get(normalize(itemId)) ?? lookup.get(normalize(itemName));
}

function isCurrency(item: ItemData, requirementName: string): boolean {
  return [item.id, item.name, item.nameEn, requirementName].some((candidate) =>
    CURRENCY_NAMES.has(normalize(candidate)),
  );
}

function getInventory(
  profile: Pick<ProfileState, "inventory">,
  item: ItemData,
): InventoryAmount {
  return (
    getRecordValue(profile.inventory, item.id, item.bsgId, item.name, item.nameEn) ?? {
      fir: 0,
      nonFir: 0,
    }
  );
}

function getHideoutLevel(
  profile: Pick<ProfileState, "hideoutLevels">,
  station: HideoutStation,
): number {
  return (
    getRecordValue(
      profile.hideoutLevels,
      station.normalizedName,
      station.id,
      station.name,
    ) ?? 0
  );
}

function getOrCreateAggregate(
  aggregates: Map<string, MutableAggregate>,
  item: ItemData,
): MutableAggregate {
  const key = normalize(item.id);
  const existing = aggregates.get(key);
  if (existing) return existing;

  const created: MutableAggregate = {
    item,
    questCount: 0,
    questFirCount: 0,
    hideoutCount: 0,
    hideoutFirCount: 0,
    completedQuestCount: 0,
    completedQuestFirCount: 0,
    completedHideoutCount: 0,
    completedHideoutFirCount: 0,
    questSources: [],
    hideoutSources: [],
    completedQuestSources: [],
    completedHideoutSources: [],
  };
  aggregates.set(key, created);
  return created;
}

function localizedSubtitle(item: ItemData): string {
  return item.nameKo ?? item.nameJa ?? "";
}

function finalizeAggregate(
  aggregate: MutableAggregate,
  profile: Pick<ProfileState, "inventory">,
): AggregatedItemRequirement {
  const totalCount = aggregate.questCount + aggregate.hideoutCount;
  const totalFirCount = aggregate.questFirCount + aggregate.hideoutFirCount;
  const completedCount =
    aggregate.completedQuestCount + aggregate.completedHideoutCount;
  const completedFirCount =
    aggregate.completedQuestFirCount + aggregate.completedHideoutFirCount;
  const allRequiredCount = totalCount + completedCount;
  const allRequiredFirCount = totalFirCount + completedFirCount;
  const inventory = getInventory(profile, aggregate.item);
  const ownedTotal = inventory.fir + inventory.nonFir;
  const fulfillment = evaluateItemFulfillment(
    totalCount,
    totalFirCount,
    inventory,
  );

  return {
    itemId: aggregate.item.id,
    displayName: aggregate.item.name,
    subtitleName: localizedSubtitle(aggregate.item),
    category: aggregate.item.category,
    parentCategory: getParentCategory(aggregate.item.category),
    wikiPageLink: aggregate.item.wikiPageLink,
    localIcon: aggregate.item.localIcon,
    questCount: aggregate.questCount,
    questFirCount: aggregate.questFirCount,
    hideoutCount: aggregate.hideoutCount,
    hideoutFirCount: aggregate.hideoutFirCount,
    completedQuestCount: aggregate.completedQuestCount,
    completedQuestFirCount: aggregate.completedQuestFirCount,
    completedHideoutCount: aggregate.completedHideoutCount,
    completedHideoutFirCount: aggregate.completedHideoutFirCount,
    completedCount,
    completedFirCount,
    allRequiredCount,
    allRequiredFirCount,
    totalCount,
    totalFirCount,
    foundInRaid: totalFirCount > 0,
    ownedFir: inventory.fir,
    ownedNonFir: inventory.nonFir,
    ownedTotal,
    shortage: Math.max(
      0,
      totalCount - ownedTotal,
      totalFirCount - inventory.fir,
    ),
    firShortage: Math.max(0, totalFirCount - inventory.fir),
    fulfillmentStatus: fulfillment.status,
    progressPercent: fulfillment.progressPercent,
    isFulfilled: fulfillment.isFulfilled,
    isQuestOnly:
      aggregate.questCount + aggregate.completedQuestCount > 0 &&
      aggregate.hideoutCount + aggregate.completedHideoutCount === 0,
    isHideoutOnly:
      aggregate.hideoutCount + aggregate.completedHideoutCount > 0 &&
      aggregate.questCount + aggregate.completedQuestCount === 0,
    isBothRequired:
      aggregate.questCount + aggregate.completedQuestCount > 0 &&
      aggregate.hideoutCount + aggregate.completedHideoutCount > 0,
    questSources: aggregate.questSources,
    hideoutSources: aggregate.hideoutSources,
    completedQuestSources: aggregate.completedQuestSources,
    completedHideoutSources: aggregate.completedHideoutSources,
  };
}

export function createItemReferenceRequirement(
  item: ItemData,
  profile: Pick<ProfileState, "inventory">,
): AggregatedItemRequirement {
  return finalizeAggregate(
    {
      item,
      questCount: 0,
      questFirCount: 0,
      hideoutCount: 0,
      hideoutFirCount: 0,
      completedQuestCount: 0,
      completedQuestFirCount: 0,
      completedHideoutCount: 0,
      completedHideoutFirCount: 0,
      questSources: [],
      hideoutSources: [],
      completedQuestSources: [],
      completedHideoutSources: [],
    },
    profile,
  );
}

function addQuestRequirements(
  aggregates: Map<string, MutableAggregate>,
  questsToInclude: readonly QuestData[],
  itemLookup: ReadonlyMap<string, ItemData>,
  includeQuestItems: boolean,
  completed = false,
): void {
  for (const quest of questsToInclude) {
    for (const requirement of quest.requiredItems) {
      const item = findItem(itemLookup, requirement.itemId, requirement.itemName);
      if (!item) continue;
      if (!includeQuestItems && normalize(item.category) === "quest items") continue;

      const aggregate = getOrCreateAggregate(aggregates, item);
      const count = isCurrency(item, requirement.itemName) ? 1 : requirement.count;
      const source: QuestItemSource = {
        questId: quest.id,
        questNormalizedName: quest.normalizedName,
        questName: quest.name,
        traderName: quest.trader,
        requiredCount: requirement.count,
        requiresFir: requirement.requiresFir,
        kappaRequired: quest.kappaRequired,
      };
      if (completed) {
        aggregate.completedQuestCount += count;
        if (requirement.requiresFir) aggregate.completedQuestFirCount += count;
        aggregate.completedQuestSources.push(source);
      } else {
        aggregate.questCount += count;
        if (requirement.requiresFir) aggregate.questFirCount += count;
        aggregate.questSources.push(source);
      }
    }
  }
}

export function evaluateItemFulfillment(
  totalCount: number,
  totalFirCount: number,
  inventory: InventoryAmount,
): ItemFulfillment {
  const ownedTotal = inventory.fir + inventory.nonFir;
  if (totalCount === 0) {
    return { status: "fulfilled", progressPercent: 100, isFulfilled: true };
  }

  if (totalFirCount > 0) {
    const firFulfilled = inventory.fir >= totalFirCount;
    const totalFulfilled = ownedTotal >= totalCount;
    if (firFulfilled && totalFulfilled) {
      return { status: "fulfilled", progressPercent: 100, isFulfilled: true };
    }
    return {
      status: ownedTotal > 0 ? "partiallyFulfilled" : "notStarted",
      progressPercent:
        Math.min(
          inventory.fir / totalFirCount,
          ownedTotal / totalCount,
          1,
        ) * 100,
      isFulfilled: false,
    };
  }

  if (ownedTotal >= totalCount) {
    return { status: "fulfilled", progressPercent: 100, isFulfilled: true };
  }
  return {
    status: ownedTotal > 0 ? "partiallyFulfilled" : "notStarted",
    progressPercent: Math.min(100, (ownedTotal / totalCount) * 100),
    isFulfilled: false,
  };
}

export function aggregateItemRequirements(
  quests: readonly QuestData[],
  hideoutStations: readonly HideoutStation[],
  items: readonly ItemData[],
  profile: ProfileState,
  statusResolver = createQuestStatusResolver(quests, profile),
): AggregatedItemRequirement[] {
  const itemLookup = buildItemLookup(items);
  const aggregates = new Map<string, MutableAggregate>();
  const includedQuests = quests.filter((quest) => {
    const status = statusResolver.getStatus(quest);
    return status !== "done" && status !== "failed" && status !== "unavailable";
  });
  addQuestRequirements(aggregates, includedQuests, itemLookup, false);
  const completedQuests = quests.filter(
    (quest) => statusResolver.getStatus(quest) === "done",
  );
  addQuestRequirements(aggregates, completedQuests, itemLookup, false, true);

  for (const station of hideoutStations) {
    const currentLevel = getHideoutLevel(profile, station);
    for (const level of station.levels) {
      for (const requirement of level.items) {
        const item = findItem(itemLookup, requirement.itemId, requirement.itemName);
        if (!item) continue;
        const aggregate = getOrCreateAggregate(aggregates, item);
        const count = isCurrency(item, requirement.itemName) ? 1 : requirement.count;
        const source: HideoutItemSource = {
          stationId: station.id,
          stationNormalizedName: station.normalizedName,
          stationName: station.name,
          level: level.level,
          requiredCount: requirement.count,
          requiresFir: requirement.foundInRaid,
        };
        if (level.level <= currentLevel) {
          aggregate.completedHideoutCount += count;
          if (requirement.foundInRaid) aggregate.completedHideoutFirCount += count;
          aggregate.completedHideoutSources.push(source);
        } else {
          aggregate.hideoutCount += count;
          if (requirement.foundInRaid) aggregate.hideoutFirCount += count;
          aggregate.hideoutSources.push(source);
        }
      }
    }
  }

  return [...aggregates.values()].map((aggregate) =>
    finalizeAggregate(aggregate, profile),
  );
}

function buildQuestLookup(quests: readonly QuestData[]): Map<string, QuestData> {
  const result = new Map<string, QuestData>();
  for (const quest of quests) {
    for (const key of [quest.id, quest.normalizedName, quest.bsgId]) {
      const normalized = normalize(key);
      if (normalized && !result.has(normalized)) result.set(normalized, quest);
    }
  }
  return result;
}

function questKey(quest: QuestData): string {
  return normalize(quest.id || quest.normalizedName);
}

export function getCollectorQuestChain(
  quests: readonly QuestData[],
  profile: ProfileState,
  includePrerequisites: boolean,
  collectorName = "collector",
  statusResolver: QuestStatusResolver = createQuestStatusResolver(quests, profile),
): QuestData[] {
  const lookup = buildQuestLookup(quests);
  const collector =
    quests.find(
      (quest) => normalize(quest.normalizedName) === normalize(collectorName),
    ) ?? lookup.get(normalize(collectorName));
  if (!collector) return [];

  const result: QuestData[] = [];
  const visited = new Set<string>();
  const includeIfUnfinished = (quest: QuestData): void => {
    const key = questKey(quest);
    if (!key || visited.has(key)) return;
    visited.add(key);

    const status = statusResolver.getStatus(quest);
    if (status !== "done" && status !== "failed" && status !== "unavailable") {
      result.push(quest);
    }

    if (!includePrerequisites) return;
    for (const requirement of quest.requirements) {
      const prerequisite = lookup.get(normalize(requirement.questId));
      if (prerequisite) includeIfUnfinished(prerequisite);
    }
  };

  includeIfUnfinished(collector);
  return result;
}

export function aggregateCollectorItems(
  quests: readonly QuestData[],
  items: readonly ItemData[],
  profile: ProfileState,
  includePrerequisites: boolean,
  collectorName = "collector",
  statusResolver: QuestStatusResolver = createQuestStatusResolver(quests, profile),
): AggregatedItemRequirement[] {
  const aggregates = new Map<string, MutableAggregate>();
  addQuestRequirements(
    aggregates,
    getCollectorQuestChain(
      quests,
      profile,
      includePrerequisites,
      collectorName,
      statusResolver,
    ),
    buildItemLookup(items),
    true,
  );
  return [...aggregates.values()].map((aggregate) =>
    finalizeAggregate(aggregate, profile),
  );
}

export function getParentCategory(category: string | undefined): string {
  if (!category) return "Other";
  const baseCategory = category.includes("|") ? category.split("|", 1)[0] : category;
  if (!baseCategory) return "Other";
  return CATEGORY_MAPPING.get(normalize(baseCategory)) ?? baseCategory;
}

export function formatCountDisplay(total: number, firCount: number): string {
  if (firCount === 0) return String(total);
  if (firCount === total) return `${total} (FIR)`;
  return `${firCount}F+${total - firCount}`;
}

export function formatOwnedDisplay(inventory: InventoryAmount): string {
  if (inventory.fir + inventory.nonFir === 0) return "0";
  if (inventory.nonFir === 0) return `${inventory.fir}F`;
  if (inventory.fir === 0) return String(inventory.nonFir);
  return `${inventory.fir}F+${inventory.nonFir}`;
}

function compareName(
  left: AggregatedItemRequirement,
  right: AggregatedItemRequirement,
): number {
  return left.displayName.localeCompare(right.displayName);
}

export function filterAndSortItems(
  items: readonly AggregatedItemRequirement[],
  options: ItemFilterOptions = {},
): AggregatedItemRequirement[] {
  const search = normalize(options.searchText);
  const source = normalize(options.source ?? "all");
  const category = options.category ?? "All";
  const fulfillment = normalize(options.fulfillment ?? "all");
  const sortBy = normalize(options.sortBy ?? "name");

  const filtered = items.filter((item) => {
    if (
      search &&
      !normalize(item.displayName).includes(search) &&
      !normalize(item.subtitleName).includes(search)
    ) {
      return false;
    }
    if (source === "quest" && item.questCount + item.completedQuestCount === 0) {
      return false;
    }
    if (source === "hideout" && item.hideoutCount + item.completedHideoutCount === 0) {
      return false;
    }
    if (normalize(category) !== "all" && normalize(item.parentCategory) !== normalize(category)) {
      return false;
    }
    if (options.firOnly && !item.foundInRaid) return false;
    if (fulfillment === "notstarted" && item.fulfillmentStatus !== "notStarted") {
      return false;
    }
    if (
      fulfillment === "inprogress" &&
      item.fulfillmentStatus !== "partiallyFulfilled"
    ) {
      return false;
    }
    if (fulfillment === "fulfilled" && item.fulfillmentStatus !== "fulfilled") {
      return false;
    }
    if (options.hideFulfilled && item.isFulfilled) return false;
    return true;
  });

  return [...filtered].sort((left, right) => {
    if (sortBy === "total") return right.totalCount - left.totalCount || compareName(left, right);
    if (sortBy === "quest") {
      return (
        right.questCount + right.completedQuestCount -
          (left.questCount + left.completedQuestCount) ||
        compareName(left, right)
      );
    }
    if (sortBy === "hideout") {
      return (
        right.hideoutCount + right.completedHideoutCount -
          (left.hideoutCount + left.completedHideoutCount) ||
        compareName(left, right)
      );
    }
    if (sortBy === "progress") {
      return right.progressPercent - left.progressPercent || compareName(left, right);
    }
    return compareName(left, right);
  });
}

export function getAggregatedItemStatistics(
  items: readonly AggregatedItemRequirement[],
): AggregatedItemStatistics {
  const totalRequired = items.reduce((sum, item) => sum + item.totalCount, 0);
  const totalOwned = items.reduce((sum, item) => sum + item.ownedTotal, 0);
  return {
    totalUniqueItems: items.length,
    totalRequired,
    totalOwned,
    totalShortage: items.reduce((sum, item) => sum + item.shortage, 0),
    shortageItemCount: items.filter((item) => item.shortage > 0).length,
    questOnlyCount: items.filter((item) => item.isQuestOnly).length,
    hideoutOnlyCount: items.filter((item) => item.isHideoutOnly).length,
    bothRequiredCount: items.filter((item) => item.isBothRequired).length,
    fulfilledCount: items.filter((item) => item.isFulfilled).length,
    overallProgress: totalRequired > 0 ? totalOwned / totalRequired : 1,
  };
}
