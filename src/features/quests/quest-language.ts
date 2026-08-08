import type { QuestData, QuestObjective } from "../../types/data";

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
    ...quest.requiredItems.map((item) => item.itemName),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}
