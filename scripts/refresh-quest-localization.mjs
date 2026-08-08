#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const defaultDataPath = path.join(projectRoot, "public", "data", "tarkov-data.json");
const upstreamEnglishUrl = "https://json.tarkov.dev/regular/tasks";
const upstreamKoreanUrl = "https://json.tarkov.dev/regular/tasks_ko";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "TarkovHelper-Web-LocalizationRefresh/1.0" },
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const outputPath = path.resolve(option("--output", defaultDataPath));
  const [pack, english, korean] = await Promise.all([
    readFile(outputPath, "utf8").then(JSON.parse),
    fetchJson(upstreamEnglishUrl),
    fetchJson(upstreamKoreanUrl),
  ]);
  const upstreamTasks = english.data?.tasks ?? {};
  const translations = korean.data ?? {};
  let localizedQuests = 0;
  let localizedObjectives = 0;

  for (const quest of pack.quests ?? []) {
    const upstreamQuest = quest.bsgId ? upstreamTasks[quest.bsgId] : undefined;
    if (!upstreamQuest) continue;
    const translatedName = translations[upstreamQuest.name];
    if (typeof translatedName === "string" && translatedName.trim()) {
      quest.nameKo = translatedName.trim();
      localizedQuests += 1;
    }
    for (let index = 0; index < (quest.objectives ?? []).length; index += 1) {
      const objective = quest.objectives[index];
      const upstreamObjective = upstreamQuest.objectives?.[index];
      if (!upstreamObjective) continue;
      const translatedDescription = translations[upstreamObjective.description];
      if (typeof translatedDescription === "string" && translatedDescription.trim()) {
        const localized = translatedDescription.trim();
        if (localized !== objective.description) {
          objective.descriptionKo = localized;
          localizedObjectives += 1;
        } else {
          delete objective.descriptionKo;
        }
      }
    }
  }

  const sources = pack.meta?.sources ?? {};
  pack.meta = {
    ...pack.meta,
    sources: {
      ...sources,
      koreanLocalizationSource: "https://json.tarkov.dev/regular/tasks_ko",
      koreanLocalizedQuests: localizedQuests,
      koreanLocalizedObjectives: localizedObjectives,
    },
  };
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  await rename(temporaryPath, outputPath);
  console.log(JSON.stringify({ output: outputPath, localizedQuests, localizedObjectives }, null, 2));
}

main().catch((error) => {
  console.error(`quest localization refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
