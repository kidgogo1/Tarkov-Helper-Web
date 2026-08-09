#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { localizeItemData } from "./item-localization.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const defaultDataPath = path.join(projectRoot, "public", "data", "tarkov-data.json");
const defaultCatalogPath = path.join(projectRoot, "public", "data", "item-price-catalog.json");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const dataPath = path.resolve(option("--data", defaultDataPath));
  const catalogPath = path.resolve(option("--catalog", defaultCatalogPath));
  const [data, catalog] = await Promise.all([
    readFile(dataPath, "utf8").then(JSON.parse),
    readFile(catalogPath, "utf8").then(JSON.parse),
  ]);
  const summary = localizeItemData(data, catalog);
  const temporaryPath = `${dataPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temporaryPath, dataPath);
  console.log(JSON.stringify({ dataPath, catalogPath, ...summary }, null, 2));
}

main().catch((error) => {
  console.error(`item localization refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
