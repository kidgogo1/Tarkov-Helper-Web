import type {
  QuestData,
  QuestItemRequirement,
  QuestRequirement,
} from "../types/data";
import type {
  InventoryAmount,
  ProfileState,
  QuestStatus,
  SavedQuestStatus,
} from "../types/state";

type QuestProgress = Readonly<Record<string, SavedQuestStatus>>;

export interface QuestStatistics {
  total: number;
  locked: number;
  active: number;
  done: number;
  failed: number;
  levelLocked: number;
  unavailable: number;
}

export interface QuestRequirementDisplayGroup {
  groupId: number;
  requirements: QuestRequirement[];
}

export function groupQuestRequirementsForDisplay(
  requirements: readonly QuestRequirement[],
): {
  direct: QuestRequirement[];
  alternatives: QuestRequirementDisplayGroup[];
} {
  const groupSizes = new Map<number, number>();
  for (const requirement of requirements) {
    if (requirement.groupId > 0) {
      groupSizes.set(requirement.groupId, (groupSizes.get(requirement.groupId) ?? 0) + 1);
    }
  }

  const direct = requirements.filter(
    (requirement) =>
      requirement.groupId === 0 || (groupSizes.get(requirement.groupId) ?? 0) === 1,
  );
  const alternatives = new Map<number, QuestRequirement[]>();
  for (const requirement of requirements) {
    if (requirement.groupId <= 0 || (groupSizes.get(requirement.groupId) ?? 0) <= 1) continue;
    const group = alternatives.get(requirement.groupId) ?? [];
    group.push(requirement);
    alternatives.set(requirement.groupId, group);
  }
  return {
    direct,
    alternatives: [...alternatives].map(([groupId, groupRequirements]) => ({
      groupId,
      requirements: groupRequirements,
    })),
  };
}

export type RecommendationType =
  | "readyToComplete"
  | "itemHandInOnly"
  | "kappaPriority"
  | "unlocksMany"
  | "easyQuest";

export interface ReadyQuestItem {
  requirement: QuestItemRequirement;
  owned: number;
}

export interface MissingQuestItem {
  requirement: QuestItemRequirement;
  needed: number;
}

export interface QuestRecommendation {
  quest: QuestData;
  type: RecommendationType;
  reason: string;
  priority: number;
  readyItems: ReadyQuestItem[];
  missingItems: MissingQuestItem[];
  unlocksCount: number;
}

interface StatusContext {
  lookup: Map<string, QuestData>;
  profile: ProfileState;
  visiting: Set<string>;
}

/**
 * A profile-bound quest status snapshot. Build one per data/profile revision and
 * share it across every status consumer in that render or aggregation pass.
 */
export interface QuestStatusResolver {
  getStatus(quest: QuestData): QuestStatus;
  arePrerequisitesMet(quest: QuestData): boolean;
  getStatuses(): ReadonlyMap<QuestData, QuestStatus>;
}

const ACTIVE_REQUIREMENT_TYPES = new Set(["active", "start", "accept"]);
const FAILED_REQUIREMENT_TYPES = new Set(["failed", "fail"]);
const COMPLETED_REQUIREMENT_TYPES = new Set(["complete", "completed", "done"]);

function normalizeKey(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase("en-US") ?? "";
}

function questStorageKey(quest: QuestData): string {
  return quest.id || quest.normalizedName;
}

function buildQuestLookup(quests: readonly QuestData[]): Map<string, QuestData> {
  const lookup = new Map<string, QuestData>();

  for (const quest of quests) {
    for (const key of [quest.id, quest.normalizedName, quest.bsgId]) {
      const normalized = normalizeKey(key);
      if (normalized && !lookup.has(normalized)) {
        lookup.set(normalized, quest);
      }
    }
  }

  return lookup;
}

function findQuest(
  lookup: ReadonlyMap<string, QuestData>,
  idOrName: string,
): QuestData | undefined {
  return lookup.get(normalizeKey(idOrName));
}

function getCaseInsensitiveRecordValue<T>(
  record: Readonly<Record<string, T>>,
  key: string | undefined,
): T | undefined {
  if (!key) return undefined;
  if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];

  const normalized = normalizeKey(key);
  const matchingKey = Object.keys(record).find(
    (candidate) => normalizeKey(candidate) === normalized,
  );
  return matchingKey === undefined ? undefined : record[matchingKey];
}

function getSavedStatus(
  quest: QuestData,
  progress: QuestProgress,
): SavedQuestStatus | undefined {
  return (
    getCaseInsensitiveRecordValue(progress, quest.id) ??
    getCaseInsensitiveRecordValue(progress, quest.normalizedName)
  );
}

export function isLevelRequirementMet(
  quest: QuestData,
  profile: Pick<ProfileState, "level">,
): boolean {
  return !quest.minLevel || quest.minLevel <= 0 || profile.level >= quest.minLevel;
}

export function isScavKarmaRequirementMet(
  quest: QuestData,
  profile: Pick<ProfileState, "scavRep">,
): boolean {
  if (quest.minScavKarma === undefined) return true;
  return quest.minScavKarma < 0
    ? profile.scavRep <= quest.minScavKarma
    : profile.scavRep >= quest.minScavKarma;
}

function isEodEdition(value: string): boolean {
  return value === "eod" || value === "edge_of_darkness";
}

function isUnheardEdition(value: string): boolean {
  return value === "unheard" || value === "the_unheard";
}

export function isEditionRequirementMet(
  quest: QuestData,
  profile: Pick<ProfileState, "hasEodEdition" | "hasUnheardEdition">,
): boolean {
  const required = normalizeKey(quest.requiredEdition);
  if (isEodEdition(required) && !profile.hasEodEdition) return false;
  if (isUnheardEdition(required) && !profile.hasUnheardEdition) return false;

  const excluded = normalizeKey(quest.excludedEdition);
  if (isEodEdition(excluded) && profile.hasEodEdition) return false;
  if (isUnheardEdition(excluded) && profile.hasUnheardEdition) return false;

  return true;
}

export function isPrestigeRequirementMet(
  quest: QuestData,
  profile: Pick<ProfileState, "prestigeLevel">,
): boolean {
  return (
    !quest.requiredPrestigeLevel ||
    quest.requiredPrestigeLevel <= 0 ||
    profile.prestigeLevel >= quest.requiredPrestigeLevel
  );
}

export function isFactionRequirementMet(
  quest: QuestData,
  profile: Pick<ProfileState, "faction">,
): boolean {
  return (
    !quest.faction ||
    !profile.faction ||
    normalizeKey(quest.faction) === normalizeKey(profile.faction)
  );
}

export function isDspRequirementMet(
  quest: QuestData,
  profile: Pick<ProfileState, "dspDecodeCount">,
): boolean {
  return (
    quest.requiredDecodeCount === undefined ||
    profile.dspDecodeCount === quest.requiredDecodeCount
  );
}

export function areQuestProfileRequirementsMet(
  quest: QuestData,
  profile: ProfileState,
): boolean {
  return (
    isEditionRequirementMet(quest, profile) &&
    isPrestigeRequirementMet(quest, profile) &&
    isFactionRequirementMet(quest, profile) &&
    isDspRequirementMet(quest, profile) &&
    isLevelRequirementMet(quest, profile) &&
    isScavKarmaRequirementMet(quest, profile)
  );
}

function doesStatusSatisfy(
  status: QuestStatus,
  requirementType: string | undefined,
): boolean {
  const required = normalizeKey(requirementType) || "complete";
  if (ACTIVE_REQUIREMENT_TYPES.has(required)) {
    return status === "active" || status === "done";
  }
  if (FAILED_REQUIREMENT_TYPES.has(required)) return status === "failed";
  if (COMPLETED_REQUIREMENT_TYPES.has(required)) return status === "done";
  return false;
}

function prerequisitesMetWithContext(
  quest: QuestData,
  context: StatusContext,
): boolean {
  if (quest.requirements.length === 0) return true;

  for (const requirement of quest.requirements.filter(({ groupId }) => groupId === 0)) {
    const prerequisite = findQuest(context.lookup, requirement.questId);
    // The desktop source treats stale AND references as non-blocking.
    if (!prerequisite) continue;
    if (
      !doesStatusSatisfy(
        getQuestStatusWithContext(prerequisite, context),
        requirement.requirementType,
      )
    ) {
      return false;
    }
  }

  const orGroups = new Map<number, typeof quest.requirements>();
  for (const requirement of quest.requirements) {
    if (requirement.groupId <= 0) continue;
    const group = orGroups.get(requirement.groupId) ?? [];
    group.push(requirement);
    orGroups.set(requirement.groupId, group);
  }

  for (const group of orGroups.values()) {
    const satisfied = group.some((requirement) => {
      const prerequisite = findQuest(context.lookup, requirement.questId);
      return (
        prerequisite !== undefined &&
        doesStatusSatisfy(
          getQuestStatusWithContext(prerequisite, context),
          requirement.requirementType,
        )
      );
    });
    if (!satisfied) return false;
  }

  return true;
}

function getQuestStatusWithContext(
  quest: QuestData,
  context: StatusContext,
): QuestStatus {
  const saved = getSavedStatus(quest, context.profile.questProgress);
  if (saved) return saved;

  const key = normalizeKey(questStorageKey(quest));
  if (!key) return "active";
  // This mirrors the desktop cycle guard: the nested occurrence is active.
  if (context.visiting.has(key)) return "active";
  context.visiting.add(key);

  try {
    if (!isEditionRequirementMet(quest, context.profile)) return "unavailable";
    if (!isPrestigeRequirementMet(quest, context.profile)) return "unavailable";
    if (!isFactionRequirementMet(quest, context.profile)) return "unavailable";
    if (!isDspRequirementMet(quest, context.profile)) return "locked";
    if (!prerequisitesMetWithContext(quest, context)) return "locked";
    if (!isLevelRequirementMet(quest, context.profile)) return "levelLocked";
    if (!isScavKarmaRequirementMet(quest, context.profile)) return "levelLocked";
    return "active";
  } finally {
    context.visiting.delete(key);
  }
}

export function createQuestStatusResolver(
  quests: readonly QuestData[],
  profile: ProfileState,
): QuestStatusResolver {
  // Keep a stable local collection so callers can supply a readonly/proxied
  // array without paying for another source scan on every status lookup.
  const indexedQuests = [...quests];
  const lookup = buildQuestLookup(indexedQuests);
  const statuses = new Map<QuestData, QuestStatus>();

  const getStatus = (quest: QuestData): QuestStatus => {
    const cached = statuses.get(quest);
    if (cached !== undefined) return cached;

    // Each top-level calculation gets its own cycle guard. Recursive results are
    // intentionally not cached because a cycle guard is root-relative.
    const status = getQuestStatusWithContext(quest, {
      lookup,
      profile,
      visiting: new Set(),
    });
    statuses.set(quest, status);
    return status;
  };

  return {
    getStatus,
    arePrerequisitesMet(quest) {
      return prerequisitesMetWithContext(quest, {
        lookup,
        profile,
        visiting: new Set(),
      });
    },
    getStatuses() {
      for (const quest of indexedQuests) getStatus(quest);
      return statuses;
    },
  };
}

export function getQuestStatus(
  quest: QuestData,
  quests: readonly QuestData[],
  profile: ProfileState,
): QuestStatus {
  const allQuests = quests.includes(quest) ? quests : [...quests, quest];
  return createQuestStatusResolver(allQuests, profile).getStatus(quest);
}

export function areQuestPrerequisitesMet(
  quest: QuestData,
  quests: readonly QuestData[],
  profile: ProfileState,
): boolean {
  const allQuests = quests.includes(quest) ? quests : [...quests, quest];
  return createQuestStatusResolver(allQuests, profile).arePrerequisitesMet(quest);
}

export interface CompleteQuestOptions {
  completePrerequisites?: boolean;
  skipAlternativePrerequisites?: boolean;
}

export function completeQuest(
  idOrName: string,
  quests: readonly QuestData[],
  progress: QuestProgress,
  options: CompleteQuestOptions = {},
): Record<string, SavedQuestStatus> {
  const result: Record<string, SavedQuestStatus> = { ...progress };
  const lookup = buildQuestLookup(quests);
  const target = findQuest(lookup, idOrName);
  if (!target) return result;

  const completePrerequisites = options.completePrerequisites ?? true;
  const skipAlternativePrerequisites =
    options.skipAlternativePrerequisites ?? true;
  const visited = new Set<string>();

  const completeRecursively = (quest: QuestData): void => {
    const key = questStorageKey(quest);
    const normalizedKey = normalizeKey(key);
    if (!normalizedKey || visited.has(normalizedKey)) return;
    visited.add(normalizedKey);
    if (getSavedStatus(quest, result) === "done") return;

    if (completePrerequisites) {
      for (const requirement of quest.requirements) {
        const prerequisite = findQuest(lookup, requirement.questId);
        if (!prerequisite || getSavedStatus(prerequisite, result) === "done") continue;
        if (
          skipAlternativePrerequisites &&
          prerequisite.alternativeQuestIds.length > 0
        ) {
          continue;
        }
        completeRecursively(prerequisite);
      }
    }

    result[key] = "done";
  };

  completeRecursively(target);

  // Alternative failure is applied even when the target had already been done,
  // matching the desktop CompleteQuest operation.
  for (const alternativeId of target.alternativeQuestIds) {
    const alternative = findQuest(lookup, alternativeId);
    if (!alternative) continue;
    const current = getSavedStatus(alternative, result);
    if (current === "done" || current === "failed") continue;
    result[questStorageKey(alternative)] = "failed";
  }

  return result;
}

export function failQuest(
  progress: QuestProgress,
  quest: QuestData,
): Record<string, SavedQuestStatus> {
  return { ...progress, [questStorageKey(quest)]: "failed" };
}

export function resetQuest(
  progress: QuestProgress,
  quest: QuestData,
): Record<string, SavedQuestStatus> {
  const resetKeys = new Set(
    [quest.id, quest.normalizedName].map(normalizeKey).filter(Boolean),
  );
  return Object.fromEntries(
    Object.entries(progress).filter(([key]) => !resetKeys.has(normalizeKey(key))),
  );
}

export function resetAllQuestProgress(
  questProgress: QuestProgress,
  objectiveProgress: Readonly<Record<string, boolean>>,
): {
  questProgress: Record<string, SavedQuestStatus>;
  objectiveProgress: Record<string, boolean>;
} {
  void questProgress;
  void objectiveProgress;
  return { questProgress: {}, objectiveProgress: {} };
}

export function getQuestStatistics(
  quests: readonly QuestData[],
  profile: ProfileState,
  statusResolver = createQuestStatusResolver(quests, profile),
): QuestStatistics {
  const statistics: QuestStatistics = {
    total: quests.length,
    locked: 0,
    active: 0,
    done: 0,
    failed: 0,
    levelLocked: 0,
    unavailable: 0,
  };

  for (const quest of quests) {
    statistics[statusResolver.getStatus(quest)] += 1;
  }
  return statistics;
}

function inventoryForItem(
  profile: Pick<ProfileState, "inventory">,
  requirement: QuestItemRequirement,
): InventoryAmount {
  return (
    getCaseInsensitiveRecordValue(profile.inventory, requirement.itemId) ??
    getCaseInsensitiveRecordValue(profile.inventory, requirement.itemName) ?? {
      fir: 0,
      nonFir: 0,
    }
  );
}

function analyzeItemRequirements(
  quest: QuestData,
  profile: Pick<ProfileState, "inventory">,
): { readyItems: ReadyQuestItem[]; missingItems: MissingQuestItem[] } {
  const readyItems: ReadyQuestItem[] = [];
  const missingItems: MissingQuestItem[] = [];

  for (const requirement of quest.requiredItems) {
    const inventory = inventoryForItem(profile, requirement);
    const available = requirement.requiresFir
      ? inventory.fir
      : inventory.fir + inventory.nonFir;
    if (available >= requirement.count) {
      readyItems.push({ requirement, owned: available });
    } else {
      missingItems.push({ requirement, needed: requirement.count - available });
    }
  }

  return { readyItems, missingItems };
}

function isItemHandInOnly(quest: QuestData): boolean {
  if (quest.requiredItems.length === 0) return false;
  const complexKeywords = [
    "kill",
    "eliminate",
    "survive",
    "visit",
    "plant",
    "mark",
    "extract",
    "reach",
  ];

  return quest.objectives.every((objective) => {
    const searchable = [
      objective.objectiveType,
      objective.description,
      objective.targetType,
      objective.locationName,
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("en-US");
    return !complexKeywords.some((keyword) => searchable.includes(keyword));
  });
}

function analyzeRecommendation(
  quest: QuestData,
  profile: ProfileState,
): QuestRecommendation | null {
  const { readyItems, missingItems } = analyzeItemRequirements(quest, profile);
  const unlocksCount = quest.followUpQuestIds.length;
  const allRequiredItemsReady =
    quest.requiredItems.length > 0 && missingItems.length === 0;

  if (allRequiredItemsReady) {
    return {
      quest,
      type: "readyToComplete",
      reason:
        readyItems.length > 0
          ? `필요 아이템 ${readyItems.length}개 보유 중`
          : "지금 바로 완료 가능",
      priority: 100 + (quest.kappaRequired ? 20 : 0) + unlocksCount * 5,
      readyItems,
      missingItems: [],
      unlocksCount,
    };
  }

  if (isItemHandInOnly(quest)) {
    const total = readyItems.length + missingItems.length;
    const fulfillmentRatio = total === 0 ? 1 : readyItems.length / total;
    if (fulfillmentRatio >= 0.5) {
      return {
        quest,
        type: "itemHandInOnly",
        reason: `아이템 제출만 필요 (${readyItems.length}/${total}개 보유)`,
        priority:
          50 + Math.trunc(fulfillmentRatio * 40) + (quest.kappaRequired ? 10 : 0),
        readyItems,
        missingItems,
        unlocksCount,
      };
    }
  }

  if (quest.kappaRequired) {
    return {
      quest,
      type: "kappaPriority",
      reason:
        unlocksCount > 0
          ? `카파 필수 + ${unlocksCount}개 퀘스트 해금`
          : "카파 컨테이너 필수 퀘스트",
      priority: 70 + unlocksCount * 5,
      readyItems,
      missingItems,
      unlocksCount,
    };
  }

  if (unlocksCount >= 2) {
    return {
      quest,
      type: "unlocksMany",
      reason: `${unlocksCount}개 퀘스트 해금`,
      priority: 60 + unlocksCount * 10,
      readyItems,
      missingItems,
      unlocksCount,
    };
  }

  if (quest.requiredItems.length === 0) {
    return {
      quest,
      type: "easyQuest",
      reason: "아이템 필요 없음",
      priority: 40,
      readyItems,
      missingItems,
      unlocksCount,
    };
  }

  return null;
}

function recommendationTieRank(type: RecommendationType): number {
  if (type === "readyToComplete") return 2;
  if (type === "itemHandInOnly") return 1;
  return 0;
}

export function recommendQuests(
  quests: readonly QuestData[],
  profile: ProfileState,
  maxResults = 5,
  statusResolver = createQuestStatusResolver(quests, profile),
): QuestRecommendation[] {
  return quests
    .filter((quest) => statusResolver.getStatus(quest) === "active")
    .map((quest) => analyzeRecommendation(quest, profile))
    .filter((recommendation): recommendation is QuestRecommendation =>
      Boolean(recommendation),
    )
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        recommendationTieRank(right.type) - recommendationTieRank(left.type),
    )
    .slice(0, Math.max(0, maxResults));
}
