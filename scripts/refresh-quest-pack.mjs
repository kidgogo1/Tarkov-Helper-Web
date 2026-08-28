#!/usr/bin/env node

import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  collectTarkovDevTaskItemIds,
  extractWikiQuestMeta,
  mergeQuestSources,
  mergeTarkovDevItems,
  normalizeTarkovDevTasks,
} from "./quest-pack.mjs";
import {
  assembleQuestCatalogPack,
  createQuestCatalogSeed,
  questCatalogSourceUrls,
} from "./quest-catalog-refresh.mjs";
import { fetchJsonWithRetry } from "./fetch-json-with-retry.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const defaultInput = path.join(projectRoot, "public", "data", "tarkov-data.json");
const defaultOutput = defaultInput;
const wikiApiUrl = "https://escapefromtarkov.fandom.com/api.php";
const liveItemsUrl = "https://json.tarkov.dev/regular/items";
const liveItemsEnglishUrl = "https://json.tarkov.dev/regular/items_en";
const liveItemsKoreanUrl = "https://json.tarkov.dev/regular/items_ko";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const MAX_CONCURRENT_REQUESTS = 4;
let activeRequests = 0;
const requestWaiters = [];

async function acquireRequestSlot() {
  if (activeRequests < MAX_CONCURRENT_REQUESTS) {
    activeRequests += 1;
    return;
  }
  await new Promise((resolve) => requestWaiters.push(resolve));
  activeRequests += 1;
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function releaseRequestSlot() {
  activeRequests -= 1;
  requestWaiters.shift()?.();
}

async function fetchJson(url) {
  await acquireRequestSlot();
  try {
    return await fetchJsonWithRetry(url, {
      headers: { "User-Agent": "TarkovHelper-Web-DataRefresh/1.0" },
    });
  } finally {
    releaseRequestSlot();
  }
}

async function loadWikiMeta() {
  const [page, revision] = await Promise.all([
    fetchJson(`${wikiApiUrl}?action=parse&page=Quests&prop=wikitext&format=json`),
    fetchJson(`${wikiApiUrl}?action=query&prop=revisions&rvprop=timestamp%7Cids&titles=Quests&format=json`),
  ]);
  const timestamp = Object.values(revision.query?.pages ?? {})[0]?.revisions?.[0]?.timestamp ?? null;
  return extractWikiQuestMeta(page.parse?.wikitext?.["*"] ?? "", timestamp);
}

async function loadLiveCatalogSources(mode) {
  const urls = questCatalogSourceUrls(mode);
  const [tasks, english, korean, maps] = await Promise.all([
    fetchJson(urls.tasks),
    fetchJson(urls.english),
    fetchJson(urls.korean),
    fetchJson(urls.maps),
  ]);
  return {
    urls,
    data: tasks.data ?? tasks,
    english: english.data ?? english,
    korean: korean.data ?? korean,
    maps: maps.data ?? maps,
  };
}

function normalizeLiveCatalog(catalog, traders, itemIdByBsgId, itemNamesByBsgId) {
  return {
    urls: catalog.urls,
    quests: normalizeTarkovDevTasks({
      data: catalog.data,
      english: catalog.english,
      korean: catalog.korean,
      maps: catalog.maps,
      traders,
      itemIdByBsgId,
      itemNamesByBsgId,
    }),
  };
}

function liveCatalogSource(catalog) {
  return {
    meta: {
      count: catalog.quests.length,
      liveTaskCount: catalog.quests.length,
      liveTaskSource: catalog.urls.tasks,
    },
    quests: catalog.quests,
  };
}

async function main() {
  const inputOption = option("--input", defaultInput);
  const inputPath = inputOption === "-" ? null : path.resolve(inputOption);
  const outputPath = path.resolve(option("--output", defaultOutput));
  const localPack = JSON.parse(
    inputPath ? await readFile(inputPath, "utf8") : await readStandardInput(),
  );
  const [
    wikiMeta,
    regularSources,
    pveSources,
    pvpSeasonSources,
    liveItems,
    liveItemsEnglish,
    liveItemsKorean,
  ] = await Promise.all([
    loadWikiMeta(),
    loadLiveCatalogSources("regular"),
    loadLiveCatalogSources("pve"),
    loadLiveCatalogSources("pvpSeason"),
    fetchJson(liveItemsUrl),
    fetchJson(liveItemsEnglishUrl),
    fetchJson(liveItemsKoreanUrl),
  ]);
  const referencedItemIds = collectTarkovDevTaskItemIds(
    regularSources.data,
    pveSources.data,
    pvpSeasonSources.data,
  );
  const mergedItems = mergeTarkovDevItems({
    localItems: localPack.items ?? [],
    data: liveItems.data ?? liveItems,
    english: {
      ...(liveItemsEnglish.data ?? liveItemsEnglish),
      ...regularSources.english,
      ...pveSources.english,
      ...pvpSeasonSources.english,
    },
    korean: {
      ...(liveItemsKorean.data ?? liveItemsKorean),
      ...regularSources.korean,
      ...pveSources.korean,
      ...pvpSeasonSources.korean,
    },
    referencedItemIds,
  });
  const enrichedLocalPack = {
    ...localPack,
    meta: {
      ...(localPack.meta ?? {}),
      counts: {
        ...(localPack.meta?.counts ?? {}),
        items: mergedItems.items.length,
      },
    },
    items: mergedItems.items,
  };
  const traders = enrichedLocalPack.traders ?? [];
  const regularCatalog = normalizeLiveCatalog(
    regularSources,
    traders,
    mergedItems.itemIdByBsgId,
    mergedItems.itemNamesByBsgId,
  );
  const pveCatalog = normalizeLiveCatalog(
    pveSources,
    traders,
    mergedItems.itemIdByBsgId,
    mergedItems.itemNamesByBsgId,
  );
  const pvpSeasonCatalog = normalizeLiveCatalog(
    pvpSeasonSources,
    traders,
    mergedItems.itemIdByBsgId,
    mergedItems.itemNamesByBsgId,
  );

  const regular = mergeQuestSources(
    createQuestCatalogSeed(enrichedLocalPack, regularCatalog.quests),
    liveCatalogSource(regularCatalog),
    wikiMeta,
  );
  const pve = mergeQuestSources(
    createQuestCatalogSeed(localPack, pveCatalog.quests),
    liveCatalogSource(pveCatalog),
    wikiMeta,
  );
  const pvpSeason = mergeQuestSources(
    createQuestCatalogSeed(localPack, pvpSeasonCatalog.quests),
    liveCatalogSource(pvpSeasonCatalog),
    wikiMeta,
  );
  const refreshed = assembleQuestCatalogPack({ regular, pve, pvpSeason });
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(refreshed, null, 2)}\n`, "utf8");
  await rename(temporaryPath, outputPath);
  console.log(JSON.stringify({
    input: inputPath ?? "stdin",
    output: outputPath,
    before: localPack.quests.length,
    after: refreshed.quests.length,
    appended: refreshed.quests.length - localPack.quests.length,
    catalogs: refreshed.meta.sources.questCatalogCounts,
    ...refreshed.meta.sources,
  }, null, 2));
}

main().catch((error) => {
  console.error(`quest pack refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
