import type { QuestData } from "../types/data";
import type { SavedQuestStatus } from "../types/state";

type QuestProgress = Readonly<Record<string, SavedQuestStatus>>;

export interface AlternativeQuestChoicePlan {
  quest: QuestData;
  status: SavedQuestStatus | null;
}

export interface AlternativeQuestGroupPlan {
  key: string;
  choices: AlternativeQuestChoicePlan[];
  defaultQuestId: string | null;
}

function normalize(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase("en-US") ?? "";
}

function storageKey(quest: QuestData): string {
  return quest.id || quest.normalizedName;
}

function buildLookup(quests: readonly QuestData[]): Map<string, QuestData> {
  const lookup = new Map<string, QuestData>();
  for (const quest of quests) {
    for (const alias of [quest.id, quest.normalizedName, quest.bsgId]) {
      const key = normalize(alias);
      if (key && !lookup.has(key)) lookup.set(key, quest);
    }
  }
  return lookup;
}

function savedStatus(quest: QuestData, progress: QuestProgress): SavedQuestStatus | null {
  const aliases = new Set(
    [quest.id, quest.normalizedName].map(normalize).filter(Boolean),
  );
  const match = Object.entries(progress).find(([key]) => aliases.has(normalize(key)));
  return match?.[1] ?? null;
}

export function applyStartedQuest(
  progress: QuestProgress,
  questId: string,
  quests: readonly QuestData[],
): Record<string, SavedQuestStatus> {
  const result: Record<string, SavedQuestStatus> = { ...progress };
  const quest = buildLookup(quests).get(normalize(questId));
  if (!quest) return result;

  const aliases = new Set(
    [quest.id, quest.normalizedName].map(normalize).filter(Boolean),
  );
  const alreadyCompleted = Object.entries(progress).some(
    ([key, status]) => aliases.has(normalize(key)) && status === "done",
  );
  if (alreadyCompleted) return result;

  for (const key of Object.keys(result)) {
    if (aliases.has(normalize(key))) delete result[key];
  }
  result[storageKey(quest)] = "active";
  return result;
}

function collectPrerequisites(
  questIds: readonly string[],
  lookup: ReadonlyMap<string, QuestData>,
): QuestData[] {
  const selected = new Set(questIds.map(normalize).filter(Boolean));
  const result = new Map<string, QuestData>();
  const visiting = new Set<string>();

  const visit = (quest: QuestData): void => {
    const currentKey = normalize(storageKey(quest));
    if (!currentKey || visiting.has(currentKey)) return;
    visiting.add(currentKey);

    for (const requirement of quest.requirements) {
      const prerequisite = lookup.get(normalize(requirement.questId));
      if (!prerequisite) continue;
      const prerequisiteKey = normalize(storageKey(prerequisite));
      if (!prerequisiteKey) continue;
      result.set(prerequisiteKey, prerequisite);
      visit(prerequisite);
    }

    visiting.delete(currentKey);
  };

  for (const questId of questIds) {
    const quest = lookup.get(normalize(questId));
    if (quest) visit(quest);
  }

  for (const key of selected) {
    const selectedQuest = lookup.get(key);
    if (selectedQuest) result.delete(normalize(storageKey(selectedQuest)));
  }
  return [...result.values()];
}

export function getManualPrerequisites(
  selectedQuestIds: readonly string[],
  quests: readonly QuestData[],
  progress: QuestProgress,
): QuestData[] {
  const lookup = buildLookup(quests);
  return collectPrerequisites(selectedQuestIds, lookup)
    .filter((quest) => savedStatus(quest, progress) !== "done")
    .sort((left, right) => {
      const traderOrder = left.trader.localeCompare(right.trader, "en");
      if (traderOrder !== 0) return traderOrder;
      const leftName = left.nameKo?.trim() || left.name;
      const rightName = right.nameKo?.trim() || right.name;
      return leftName.localeCompare(rightName, "ko");
    });
}

export function collectAlternativeQuestGroups(
  eventQuestIds: readonly string[],
  quests: readonly QuestData[],
  progress: QuestProgress,
): AlternativeQuestGroupPlan[] {
  const lookup = buildLookup(quests);
  const prerequisites = collectPrerequisites(eventQuestIds, lookup);
  const processed = new Set<string>();
  const groups: AlternativeQuestGroupPlan[] = [];

  for (const prerequisite of prerequisites) {
    if (prerequisite.alternativeQuestIds.length === 0) continue;

    const choices = [prerequisite, ...prerequisite.alternativeQuestIds
      .map((id) => lookup.get(normalize(id)))
      .filter((quest): quest is QuestData => quest !== undefined)]
      .filter((quest, index, all) =>
        all.findIndex((candidate) => normalize(storageKey(candidate)) === normalize(storageKey(quest))) === index,
      );
    if (choices.length <= 1) continue;

    const key = choices
      .map((quest) => storageKey(quest))
      .sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }))
      .join("|");
    const normalizedKey = normalize(key);
    if (processed.has(normalizedKey)) continue;
    processed.add(normalizedKey);

    const plannedChoices = choices.map((quest) => ({
      quest,
      status: savedStatus(quest, progress),
    }));
    if (plannedChoices.some(({ status }) => status === "done")) continue;

    groups.push({
      key,
      choices: plannedChoices,
      defaultQuestId:
        plannedChoices.find(({ status }) => status !== "failed")?.quest.id ?? null,
    });
  }

  return groups;
}

export function applyAlternativeQuestSelections(
  progress: QuestProgress,
  groups: readonly AlternativeQuestGroupPlan[],
  selections: Readonly<Record<string, string>>,
): Record<string, SavedQuestStatus> {
  const result: Record<string, SavedQuestStatus> = { ...progress };

  for (const group of groups) {
    const selectedId = normalize(selections[group.key]);
    const selected = group.choices.find(
      ({ quest, status }) =>
        status !== "failed" &&
        [quest.id, quest.normalizedName, quest.bsgId].some(
          (alias) => normalize(alias) === selectedId,
        ),
    );
    if (!selected) continue;

    for (const choice of group.choices) {
      const key = storageKey(choice.quest);
      if (choice.quest === selected.quest) {
        result[key] = "done";
      } else if (savedStatus(choice.quest, result) !== "done") {
        result[key] = "failed";
      }
    }
  }

  return result;
}
