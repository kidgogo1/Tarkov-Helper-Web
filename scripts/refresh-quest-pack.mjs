#!/usr/bin/env node

import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { extractWikiQuestMeta, mergeQuestSources } from "./quest-pack.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const defaultInput = path.join(projectRoot, "public", "data", "tarkov-data.json");
const defaultOutput = defaultInput;
const tarkovDataUrl = "https://raw.githubusercontent.com/TarkovLab/TarkovData/master/data/quests.json";
const wikiApiUrl = "https://escapefromtarkov.fandom.com/api.php";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": "TarkovHelper-Web-DataRefresh/1.0" } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function loadWikiMeta() {
  const [page, revision] = await Promise.all([
    fetchJson(`${wikiApiUrl}?action=parse&page=Quests&prop=wikitext&format=json`),
    fetchJson(`${wikiApiUrl}?action=query&prop=revisions&rvprop=timestamp%7Cids&titles=Quests&format=json`),
  ]);
  const timestamp = Object.values(revision.query?.pages ?? {})[0]?.revisions?.[0]?.timestamp ?? null;
  return extractWikiQuestMeta(page.parse?.wikitext?.["*"] ?? "", timestamp);
}

async function main() {
  const inputPath = path.resolve(option("--input", defaultInput));
  const outputPath = path.resolve(option("--output", defaultOutput));
  const [localPack, tarkovData, wikiMeta] = await Promise.all([
    readFile(inputPath, "utf8").then(JSON.parse),
    fetchJson(tarkovDataUrl),
    loadWikiMeta(),
  ]);
  const refreshed = mergeQuestSources(localPack, tarkovData, wikiMeta);
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(refreshed, null, 2)}\n`, "utf8");
  await rename(temporaryPath, outputPath);
  console.log(JSON.stringify({
    input: inputPath,
    output: outputPath,
    before: localPack.quests.length,
    after: refreshed.quests.length,
    appended: refreshed.quests.length - localPack.quests.length,
    ...refreshed.meta.sources,
  }, null, 2));
}

main().catch((error) => {
  console.error(`quest pack refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
