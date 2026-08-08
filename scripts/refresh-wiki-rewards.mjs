#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const defaultData = path.join(projectRoot, "public", "data", "tarkov-data.json");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function normalize(value) {
  return String(value ?? "")
    .toLocaleLowerCase("en-US")
    .replace(/[\u00d7x]/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

function parseItemLine(line, exactItems, candidates, itemById) {
  const body = line.replace(/^\*\s*/, "").trim();
  const countMatch = body.match(/^(\d+(?:\.\d+)?[\d,]*)\s*[\u00d7x]\s*/i);
  const count = countMatch ? Number(countMatch[1].replaceAll(",", "")) : 1;
  const text = (countMatch ? body.slice(countMatch[0].length) : body)
    .replace(/^\+\s*/, "")
    .replace(/^['"]|['"]$/g, "")
    .replace(/\s+Note:.*$/i, "")
    .trim();
  if (!text || /skill level|achievement|unlocks|unlock|barter|reputation|rep\b|exp\b|roubles?|trial/i.test(text)) {
    return null;
  }
  const exactId = exactItems.get(normalize(text));
  const candidate = exactId ? text : candidates.find((name) => normalize(text).includes(normalize(name)));
  if (!candidate) return { itemId: "", itemName: text, count };
  const itemId = exactId ?? exactItems.get(normalize(candidate)) ?? "";
  const item = itemById.get(itemId);
  return { itemId, itemName: item?.nameKo || item?.nameEn || item?.name || candidate, count };
}

function parseReward(record, exactItems, candidates, itemById) {
  const lines = record.rewards?.lines ?? [];
  const xp = lines.map((line) => line.match(/\+([\d,]+)\s*EXP/i)?.[1]).find(Boolean);
  const roubles = lines.map((line) => line.match(/([\d,]+)\s*Roubles?/i)?.[1]).find(Boolean);
  const reputation = lines.flatMap((line) => {
    const match = line.match(/^\*\s*(.*?)\s+Rep\s*([+-]?[\d.]+)/i);
    return match ? [{ trader: match[1].trim(), amount: Number(match[2]) }] : [];
  });
  const skills = lines.flatMap((line) => {
    const match = line.match(/^\*\s*\+?(\d+)\s+(.+?)\s+skill levels?/i);
    return match ? [{ skill: match[2].trim(), levels: Number(match[1]) }] : [];
  });
  const unlocks = lines
    .filter((line) => /unlock|achievement|barter|trial|insurance/i.test(line))
    .map((line) => line.replace(/^\*\s*/, "").trim());
  const rewardItems = lines.flatMap((line, index) => {
    const item = parseItemLine(line, exactItems, candidates, itemById);
    return item?.itemId
      ? [{ id: `wiki-reward-${index}`, itemId: item.itemId, itemName: item.itemName, count: item.count, requiresFir: false, requirementType: "Reward", sortOrder: index }]
      : [];
  });
  return { rewardItems, rewardXp: xp ? Number(xp.replaceAll(",", "")) : undefined, rewardRoubles: roubles ? Number(roubles.replaceAll(",", "")) : undefined, rewardReputation: reputation, rewardSkills: skills, rewardUnlocks: unlocks, rewardText: lines };
}

async function main() {
  const inputPath = path.resolve(option("--input", defaultData));
  const outputPath = path.resolve(option("--output", inputPath));
  const auditPath = path.resolve(option("--audit", path.join(projectRoot, "..", "..", "work", "reward-audit.json")));
  const data = JSON.parse(await readFile(inputPath, "utf8"));
  const audit = JSON.parse(await readFile(auditPath, "utf8"));
  const itemNames = data.items.flatMap((item) => [item.name, item.nameEn, item.nameKo, item.shortNameEn, item.shortNameKo].filter(Boolean).map((name) => [item.id, name]));
  const exactItems = new Map(itemNames.map(([id, name]) => [normalize(name), id]));
  const candidates = [...new Set(itemNames.map(([, name]) => String(name)))].sort((left, right) => normalize(right).length - normalize(left).length);
  const itemById = new Map(data.items.map((item) => [item.id, item]));
  const records = new Map(audit.records.map((record) => [record.requestedTitle, record]));
  let rewardQuestCount = 0;
  let rewardItemCount = 0;
  for (const quest of data.quests) {
    const title = decodeURIComponent((quest.wikiPageLink ?? "").split("/").pop() ?? "").replaceAll("_", " ");
    const record = records.get(title);
    if (!record?.hasRewardsSection) continue;
    const parsed = parseReward(record, exactItems, candidates, itemById);
    if (parsed.rewardText.length === 0) continue;
    rewardQuestCount += 1;
    rewardItemCount += parsed.rewardItems.length;
    const enriched = { rewardText: parsed.rewardText };
    if (parsed.rewardItems.length) enriched.rewardItems = parsed.rewardItems;
    if (parsed.rewardXp !== undefined) enriched.rewardXp = parsed.rewardXp;
    if (parsed.rewardRoubles !== undefined) enriched.rewardRoubles = parsed.rewardRoubles;
    if (parsed.rewardReputation.length) enriched.rewardReputation = parsed.rewardReputation;
    if (parsed.rewardSkills.length) enriched.rewardSkills = parsed.rewardSkills;
    if (parsed.rewardUnlocks.length) enriched.rewardUnlocks = parsed.rewardUnlocks;
    Object.assign(quest, enriched);
  }
  data.meta.sources = { ...(data.meta.sources ?? {}), refreshMode: "preserve-local-enriched-append-tarkovdata-wiki-rewards", wikiRewardQuestCount: rewardQuestCount, wikiRewardItemCount: rewardItemCount, wikiRewardRevisionTimestamp: data.meta.sources?.wikiRevisionTimestamp ?? audit.generatedAt };
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temporaryPath, outputPath);
  console.log(JSON.stringify({ input: inputPath, output: outputPath, rewardQuestCount, rewardItemCount }, null, 2));
}

main().catch((error) => {
  console.error(`wiki reward refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
