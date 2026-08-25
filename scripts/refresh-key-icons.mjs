#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const defaultDataPath = path.join(projectRoot, "public", "data", "tarkov-data.json");
const itemIconDirectory = path.join(projectRoot, "public", "assets", "items");
const itemsUrl = "https://json.tarkov.dev/regular/items";
const userAgent = "TarkovHelper-Web-KeyIconRefresh/1.0";
const retryDelaysMs = [250, 750, 1_500];

const MANUAL_NORMALIZED_ALIASES = new Map([
  ["14-4 rst.", "station-14-4-kord-arshavin-k-pass-restored"],
  ["a.p. blue", "reprogrammed-keycard-for-aps-apartment-lock-blue"],
  ["a.p. green", "reprogrammed-keycard-for-aps-apartment-lock-green"],
  ["a.p. red", "reprogrammed-keycard-for-aps-apartment-lock-red"],
]);

const MANUAL_ICON_URLS = new Map([
  [
    "armory key",
    "https://static.wikia.nocookie.net/escapefromtarkov_gamepedia/images/5/55/Armory_key_icon.png/revision/latest?cb=20251223160249",
  ],
]);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const forceRefresh = process.argv.includes("--force");

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[’'`]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function normalizeWikiLink(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    return `${url.hostname.toLowerCase()}${decodeURIComponent(url.pathname).replace(/\/+$/, "")}`;
  } catch {
    return value.trim().replace(/\/+$/, "").toLowerCase();
  }
}

function wikiPageSlug(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    const marker = "/wiki/";
    const index = url.pathname.toLowerCase().indexOf(marker);
    if (index < 0) return "";
    return normalizeText(decodeURIComponent(url.pathname.slice(index + marker.length)).replace(/_/g, " "));
  } catch {
    return "";
  }
}

function itemIconFilename(itemId, iconLink) {
  const extension = path.extname(new URL(iconLink).pathname).toLowerCase();
  const safeExtension = [".webp", ".png", ".jpg", ".jpeg"].includes(extension)
    ? extension
    : ".webp";
  return `${createHash("sha256").update(itemId).digest("hex")}${safeExtension}`;
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fetchJson(url) {
  for (let attempt = 0; attempt < retryDelaysMs.length + 1; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": userAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return response.json();
      if (response.status < 500 && response.status !== 429) {
        throw new Error(`${url} returned HTTP ${response.status}`);
      }
      if (attempt === retryDelaysMs.length) {
        throw new Error(`${url} returned HTTP ${response.status}`);
      }
    } catch (error) {
      if (attempt === retryDelaysMs.length) throw error;
    }
    await sleep(retryDelaysMs[attempt]);
  }
  throw new Error(`Unable to fetch ${url}`);
}

async function downloadBytes(url) {
  for (let attempt = 0; attempt < retryDelaysMs.length + 1; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": userAgent, Accept: "image/avif,image/webp,image/png,image/*" },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().startsWith("image/")) {
          throw new Error(`${url} returned non-image content type ${contentType || "unknown"}`);
        }
        return Buffer.from(await response.arrayBuffer());
      }
      if (response.status < 500 && response.status !== 429) {
        throw new Error(`${url} returned HTTP ${response.status}`);
      }
      if (attempt === retryDelaysMs.length) {
        throw new Error(`${url} returned HTTP ${response.status}`);
      }
    } catch (error) {
      if (attempt === retryDelaysMs.length) throw error;
    }
    await sleep(retryDelaysMs[attempt]);
  }
  throw new Error(`Unable to download ${url}`);
}

function buildApiIndexes(apiItems) {
  const byWiki = new Map();
  const byNormalizedName = new Map();
  for (const item of apiItems) {
    if (!item || typeof item !== "object" || typeof item.id !== "string") continue;
    const wiki = normalizeWikiLink(item.wikiLink);
    if (wiki && !byWiki.has(wiki)) byWiki.set(wiki, item);
    if (typeof item.normalizedName === "string" && !byNormalizedName.has(item.normalizedName)) {
      byNormalizedName.set(item.normalizedName, item);
    }
  }
  return { byWiki, byNormalizedName };
}

function matchApiItem(localItem, indexes) {
  const wikiMatch = indexes.byWiki.get(normalizeWikiLink(localItem.wikiPageLink));
  if (wikiMatch) return { item: wikiMatch, strategy: "wiki-link" };

  const candidateSlugs = [
    MANUAL_NORMALIZED_ALIASES.get(String(localItem.shortNameEn ?? "").toLowerCase()),
    wikiPageSlug(localItem.wikiPageLink),
    normalizeText(localItem.nameEn),
  ].filter(Boolean);
  for (const slug of candidateSlugs) {
    const match = indexes.byNormalizedName.get(slug);
    if (match) return { item: match, strategy: slug === candidateSlugs[0] ? "manual-alias" : "normalized-name" };
  }
  return undefined;
}

async function writeAtomically(destination, bytes) {
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
}

async function runWithConcurrency(records, limit, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, records.length) }, async () => {
    while (cursor < records.length) {
      const index = cursor;
      cursor += 1;
      await worker(records[index], index);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const dataPath = path.resolve(option("--data", defaultDataPath));
  const data = JSON.parse(await readFile(dataPath, "utf8"));
  const payload = await fetchJson(itemsUrl);
  const rawItems = payload?.data?.items;
  if (!rawItems || typeof rawItems !== "object" || Array.isArray(rawItems)) {
    throw new Error("The Tarkov.dev items response does not contain a keyed data.items object.");
  }
  const apiItems = Object.values(rawItems);
  const indexes = buildApiIndexes(apiItems);
  const keyItems = data.items.filter((item) =>
    (Array.isArray(item.categories) && item.categories.some((category) =>
      String(category).toLowerCase().includes("key"))) ||
    String(item.category ?? "").toLowerCase().includes("key"),
  );
  await mkdir(itemIconDirectory, { recursive: true });

  const candidates = [];
  const unmatched = [];
  const noRemoteIcon = [];
  const matchStrategies = {};
  for (const localItem of keyItems) {
    if (!forceRefresh && localItem.localIcon && await fileExists(path.join(projectRoot, "public", localItem.localIcon))) continue;
    const match = matchApiItem(localItem, indexes);
    if (!match) {
      const manualIconUrl = MANUAL_ICON_URLS.get(String(localItem.nameEn ?? "").toLowerCase());
      if (!manualIconUrl) {
        unmatched.push(localItem.shortNameEn || localItem.nameEn || localItem.id);
        continue;
      }
      candidates.push({
        localItem,
        apiItem: { id: `manual-${normalizeText(localItem.nameEn)}`, iconLink: manualIconUrl },
        filename: itemIconFilename(localItem.id, manualIconUrl),
      });
      matchStrategies["manual-icon"] = (matchStrategies["manual-icon"] ?? 0) + 1;
      continue;
    }
    matchStrategies[match.strategy] = (matchStrategies[match.strategy] ?? 0) + 1;
    if (typeof match.item.iconLink !== "string" || !match.item.iconLink) {
      noRemoteIcon.push(localItem.shortNameEn || localItem.nameEn || localItem.id);
      continue;
    }
    const filename = itemIconFilename(localItem.id, match.item.iconLink);
    candidates.push({ localItem, apiItem: match.item, filename });
  }

  const failures = [];
  let downloaded = 0;
  let reused = 0;
  await runWithConcurrency(candidates, 6, async ({ localItem, apiItem, filename }) => {
    const destination = path.join(itemIconDirectory, filename);
    try {
      if (forceRefresh || !await fileExists(destination)) {
        const bytes = await downloadBytes(apiItem.iconLink);
        await writeAtomically(destination, bytes);
        downloaded += 1;
      } else {
        reused += 1;
      }
      localItem.localIcon = `assets/items/${filename}`;
    } catch (error) {
      failures.push({
        name: localItem.shortNameEn || localItem.nameEn || localItem.id,
        url: apiItem.iconLink,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const temporaryDataPath = `${dataPath}.${process.pid}.tmp`;
  await writeFile(temporaryDataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temporaryDataPath, dataPath);

  console.log(JSON.stringify({
    dataPath,
    itemsUrl,
    keyItems: keyItems.length,
    downloaded,
    reused,
    unmatched,
    noRemoteIcon,
    failures,
    matchStrategies,
  }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`key icon refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
