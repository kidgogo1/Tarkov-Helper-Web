#!/usr/bin/env node

/**
 * Build a small, reviewable Wiki guide index for the quest detail view.
 *
 * The guide index intentionally stores only parsed text and hotlinked image
 * URLs. It never downloads or republishes Wiki artwork. Missing/blocked pages
 * are recorded as errors so a refresh cannot silently invent location data.
 */
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const inputPath = path.join(root, "public", "data", "tarkov-data.json");
const defaultOutput = path.join(root, "public", "data", "quest-wiki-guides.json");
const apiUrl = "https://escapefromtarkov.fandom.com/api.php";
const userAgent = "TarkovHelperWeb-WikiGuideRefresh/1.0 (quest location verification)";
const maxImages = 8;
const concurrency = 5;

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function cleanWiki(value) {
  return String(value ?? "")
    .replace(/<!--.*?-->/gs, "")
    .replace(/<ref[^>]*>.*?<\/ref>/gis, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, target, label) => label || target)
    .replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, "$1")
    .replace(/'''?|''/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function section(wikitext, heading) {
  const source = String(wikitext ?? "");
  const start = source.search(new RegExp(`^==\\s*${heading}\\s*==\\s*$`, "im"));
  if (start < 0) return "";
  const bodyStart = source.indexOf("\n", start);
  if (bodyStart < 0) return "";
  const next = source.slice(bodyStart + 1).search(/^==[^=].*==\s*$/im);
  return next < 0
    ? source.slice(bodyStart + 1)
    : source.slice(bodyStart + 1, bodyStart + 1 + next);
}

function infoboxLocation(wikitext) {
  const match = String(wikitext ?? "").match(/^\|[ \t]*location[ \t]*=[ \t]*(.+)$/im);
  if (!match) return [];
  return [...match[1].matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g)]
    .map((item) => cleanWiki(item[1]))
    .filter(Boolean);
}

function objectiveLines(wikitext) {
  return section(wikitext, "Objectives")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*[*#]+\s+(.+)$/)?.[1])
    .filter(Boolean)
    .map(cleanWiki)
    .filter((line) => line.length > 1 && !/^optional$/i.test(line))
    .slice(0, 30);
}

function guideSummary(wikitext) {
  const guide = section(wikitext, "Guide")
    .replace(/\{\|[\s\S]*?\|\}/g, " ")
    .replace(/<gallery[\s\S]*$/gi, "")
    .replace(/^\s*[*#].*$/gm, "")
    .split(/\r?\n\s*\r?\n/)
    .map(cleanWiki)
    .find((line) => line.length >= 24 && !/^file:/i.test(line) && !/^(?:[a-z]{2}):/i.test(line));
  return guide ? guide.slice(0, 1200) : "";
}

function galleryImages(html) {
  const images = [];
  const blockPattern = /<li[^>]*class="gallerybox"[\s\S]*?<\/li>/gi;
  for (const match of String(html ?? "").matchAll(blockPattern)) {
    const block = match[0];
    const source = block.match(/<img[^>]+src="(https:\/\/static\.wikia\.nocookie\.net\/[^"?]+(?:\?[^" ]+)?)"/i)?.[1];
    const link = block.match(/<a[^>]+href="(https:\/\/static\.wikia\.nocookie\.net\/[^" ]+)"/i)?.[1];
    const caption = cleanWiki(block.match(/class="gallerytext"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "");
    const imageUrl = source || link;
    if (!imageUrl || images.some((image) => image.url === imageUrl)) continue;
    images.push({ url: imageUrl, caption: caption || "Wiki guide image" });
    if (images.length >= maxImages) break;
  }
  return images;
}

function questTitle(link) {
  try {
    const title = decodeURIComponent(new URL(link).pathname.replace(/^\/wiki\//, ""));
    return title.replaceAll("_", " ");
  } catch {
    return "";
  }
}

async function fetchQuest(quest) {
  if (!quest.wikiPageLink) return [quest.id, { error: "NO_WIKI_LINK" }];
  const page = questTitle(quest.wikiPageLink);
  if (!page) return [quest.id, { error: "INVALID_WIKI_LINK" }];
  const url = `${apiUrl}?action=parse&page=${encodeURIComponent(page)}&prop=wikitext%7Ctext&format=json&formatversion=2`;
  let response;
  try {
    response = await fetch(url, { headers: { "User-Agent": userAgent } });
  } catch (error) {
    return [quest.id, { error: `NETWORK: ${error instanceof Error ? error.message : String(error)}` }];
  }
  if (!response.ok) return [quest.id, { error: `HTTP_${response.status}` }];
  let payload;
  try {
    payload = await response.json();
  } catch {
    return [quest.id, { error: "INVALID_JSON" }];
  }
  const parsed = payload?.parse;
  if (!parsed?.wikitext) return [quest.id, { error: "PAGE_NOT_FOUND" }];
  const wikitext = parsed.wikitext;
  return [quest.id, {
    wikiTitle: String(parsed.title ?? page),
    wikiPageLink: quest.wikiPageLink,
    wikiRevisionId: Number.isInteger(parsed.revid) ? parsed.revid : undefined,
    wikiLocation: infoboxLocation(wikitext),
    wikiObjectives: objectiveLines(wikitext),
    guideSummary: guideSummary(wikitext),
    images: galleryImages(parsed.text),
  }];
}

async function main() {
  const outputPath = path.resolve(arg("--output", defaultOutput));
  const data = JSON.parse(await readFile(inputPath, "utf8"));
  const quests = Array.isArray(data.quests) ? data.quests : [];
  const entries = {};
  let cursor = 0;
  let completed = 0;
  async function worker() {
    while (cursor < quests.length) {
      const index = cursor++;
      const [id, entry] = await fetchQuest(quests[index]);
      entries[id] = entry;
      completed += 1;
      if (completed % 25 === 0 || completed === quests.length) {
        console.error(`Wiki quest guides: ${completed}/${quests.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, quests.length) }, worker));
  const orderedEntries = Object.fromEntries(
    quests.map((quest) => [quest.id, entries[quest.id]]),
  );
  const output = {
    schemaVersion: 1,
    source: "https://escapefromtarkov.fandom.com/wiki/Quests",
    fetchedAt: new Date().toISOString(),
    questCount: quests.length,
    entries: orderedEntries,
  };
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await rename(temporaryPath, outputPath);
  const good = Object.values(entries).filter((entry) => !entry.error).length;
  const withImages = Object.values(entries).filter((entry) => !entry.error && entry.images?.length).length;
  console.log(JSON.stringify({ output: outputPath, questCount: quests.length, verifiedPages: good, pagesWithImages: withImages }, null, 2));
}

main().catch((error) => {
  console.error(`quest Wiki guide refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
