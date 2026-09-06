import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const launcherPath = path.resolve(import.meta.dirname, "../../portable/launcher.ps1");
const weaponId = "5447a9cd4bdc2dbd208b4567";
const partId = "55d4b9964bdc2d1d4e8b456e";
const slotId = "55d354084bdc2d8c2f8b4568";
const secondSlotId = "55d354084bdc2d8c2f8b4569";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const root = { instanceId: "root:test", itemId: weaponId, children: [{ instanceId: "root:test/part", itemId: partId, slotId, children: [] }] };

async function fixture(t, handler) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-modding-preview-"));
  const appRoot = path.join(temporaryRoot, "app");
  await mkdir(appRoot);
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Preview test</title>");
  const upstream = http.createServer(handler);
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcherPath,
    "-Action", "Serve", "-Root", appRoot, "-Port", "0", "-NoBrowser", "-DisablePackageUpdates",
    "-StateDirectory", path.join(temporaryRoot, "state")], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TARKOV_HELPER_MODDING_PREVIEW_TEST_MODE: "1",
      TARKOV_HELPER_MODDING_PREVIEW_TEST_BASE_URL: `http://127.0.0.1:${upstream.address().port}` },
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 5000).unref(); });
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Preview server startup timed out: ${output}`)), 10000);
    child.stdout.on("data", () => {
      const match = output.match(/TARKOV_HELPER_URL=(http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(output)); });
  });
  return {
    baseUrl,
    post: (body, headers = {}) => fetch(new URL("api/modding/preview", baseUrl), {
      method: "POST", headers: { "content-type": "application/json", origin: new URL(baseUrl).origin, "sec-fetch-site": "same-origin", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  };
}

test("portable modding preview resolves exact slots, returns a bounded image, caches and stays responsive", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  const calls = [];
  let submitted;
  const server = await fixture(t, async (request, response) => {
    calls.push(request.url);
    if (request.url.startsWith("/api/item-slots/")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ slots: [slotId, secondSlotId].map((id) => ({ parentTplId: weaponId, slotId: id, slotName: "mod_stock", resolvedItemTplIds: [partId] })) }));
    } else if (["/api/generate-build", "/api/generate-build-rotated"].includes(request.url)) {
      let body = "";
      for await (const chunk of request) body += chunk;
      submitted = JSON.parse(body);
      await new Promise((resolve) => setTimeout(resolve, 500));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, imageUrl: "/api/images/build_test" }));
    } else {
      response.setHeader("content-type", "image/png");
      response.end(png);
    }
  });
  const pending = server.post({ root, angle: 0 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const health = await fetch(new URL(".tarkov-helper-portable", server.baseUrl), { signal: AbortSignal.timeout(1500) });
  assert.equal(health.status, 200);
  const busy = await server.post({ root, angle: 30 });
  assert.equal(busy.status, 503);
  assert.equal((await busy.json()).error.code, "PREVIEW_BUSY");
  const response = await pending;
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.imageUrl, `data:image/png;base64,${png.toString("base64")}`);
  assert.equal(submitted.rotationX, undefined);
  assert.equal(submitted.data.rotationY, undefined);
  assert.equal(calls[1], "/api/generate-build");
  assert.match(submitted.data.id, /^[0-9a-f]{24}$/);
  assert.equal(submitted.data.id, createHash("sha256").update(`root:${weaponId}`).digest("hex").slice(0, 24));
  assert.deepEqual(submitted.data.items.map((item) => item.slotId), ["FirstPrimaryWeapon", "mod_stock"]);
  assert.equal(submitted.data.items[1].parentId, submitted.data.items[0]._id);
  assert.equal((await server.post({ root, angle: 0 })).status, 200);
  assert.equal(calls.length, 3);
  assert.equal((await server.post({ root, angle: 3 })).status, 400);
  assert.equal(calls.length, 3);
  assert.equal((await server.post({ root, angle: 30 })).status, 200);
  assert.equal(submitted.data.rotationX, 0);
  assert.equal(submitted.data.rotationY, 30);
  assert.equal(calls[3], "/api/generate-build-rotated");
  assert.equal(calls.filter((url) => url.startsWith("/api/item-slots/")).length, 1);
  assert.equal(calls.length, 5);
  const repeatedParts = { ...root, children: [...root.children, { ...root.children[0], slotId: secondSlotId, instanceId: "second" }] };
  assert.equal((await server.post({ root: repeatedParts, angle: 0 })).status, 200);
  const countBeforeReorder = calls.length;
  assert.equal((await server.post({ root: { ...repeatedParts, children: [...repeatedParts.children].reverse() }, angle: 0 })).status, 200);
  assert.equal(calls.length, countBeforeReorder);
  const otherWeapon = { ...root, itemId: "a".repeat(24), children: [] };
  assert.equal((await server.post({ root: otherWeapon, angle: 0 })).status, 200);
  assert.equal(submitted.data.id, createHash("sha256").update(`root:${otherWeapon.itemId}`).digest("hex").slice(0, 24));
});

test("portable preview rejects invalid trees and unsafe upstream responses and honors cooldown", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  let mode = "good";
  let calls = 0;
  let redirected = 0;
  const server = await fixture(t, (request, response) => {
    calls += 1;
    if (request.url === "/redirect-target") { redirected += 1; response.end(); return; }
    if (mode === "rate-limit") { response.writeHead(429, { "Retry-After": "172800" }).end(); return; }
    if (mode === "redirect") { response.writeHead(302, { location: "/redirect-target" }).end(); return; }
    if (request.url.startsWith("/api/item-slots/")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ slots: [{ parentTplId: "0".repeat(24), slotId, slotName: "mod_stock", resolvedItemTplIds: [partId] }] }));
    } else if (["/api/generate-build", "/api/generate-build-rotated"].includes(request.url)) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, imageUrl: mode === "unsafe-path" ? "https://attacker.invalid/api/images/build_bad" : "/api/images/build_test" }));
    } else if (mode === "oversized") {
      response.writeHead(200, { "content-type": "image/png", "content-length": String(6 * 1024 * 1024) }).end(png);
    } else if (mode === "wrong-mime") {
      response.writeHead(200, { "content-type": "text/html" }).end(png);
    } else if (mode === "wrong-magic") {
      response.writeHead(200, { "content-type": "image/png" }).end("not an image");
    } else if (mode === "huge-canvas") {
      const huge = Buffer.from(png);
      huge.writeUInt32BE(10000, 16);
      response.writeHead(200, { "content-type": "image/png" }).end(huge);
    } else { response.writeHead(200, { "content-type": "image/png" }).end(png); }
  });
  const invalidRoots = [
    { ...root, itemId: "../bad" },
    { ...root, children: [...root.children, { ...root.children[0], instanceId: "duplicate-slot" }] },
    { ...root, children: [{ ...root.children[0], instanceId: root.instanceId }] },
    { ...root, children: [{ ...root.children[0], slotId: "mod_stock" }] },
    { ...root, instanceId: "x".repeat(2049) },
    { ...root, extra: true },
  ];
  for (const invalid of invalidRoots) {
    const response = await server.post({ root: invalid, angle: 0 });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_BUILD");
  }
  const tooDeep = structuredClone(root);
  let current = tooDeep;
  for (let index = 0; index < 13; index += 1) {
    current.children = [{ itemId: partId, instanceId: `depth-${index}`, slotId, children: [] }];
    current = current.children[0];
  }
  assert.equal((await server.post({ root: tooDeep, angle: 0 })).status, 400);
  assert.equal((await server.post("{" + " ".repeat(65536))).status, 400);
  assert.equal((await server.post({ root, angle: 0 }, { origin: "https://attacker.invalid", "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal(calls, 0);

  const mapping = await server.post({ root, angle: 0 });
  assert.equal(mapping.status, 422);
  assert.equal((await mapping.json()).error.code, "SLOT_UNAVAILABLE");
  const leaf = { ...root, children: [] };
  for (const failure of ["redirect", "unsafe-path", "oversized", "wrong-mime", "wrong-magic", "huge-canvas"]) {
    mode = failure;
    const response = await server.post({ root: leaf, angle: 0 });
    assert.equal(response.status, 502, failure);
    assert.equal((await response.json()).error.code, "PROVIDER_RESPONSE", failure);
  }
  assert.equal(redirected, 0);
  mode = "rate-limit";
  const limited = await server.post({ root: leaf, angle: 0 });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.retryAfterSeconds, 172800);
  const callsAtCooldown = calls;
  mode = "good";
  const cooledDown = await server.post({ root: leaf, angle: 30 });
  assert.equal(cooledDown.status, 429);
  assert.equal(calls, callsAtCooldown);
});

test("portable preview times out without blocking the local server", { skip: process.platform !== "win32", timeout: 20000 }, async (t) => {
  const server = await fixture(t, () => { /* A stalled, local-only mocked provider. */ });
  const pending = server.post({ root: { ...root, children: [] }, angle: -30 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal((await fetch(new URL(".tarkov-helper-portable", server.baseUrl), { signal: AbortSignal.timeout(1500) })).status, 200);
  const response = await pending;
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, "PROVIDER_TIMEOUT");
});
