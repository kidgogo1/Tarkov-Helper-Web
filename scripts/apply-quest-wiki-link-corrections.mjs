#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { applyWikiQuestRenames } from "./quest-pack.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dataPath = path.join(root, "public", "data", "tarkov-data.json");

const data = JSON.parse(await readFile(dataPath, "utf8"));
const quests = applyWikiQuestRenames(data.quests ?? []);
const corrections = quests.reduce((count, quest, index) => {
  const previous = data.quests?.[index];
  return count + (previous?.wikiPageLink !== quest?.wikiPageLink ? 1 : 0);
}, 0);
const unverified = quests.filter((quest) => !quest?.wikiPageLink).length;
const output = {
  ...data,
  quests,
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
