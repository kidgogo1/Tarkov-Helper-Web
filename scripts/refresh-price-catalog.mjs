#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildItemPriceCatalog, fetchFixedJson } from "./item-price-catalog.mjs";
import { localizeItemData } from "./item-localization.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const defaultDataPath = path.join(projectRoot, "public", "data", "tarkov-data.json");
const defaultOutputPath = path.join(projectRoot, "public", "data", "item-price-catalog.json");
const sourceUrls = Object.freeze({
  regular: "https://json.tarkov.dev/regular/items",
  pve: "https://json.tarkov.dev/pve/items",
  english: "https://json.tarkov.dev/regular/items_en",
  korean: "https://json.tarkov.dev/regular/items_ko",
});
const ITEM_ID_PATTERN = /^[0-9a-f]{24}$/;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function omitSyntheticItems(document, label) {
  const items = document?.data?.items;
  if (items === null || typeof items !== "object" || Array.isArray(items)) {
    throw new Error(`${label} items document is invalid`);
  }
  const filteredItems = {};
  let omitted = 0;
  for (const [id, item] of Object.entries(items)) {
    if (!ITEM_ID_PATTERN.test(id) || item?.id !== id) {
      omitted += 1;
      continue;
    }
    filteredItems[id] = item;
  }
  return { document: { ...document, data: { ...document.data, items: filteredItems } }, omitted };
}

async function main() {
  const dataPath = path.resolve(option("--data", defaultDataPath));
  const outputPath = path.resolve(option("--output", defaultOutputPath));
  const [pack, regular, pve, english, korean] = await Promise.all([
    readFile(dataPath, "utf8").then(JSON.parse),
    fetchFixedJson(sourceUrls.regular, 32 * 1024 * 1024),
    fetchFixedJson(sourceUrls.pve, 32 * 1024 * 1024),
    fetchFixedJson(sourceUrls.english, 8 * 1024 * 1024),
    fetchFixedJson(sourceUrls.korean, 8 * 1024 * 1024),
  ]);
  const regularItems = omitSyntheticItems(regular, "regular");
  const pveItems = omitSyntheticItems(pve, "pve");
  const catalog = buildItemPriceCatalog({
    generatedAt: new Date().toISOString(),
    regular: regularItems.document,
    pve: pveItems.document,
    english,
    korean,
    localItems: pack.items,
  });
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(catalog)}\n`, "utf8");
  await rename(temporaryPath, outputPath);
  const localization = localizeItemData(pack, catalog);
  if (localization.changed > 0) {
    const temporaryDataPath = `${dataPath}.tmp`;
    await writeFile(temporaryDataPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
    await rename(temporaryDataPath, dataPath);
  }
  console.log(JSON.stringify({
    output: outputPath,
    omittedSyntheticItems: regularItems.omitted + pveItems.omitted,
    itemLocalization: localization,
    ...catalog.meta,
  }, null, 2));
}

main().catch((error) => {
  console.error(`price catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
