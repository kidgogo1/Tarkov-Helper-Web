import type { ProfileType, QuestData, QuestCatalogs } from "../types/data";

type QuestCatalogSource = {
  quests: QuestData[];
  questCatalogs?: QuestCatalogs;
};

/** Selects the active profile's catalog while accepting legacy single-list packs. */
export function selectQuestCatalog(
  data: QuestCatalogSource,
  profile: ProfileType,
): QuestData[] {
  if (profile === "pve") return data.questCatalogs?.pve ?? data.quests;
  return data.quests;
}
