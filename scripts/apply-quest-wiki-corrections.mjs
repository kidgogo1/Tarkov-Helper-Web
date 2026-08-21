#!/usr/bin/env node

import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

import { applyWikiGuideLinkErrors } from "./quest-pack.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dataPath = path.join(root, "public", "data", "tarkov-data.json");
const guidesPath = path.join(root, "public", "data", "quest-wiki-guides.json");

function normalize(value) {
  return String(value ?? "")
    .toLocaleLowerCase("en-US")
    .replace(/the\s+lab/g, "thelab")
    .replace(/streets?\s+of\s+tarkov/g, "streetsoftarkov")
    .replace(/ground\s+zero/g, "groundzero")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

const data = JSON.parse(await readFile(dataPath, "utf8"));
const guides = JSON.parse(await readFile(guidesPath, "utf8"));
const linkCorrectedQuests = applyWikiGuideLinkErrors(data.quests ?? [], guides);
const mapAliases = new Map();
for (const map of data.mapConfigs ?? []) {
  const canonical = map.displayName;
  for (const alias of [map.key, map.displayName, ...(map.aliases ?? [])]) {
    mapAliases.set(normalize(alias), canonical);
  }
}
mapAliases.set("labs", "The Lab");

const corrections = [];
const quests = linkCorrectedQuests.map((quest) => {
  const guide = guides.entries?.[quest.id];
  if (!guide || guide.error) return quest;
  const wikiMaps = [...new Set((guide.wikiLocation ?? [])
    .map((name) => mapAliases.get(normalize(name)))
    .filter(Boolean))];
  if (wikiMaps.length === 0) return quest;
  const appMaps = [...new Set((quest.locations ?? [])
    .map((name) => mapAliases.get(normalize(name)))
    .filter(Boolean))];
  // Wiki infoboxes sometimes list only one map for multi-map tasks. Only fill
  // an empty app location set; never erase verified objective map data.
  if (appMaps.length > 0) return quest;
  corrections.push({ questId: quest.id, name: quest.nameEn, from: quest.locations ?? [], to: wikiMaps });
  return { ...quest, locations: wikiMaps };
});

const output = {
  ...data,
  quests,
  meta: {
    ...data.meta,
    sources: {
      ...(data.meta?.sources ?? {}),
      wikiLocationVerifiedAt: guides.fetchedAt ?? null,
      wikiLocationVerifiedQuests: Object.values(guides.entries ?? {}).filter((entry) => !entry.error).length,
      wikiLocationCorrections: Math.max(
        Number(data.meta?.sources?.wikiLocationCorrections ?? 0),
        corrections.length,
      ),
      wikiLinkUnverifiedQuests: quests.filter((quest) => !quest?.wikiPageLink).length,
    },
  },
};
const temporary = `${dataPath}.tmp`;
await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, "utf8");
await rename(temporary, dataPath);
console.log(JSON.stringify({ corrections: corrections.length, details: corrections }, null, 2));
