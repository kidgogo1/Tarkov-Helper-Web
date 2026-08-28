import type { ItemData, QuestData, QuestObjective } from "../../types/data";

export type QuestLanguage = "ko" | "en";

export function questDisplayName(
  quest: QuestData,
  language: QuestLanguage,
): string {
  if (language === "ko") {
    return quest.nameKo?.trim() || quest.name || quest.nameEn;
  }
  return quest.nameEn?.trim() || quest.name || quest.nameKo || quest.normalizedName;
}

export function alternateQuestDisplayName(
  quest: QuestData,
  language: QuestLanguage,
): string | undefined {
  const alternate = language === "ko"
    ? quest.nameEn?.trim() || quest.name
    : quest.nameKo?.trim() || quest.name;
  return alternate && alternate !== questDisplayName(quest, language)
    ? alternate
    : undefined;
}

/** Legacy app/wiki titles that should remain visible when a quest was renamed. */
export function questLegacyNames(quest: QuestData): string[] {
  return [...new Set((quest.nameAliases ?? [])
    .map((name) => name.trim())
    .filter(Boolean))];
}

export function objectiveDisplayText(
  objective: QuestObjective,
  language: QuestLanguage,
): string {
  return language === "ko"
    ? objective.descriptionKo?.trim() || objective.description
    : objective.description;
}

/** Search both localized and source-language fields regardless of display mode. */
export function questSearchText(quest: QuestData): string {
  return [
    quest.name,
    quest.nameEn,
    ...(quest.nameAliases ?? []),
    quest.nameKo,
    quest.nameJa,
    quest.normalizedName,
    quest.trader,
    ...quest.locations,
    ...quest.objectives.flatMap((objective) => [
      objective.description,
      objective.descriptionKo,
      objective.mapName,
      objective.locationName,
      objective.targetType,
    ]),
    ...quest.requiredItems.flatMap((item) => [
      item.itemName,
      ...(item.alternativeItemNames ?? []),
    ]),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

/** Search reward items with both the quest's source text and localized item data. */
export function questRewardSearchText(
  quest: QuestData,
  itemsById: ReadonlyMap<string, ItemData>,
): string {
  const rewardItems = quest.rewardItems ?? [];
  return [
    ...rewardItems.flatMap((reward) => {
      const item = itemsById.get(reward.itemId);
      return [
        reward.itemName,
        item?.name,
        item?.nameEn,
        item?.nameKo,
        item?.nameJa,
        item?.shortNameEn,
        item?.shortNameKo,
        item?.shortNameJa,
      ];
    }),
    ...quest.rewardText ?? [],
    ...(quest.rewardXp ? ["경험치 experience xp"] : []),
    ...(quest.rewardRoubles ? ["루블 rouble roubles ruble money"] : []),
    ...(quest.rewardReputation?.flatMap((reward) => [
      "평판 reputation",
      reward.trader,
    ]) ?? []),
    ...(quest.rewardSkills?.flatMap((reward) => ["스킬 skill", reward.skill]) ?? []),
    ...quest.rewardUnlocks ?? [],
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

/** Search items that a quest asks the player to hand over, including localized names. */
export function questRequiredItemSearchText(
  quest: QuestData,
  itemsById: ReadonlyMap<string, ItemData>,
): string {
  return quest.requiredItems
    .flatMap((requirement) => {
      const acceptedItems = [
        { id: requirement.itemId, name: requirement.itemName },
        ...(requirement.alternativeItemIds ?? []).map((id, index) => ({
          id,
          name: requirement.alternativeItemNames?.[index],
        })),
      ];
      return [
        requirement.itemName,
        ...(requirement.alternativeItemNames ?? []),
        ...acceptedItems.flatMap(({ id, name }) => {
          const item = itemsById.get(id);
          return [
            name,
            item?.name,
            item?.nameEn,
            item?.nameKo,
            item?.nameJa,
            item?.shortNameEn,
            item?.shortNameKo,
            item?.shortNameJa,
          ];
        }),
      ];
    })
    .filter((value): value is string => Boolean(value))
    .join(" ");
}
