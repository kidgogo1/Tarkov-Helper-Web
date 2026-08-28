#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { applyWikiQuestRenames } from "./quest-pack.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dataPath = path.join(root, "public", "data", "tarkov-data.json");

const data = JSON.parse(await readFile(dataPath, "utf8"));
const quests = applyWikiQuestRenames(data.quests ?? []);
const questCatalogs = data.questCatalogs
  ? Object.fromEntries(Object.entries(data.questCatalogs).map(([name, catalog]) => [
      name,
      applyWikiQuestRenames(Array.isArray(catalog) ? catalog : []),
    ]))
  : undefined;
const corrections = [
  [data.quests ?? [], quests],
  ...Object.keys(questCatalogs ?? {}).map((name) => [
    data.questCatalogs?.[name] ?? [],
    questCatalogs[name],
  ]),
].reduce((total, [before, after]) => total + after.reduce((count, quest, index) => (
  count + (before[index]?.wikiPageLink !== quest?.wikiPageLink ? 1 : 0)
), 0), 0);
const unverified = quests.filter((quest) => !quest?.wikiPageLink).length;
const output = {
  ...data,
  quests,
  ...(questCatalogs ? { questCatalogs } : {}),
  meta: {
    ...data.meta,
    sources: {
      ...(data.meta?.sources ?? {}),
      wikiLinkCorrections: Math.max(
        Number(data.meta?.sources?.wikiLinkCorrections ?? 0),
        corrections,
      ),
      wikiLinkUnverifiedQuests: unverified,
    },
  },
};

const temporary = `${dataPath}.tmp`;
await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, "utf8");
await rename(temporary, dataPath);
console.log(JSON.stringify({ corrections, unverified }, null, 2));
