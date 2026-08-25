#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const projectRoot = path.resolve(import.meta.dirname, "..");
const dataPath = path.join(projectRoot, "public", "data", "tarkov-data.json");
const outputDirectory = path.join(projectRoot, "output", "playwright", "key-inventory-sheets");
const mapKeyIndexPath = path.join(projectRoot, "src", "features", "map", "key-map-index.ts");
const wikiApiUrl = "https://escapefromtarkov.fandom.com/api.php";
const userAgent = "TarkovHelper-Web-KeyInventorySheets/1.0";

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[’'`]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-zA-Z0-9+ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function pageTitleFromLink(link) {
  if (typeof link !== "string" || !link.trim()) return "";
  try {
    const url = new URL(link);
    const marker = "/wiki/";
    const index = url.pathname.toLowerCase().indexOf(marker);
    if (index < 0) return "";
    return decodeURIComponent(url.pathname.slice(index + marker.length)).replace(/_/g, " ");
  } catch {
    return "";
  }
}

function extractWikiLinks(wikitext) {
  const links = [];
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  for (const match of wikitext.matchAll(pattern)) {
    const target = match[1].trim();
    if (target && !target.includes(":")) links.push(target);
  }
  return links;
}

function isKeyItem(item) {
  const categories = Array.isArray(item.categories) ? item.categories : [];
  return categories.some((category) => String(category).toLocaleLowerCase("en-US").includes("key")) ||
    String(item.category ?? "").toLocaleLowerCase("en-US").includes("key");
}

function imageMime(iconPath) {
  const extension = path.extname(iconPath).toLocaleLowerCase("en-US");
  return extension === ".png" ? "image/png" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/webp";
}

async function fetchWikiBatch(titles) {
  const params = new URLSearchParams({
    action: "query",
    titles: titles.join("|"),
    prop: "revisions",
    rvprop: "content",
    rvslots: "main",
    format: "json",
    formatversion: "2",
  });
  const response = await fetch(`${wikiApiUrl}?${params.toString()}`, {
    headers: { "User-Agent": userAgent, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Wiki API returned HTTP ${response.status}`);
  const payload = await response.json();
  const pages = Array.isArray(payload?.query?.pages) ? payload.query.pages : [];
  return new Map(pages.map((page) => [page.title, page.revisions?.[0]?.slots?.main?.content ?? ""]));
}

async function fetchWikiContent(titles) {
  const result = new Map();
  for (let index = 0; index < titles.length; index += 50) {
    const batch = titles.slice(index, index + 50);
    const pages = await fetchWikiBatch(batch);
    for (const [title, content] of pages) result.set(title, content);
    if (index + 50 < titles.length) await sleep(150);
  }
  return result;
}

function buildMapIndex(mapConfigs) {
  const index = new Map();
  for (const config of mapConfigs) {
    const aliases = [config.key, config.displayName, ...(Array.isArray(config.aliases) ? config.aliases : [])];
    for (const alias of aliases) {
      const normalized = normalize(alias);
      if (normalized) index.set(normalized, config.key);
    }
  }
  return index;
}

function mapKeysForContent(wikitext, mapIndex) {
  const keys = new Set();
  for (const link of extractWikiLinks(wikitext)) {
    const mapKey = mapIndex.get(normalize(link));
    if (mapKey) keys.add(mapKey);
  }
  return [...keys];
}

function itemCard(item, imageDataUrl) {
  const shortName = item.shortNameEn || item.nameEn || item.name;
  const fullName = item.nameEn || item.name;
  const isKeycard = (Array.isArray(item.categories) ? item.categories : []).some((category) =>
    String(category).toLocaleLowerCase("en-US").includes("keycard"),
  );
  return `<article class="key-card">
    <div class="icon-frame"><img src="${imageDataUrl}" alt="${escapeHtml(fullName)}"></div>
    <div class="short-name">${escapeHtml(shortName)}</div>
    <div class="full-name">${escapeHtml(fullName)}</div>
    <div class="kind">${isKeycard ? "KEYCARD" : "KEY"}</div>
  </article>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

function mapKeyIndexSource(manifest) {
  const index = Object.fromEntries(
    manifest.maps.map((map) => [map.key, map.itemIds ?? []]),
  );
  return `/**
 * Wiki-derived map → key item index. Regenerate with data:create-key-sheets after a data refresh.
 * Coordinates are intentionally not included; user-confirmed locations live in profile keyMarkers.
 */
export const MAP_KEY_ITEM_IDS: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(index, null, 2)};
`;
}

function sheetHtml(config, items, cards) {
  const mapTitle = escapeHtml(config?.displayName ?? "Map not detected");
  const subtitle = config ? `${items.length} keys and keycards referenced by the wiki` : `${items.length} keys without a map link in the wiki page`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;background:#11151b;color:#f1f4f6;font-family:Segoe UI,Arial,sans-serif}
    body{width:1160px;padding:30px}.header{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid #394653;padding-bottom:18px;margin-bottom:22px}
    h1{font-size:30px;font-weight:600;letter-spacing:.02em;margin:0 0 5px}.subtitle{font-size:14px;color:#a5b2bd}.count{font-size:15px;color:#6fd6c7}
    .grid{display:grid;grid-template-columns:repeat(6,1fr);gap:14px}.key-card{min-height:168px;padding:11px 10px 10px;background:#1b232c;border:1px solid #3d4c59;border-radius:8px;text-align:center;box-shadow:0 4px 12px #0005}
    .icon-frame{height:82px;display:flex;align-items:center;justify-content:center;margin-bottom:7px}.icon-frame img{width:72px;height:72px;object-fit:contain;image-rendering:auto}
    .short-name{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.full-name{min-height:32px;margin-top:3px;color:#afbbc4;font-size:11px;line-height:1.35}.kind{margin-top:8px;font-size:10px;letter-spacing:.12em;color:#6fd6c7}
    .empty{padding:42px;text-align:center;color:#a5b2bd;border:1px dashed #3d4c59;border-radius:8px}
  </style></head><body><header class="header"><div><h1>${mapTitle}</h1><div class="subtitle">${escapeHtml(subtitle)}</div></div><div class="count">Tarkov Helper · Key Inventory</div></header>${cards ? `<main class="grid">${cards}</main>` : '<div class="empty">No mapped key inventory entries</div>'}</body></html>`;
}

async function main() {
  const data = JSON.parse(await readFile(dataPath, "utf8"));
  const keyItems = data.items.filter(isKeyItem);
  const mapIndex = buildMapIndex(data.mapConfigs);
  const titles = [...new Set(keyItems.map((item) => pageTitleFromLink(item.wikiPageLink)).filter(Boolean))];
  const wikiContent = await fetchWikiContent(titles);
  const groups = new Map(data.mapConfigs.map((config) => [config.key, []]));
  const unmapped = [];

  for (const item of keyItems) {
    const title = pageTitleFromLink(item.wikiPageLink);
    const mapKeys = mapKeysForContent(wikiContent.get(title) ?? "", mapIndex);
    if (mapKeys.length === 0) unmapped.push(item);
    for (const mapKey of mapKeys) groups.get(mapKey)?.push(item);
  }

  await mkdir(outputDirectory, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
  const manifest = { generatedAt: new Date().toISOString(), source: wikiApiUrl, maps: [], unmapped: [] };

  for (const config of data.mapConfigs) {
    const items = [...new Map((groups.get(config.key) ?? []).map((item) => [item.id, item])).values()]
      .sort((left, right) => (left.shortNameEn || left.nameEn).localeCompare(right.shortNameEn || right.nameEn, "en"));
    const cards = [];
    for (const item of items) {
      const iconPath = path.join(projectRoot, "public", item.localIcon ?? "");
      const bytes = await readFile(iconPath);
      cards.push(itemCard(item, `data:${imageMime(iconPath)};base64,${bytes.toString("base64")}`));
    }
    const fileName = `${config.key.toLocaleLowerCase("en-US")}.png`;
    await page.setContent(sheetHtml(config, items, cards.join("")), { waitUntil: "load" });
    await page.screenshot({ path: path.join(outputDirectory, fileName), fullPage: true });
    manifest.maps.push({
      key: config.key,
      displayName: config.displayName,
      fileName,
      itemCount: items.length,
      itemIds: items.map((item) => item.id),
      items: items.map((item) => item.nameEn),
    });
  }

  const unmappedItems = [...new Map(unmapped.map((item) => [item.id, item])).values()]
    .sort((left, right) => (left.nameEn || left.name).localeCompare(right.nameEn || right.name, "en"));
  const unmappedFileName = "unmapped.png";
  const unmappedCards = [];
  for (const item of unmappedItems) {
    const iconPath = path.join(projectRoot, "public", item.localIcon ?? "");
    const bytes = await readFile(iconPath);
    unmappedCards.push(itemCard(item, `data:${imageMime(iconPath)};base64,${bytes.toString("base64")}`));
  }
  await page.setContent(sheetHtml(undefined, unmappedItems, unmappedCards.join("")), { waitUntil: "load" });
  await page.screenshot({ path: path.join(outputDirectory, unmappedFileName), fullPage: true });
  manifest.unmapped = { fileName: unmappedFileName, itemCount: unmappedItems.length, items: unmappedItems.map((item) => ({ name: item.nameEn, wikiPageLink: item.wikiPageLink })) };

  await browser.close();
  await writeFile(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(mapKeyIndexPath, mapKeyIndexSource(manifest), "utf8");
  console.log(JSON.stringify({ outputDirectory, keyItems: keyItems.length, mappedItems: keyItems.length - unmappedItems.length, maps: manifest.maps.map(({ key, itemCount }) => ({ key, itemCount })), unmapped: unmappedItems.length }, null, 2));
}

main().catch((error) => {
  console.error(`key inventory sheet generation failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
