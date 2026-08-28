import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const launcherPath = path.join(projectRoot, "portable", "launcher.ps1");
const itemId = "5447a9cd4bdc2dbd208b4567";
const redirectItemId = "5c0530ee86f774697952d952";
const oversizedItemId = "5a0c27731526d80618476ac4";

function startLauncher(appRoot, stateDirectory, upstreamBaseUrl) {
  const child = spawn("powershell.exe", [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcherPath,
    "-Action", "Serve", "-Root", appRoot, "-Port", "0", "-NoBrowser",
    "-StateDirectory", stateDirectory,
  ], {
    env: {
      ...process.env,
      TARKOV_HELPER_PRICE_TEST_MODE: "1",
      TARKOV_HELPER_PRICE_TEST_BASE_URL: upstreamBaseUrl,
      TARKOV_HELPER_PRICE_TEST_FRESH_SECONDS: "600",
      TARKOV_HELPER_PRICE_TEST_MAX_BYTES: "1024",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Price server startup timed out.\n${stdout}\n${stderr}`)), 10_000);
    const inspect = () => {
      const match = stdout.match(/TARKOV_HELPER_URL=(http:\/\/127\.0\.0\.1:\d+\/)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    };
    child.stdout.on("data", inspect);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Price server exited with ${code}.\n${stdout}\n${stderr}`)));
  });
  return { child, ready };
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

function sameOriginHeaders(baseUrl) {
  return { origin: new URL(baseUrl).origin, "sec-fetch-site": "same-origin" };
}

test("portable price API validates same-origin queries and serves live, fresh-cache, and stale-cache quotes", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-price-"));
  const appRoot = path.join(temporaryRoot, "app");
  const stateDirectory = path.join(temporaryRoot, "state");
  await mkdir(appRoot);
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Price test</title>", "utf8");

  let upstreamCalls = 0;
  const upstreamPaths = [];
  let failUpstream = false;
  const now = Date.now();
  const points = [
    { priceMin: 40_000, price: 50_000, offerCount: 12, timestamp: now - 48 * 60 * 60 * 1000 },
    { priceMin: 30_000, price: 45_000, offerCount: 20, timestamp: now - 20 * 60 * 60 * 1000 },
    { priceMin: 25_000, price: 55_000, offerCount: 31, timestamp: now },
  ];
  const upstream = http.createServer((request, response) => {
    upstreamCalls += 1;
    upstreamPaths.push(request.url);
    if (request.url?.endsWith(redirectItemId)) {
      response.writeHead(302, { location: "https://attacker.invalid/quote" }).end();
      return;
    }
    if (request.url?.endsWith(oversizedItemId)) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: points, padding: "x".repeat(2_000) }));
      return;
    }
    if (failUpstream) {
      response.writeHead(503).end("unavailable");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: points, translations: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address && typeof address === "object");
  const upstreamBaseUrl = `http://127.0.0.1:${address.port}`;

  const launcher = startLauncher(appRoot, stateDirectory, upstreamBaseUrl);
  t.after(async () => {
    await stopChild(launcher.child);
    await new Promise((resolve) => upstream.close(resolve));
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const baseUrl = await launcher.ready;
  const headers = sameOriginHeaders(baseUrl);
  const quoteUrl = new URL(`api/v1/item-prices/quote?itemId=${itemId}&gameMode=pvp`, baseUrl);

  const liveResponse = await fetch(quoteUrl, { headers });
  assert.equal(liveResponse.status, 200);
  assert.equal(liveResponse.headers.get("access-control-allow-origin"), null);
  const live = await liveResponse.json();
  assert.deepEqual(live, {
    protocolVersion: 1,
    itemId,
    gameMode: "pvp",
    source: "LIVE",
    fetchedAt: live.fetchedAt,
    expiresAt: live.expiresAt,
    isStale: false,
    flea: {
      lastLowPrice: 25_000,
      avg24hPrice: 50_000,
      low24hPrice: 25_000,
      high24hPrice: 55_000,
      changeLast48hPercent: 10,
      offerCount: 31,
      updatedAt: new Date(now).toISOString(),
    },
  });
  assert.equal(upstreamCalls, 1);

  const pveUrl = new URL(`api/v1/item-prices/quote?itemId=${itemId}&gameMode=pve`, baseUrl);
  const pve = await (await fetch(pveUrl, { headers })).json();
  assert.equal(pve.gameMode, "pve");
  assert.equal(upstreamCalls, 2);
  assert.deepEqual(upstreamPaths.slice(0, 2), [
    `/regular/prices/${itemId}`,
    `/pve/prices/${itemId}`,
  ]);

  const cached = await (await fetch(quoteUrl, { headers })).json();
  assert.equal(cached.source, "CACHE");
  assert.equal(cached.isStale, false);
  assert.equal(upstreamCalls, 2);

  const cachePath = path.join(stateDirectory, "price-cache-v1", `pvp-${itemId}.json`);
  const cache = JSON.parse(await readFile(cachePath, "utf8"));
  const staleFetchedAt = new Date(Date.now() - 601_000);
  cache.fetchedAt = staleFetchedAt.toISOString();
  cache.expiresAt = new Date(staleFetchedAt.getTime() + 600_000).toISOString();
  await writeFile(cachePath, JSON.stringify(cache), "utf8");
  failUpstream = true;
  const stale = await (await fetch(quoteUrl, { headers })).json();
  assert.equal(stale.source, "STALE_CACHE");
  assert.equal(stale.isStale, true);

  const crossSite = await fetch(quoteUrl, { headers: { origin: "https://attacker.invalid", "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.status, 403);
  assert.equal((await fetch(new URL(`api/v1/item-prices/quote?itemId=${itemId}&itemId=${itemId}&gameMode=pvp`, baseUrl), { headers })).status, 400);
  assert.equal((await fetch(new URL(`api/v1/item-prices/quote?itemId=bad&gameMode=pvp`, baseUrl), { headers })).status, 400);
  assert.equal((await fetch(quoteUrl, { method: "POST", headers })).status, 405);
  assert.equal((await fetch(new URL(`api/v1/item-prices/quote?itemId=${redirectItemId}&gameMode=pvp`, baseUrl), { headers })).status, 502);
  assert.equal((await fetch(new URL(`api/v1/item-prices/quote?itemId=${oversizedItemId}&gameMode=pvp`, baseUrl), { headers })).status, 502);
});
