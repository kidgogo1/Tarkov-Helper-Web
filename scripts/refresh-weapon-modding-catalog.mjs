#!/usr/bin/env node

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildWeaponModCatalog, fetchFixedJson } from "./weapon-modding-catalog.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const defaultOutputPath = path.join(projectRoot, "public", "data", "weapon-modding", "catalog.json");
const sourceUrls = Object.freeze({
  regular: "https://json.tarkov.dev/regular/items",
  pve: "https://json.tarkov.dev/pve/items",
  english: "https://json.tarkov.dev/regular/items_en",
  korean: "https://json.tarkov.dev/regular/items_ko",
  tasks: "https://json.tarkov.dev/regular/tasks",
  taskEnglish: "https://json.tarkov.dev/regular/tasks_en",
  taskKorean: "https://json.tarkov.dev/regular/tasks_ko",
});

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const outputPath = path.resolve(option("--output", defaultOutputPath));
  const [regular, pve, english, korean, tasks, taskEnglish, taskKorean] = await Promise.all([
    fetchFixedJson(sourceUrls.regular, 64 * 1024 * 1024),
    fetchFixedJson(sourceUrls.pve, 64 * 1024 * 1024),
    fetchFixedJson(sourceUrls.english, 12 * 1024 * 1024),
    fetchFixedJson(sourceUrls.korean, 12 * 1024 * 1024),
    fetchFixedJson(sourceUrls.tasks, 24 * 1024 * 1024),
    fetchFixedJson(sourceUrls.taskEnglish, 12 * 1024 * 1024),
    fetchFixedJson(sourceUrls.taskKorean, 12 * 1024 * 1024),
  ]);
  const catalog = buildWeaponModCatalog({
    generatedAt: new Date().toISOString(),
    regular,
    pve,
    english,
    korean,
    tasks,
    taskEnglish,
    taskKorean,
  });
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(catalog)}\n`, "utf8");
  await rename(temporaryPath, outputPath);
  console.log(JSON.stringify({
    output: outputPath,
    dataVersion: catalog.dataVersion,
    weapons: catalog.weaponIds.length,
    items: catalog.items.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(`weapon modding catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
