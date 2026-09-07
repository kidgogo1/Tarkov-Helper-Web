import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
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

async function postHeadersOnly(baseUrl, requestPath, contentLength, headers = {}) {
  const target = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: target.hostname, port: Number(target.port) });
    let response = "";
    // Stay below the launcher's ~5s read timeout: a delayed body-read error is not early rejection.
    const timeout = setTimeout(() => socket.destroy(new Error(`${requestPath} did not reject the request before reading the body`)), 2000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("error", reject);
    socket.once("close", () => { clearTimeout(timeout); resolve(response); });
    socket.once("connect", () => socket.write([
      `POST ${requestPath} HTTP/1.1`,
      `Host: ${target.host}`,
      `Origin: ${headers.origin ?? target.origin}`,
      `Sec-Fetch-Site: ${headers["sec-fetch-site"] ?? "same-origin"}`,
      "Content-Type: application/json",
      `Content-Length: ${contentLength}`,
      "Connection: close", "", "",
    ].join("\r\n")));
  });
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
  for (const angle of [-180, -90, -15, 15, 90, 180]) {
    assert.equal((await server.post({ root, angle })).status, 200, `angle ${angle}`);
    assert.equal(submitted.data.rotationX, 0);
    assert.equal(submitted.data.rotationY, angle);
    assert.equal(calls.at(-2), "/api/generate-build-rotated");
  }
  const countAfterAngles = calls.length;
  for (const angle of [-180, 90, 180]) assert.equal((await server.post({ root, angle })).status, 200);
  assert.equal((await server.post(JSON.stringify({ root, angle: 90 }).replace('"angle":90', '"angle":90.0'))).status, 200);
  assert.equal(calls.length, countAfterAngles, 'viewing-angle cache includes extended numeric angles');
  const repeatedParts = { ...root, children: [...root.children, { ...root.children[0], slotId: secondSlotId, instanceId: "second" }] };
  assert.equal((await server.post({ root: repeatedParts, angle: 0 })).status, 200);
  const countBeforeReorder = calls.length;
  assert.equal((await server.post({ root: { ...repeatedParts, children: [...repeatedParts.children].reverse() }, angle: 0 })).status, 200);
  assert.equal(calls.length, countBeforeReorder);
  const otherWeapon = { ...root, itemId: "a".repeat(24), children: [] };
  assert.equal((await server.post({ root: otherWeapon, angle: 0 })).status, 200);
  assert.equal(submitted.data.id, createHash("sha256").update(`root:${otherWeapon.itemId}`).digest("hex").slice(0, 24));
});

for (const bodyBytes of [8193, 65536]) {
  test(`portable preview accepts a valid ${bodyBytes}-byte JSON body within its 64 KiB limit`, { skip: process.platform !== "win32", timeout: 15000 }, async (t) => {
    const server = await fixture(t, async (request, response) => {
      let uploadedBytes = 0;
      for await (const chunk of request) uploadedBytes += chunk.length;
      assert.equal(uploadedBytes, Number(request.headers["content-length"] ?? 0));
      if (request.url === "/api/generate-build") {
        response.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: true, imageUrl: "/api/images/build_test" }));
      } else {
        response.writeHead(200, { "content-type": "image/png" }).end(png);
      }
    });
    const body = JSON.stringify({ root: { ...root, children: [] }, angle: 0 }).padEnd(bodyBytes, " ");
    assert.equal(Buffer.byteLength(body), bodyBytes);
    const response = await server.post(body);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).imageUrl, `data:image/png;base64,${png.toString("base64")}`);
  });
}

for (const failureAt of ["declared length", "streamed length"]) {
  test(`portable preview preserves ${failureAt} rejection when cleanup throws`, { skip: process.platform !== "win32" }, async () => {
    const launcher = await readFile(launcherPath, "utf8");
    const start = launcher.indexOf("function Invoke-ModdingPreviewHttp {");
    const end = launcher.indexOf("function Read-ModdingPreviewJson {", start);
    assert.ok(start >= 0 && end > start);
    // Keep the real validation/cleanup body; replace only its concrete HTTP dependency.
    const invoke = launcher.slice(start, end)
      .replace("[Net.HttpWebRequest]::Create($uri)", "$script:fakeRequest")
      .replace("[Net.HttpWebResponse]$request.GetResponse()", "$request.GetResponse()");
    const script = `
$ErrorActionPreference = 'Stop'
$script:cleanup = [Collections.Generic.List[string]]::new()
$script:fakeStream = [pscustomobject]@{ ReadTimeout = 0 }
$script:fakeStream | Add-Member ScriptMethod Read { return 5 }
$script:fakeStream | Add-Member ScriptMethod Dispose { $script:cleanup.Add('stream'); throw [IO.IOException]::new('fixture stream cleanup failed') }
$script:fakeResponse = [pscustomobject]@{ StatusCode = 200; ResponseUri = [Uri]'http://127.0.0.1/api/images/build_test'; ContentLength = ${failureAt === "declared length" ? 5 : -1} }
$script:fakeResponse | Add-Member ScriptMethod GetResponseStream { return $script:fakeStream }
$script:fakeResponse | Add-Member ScriptMethod Dispose { $script:cleanup.Add('response'); throw [IO.IOException]::new('fixture response cleanup failed') }
$script:fakeRequest = [pscustomobject]@{ AllowAutoRedirect = $false; Timeout = 0; ReadWriteTimeout = 0; UserAgent = ''; Accept = '' }
$script:fakeRequest | Add-Member ScriptMethod GetResponse { return $script:fakeResponse }
$script:fakeRequest | Add-Member ScriptMethod Abort { $script:cleanup.Add('abort'); throw [IO.IOException]::new('fixture request cleanup failed') }
${invoke}
$caught = $null
try { Invoke-ModdingPreviewHttp -BaseUrl 'http://127.0.0.1' -Path '/api/images/build_test' -MaximumBytes 4 -Clock ([Diagnostics.Stopwatch]::StartNew()) }
catch { $caught = $_.Exception }
if ($null -eq $caught -or $caught -isnot [IO.InvalidDataException]) { throw "Expected original size rejection, got $($caught.GetType().Name): $($caught.Message)" }
if (($script:cleanup -join ',') -cne '${failureAt === "declared length" ? "response,abort" : "stream,response,abort"}') { throw "Cleanup was skipped: $($script:cleanup -join ',')" }
`;
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      windowsHide: true, encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}

test("portable preview rejects invalid trees and unsafe upstream responses and honors cooldown", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  let mode = "good";
  let calls = 0;
  let redirected = 0;
  const server = await fixture(t, async (request, response) => {
    calls += 1;
    // Exercise response validation after a complete upload, independently of the
    // Expect: 100-continue/early-response transport race in .NET Framework.
    let uploadedBytes = 0;
    for await (const chunk of request) uploadedBytes += chunk.length;
    assert.equal(uploadedBytes, Number(request.headers["content-length"] ?? 0));
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
      // Valid HTTP framing isolates the size limit from truncated-response cleanup errors.
      const oversized = Buffer.alloc(6 * 1024 * 1024);
      png.copy(oversized);
      response.writeHead(200, { "content-type": "image/png", "content-length": String(oversized.length) }).end(oversized);
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
  for (const angle of [-195, 195, -181, 181, -1, 1, 5, 14, 16, 30.5, '90', null, undefined, true, [], {}]) {
    const response = await server.post({ root, angle });
    assert.equal(response.status, 400, `invalid angle ${JSON.stringify(angle)}`);
    assert.equal((await response.json()).error.code, "INVALID_BUILD");
  }
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
  // Verify header-time rejection without an unread upload triggering the TCP reset
  // described in RFC 9112 section 9.6. No body is sent, so waiting to read it fails.
  const oversized = await postHeadersOnly(server.baseUrl, "/api/modding/preview", 65537);
  assert.match(oversized, /^HTTP\/1\.1 400 Bad Request\r\n/);
  assert.equal(JSON.parse(oversized.split("\r\n\r\n")[1]).error.code, "INVALID_BUILD");
  const defaultLimit = await postHeadersOnly(server.baseUrl, "/api/v1/client/heartbeat", 8193);
  assert.match(defaultLimit, /^HTTP\/1\.1 400 Bad Request\r\n/);
  assert.equal(JSON.parse(defaultLimit.split("\r\n\r\n")[1]).error.code, "INVALID_JSON");
  // Authentication also rejects before reading the body; require a real HTTP
  // rejection without sending an unread upload that can reset the TCP socket.
  const crossOrigin = await postHeadersOnly(server.baseUrl, "/api/modding/preview", 2, { origin: "https://attacker.invalid", "sec-fetch-site": "cross-site" });
  assert.match(crossOrigin, /^HTTP\/1\.1 403 Forbidden\r\n/);
  assert.equal(JSON.parse(crossOrigin.split("\r\n\r\n")[1]).error.code, "FORBIDDEN");
  assert.equal(calls, 0);

  const mapping = await server.post({ root, angle: 0 });
  assert.equal(mapping.status, 422);
  assert.equal((await mapping.json()).error.code, "SLOT_UNAVAILABLE");
  const leaf = { ...root, children: [] };
  for (const failure of ["redirect", "unsafe-path", "oversized", "wrong-mime", "wrong-magic", "huge-canvas"]) {
    mode = failure;
    const response = await server.post({ root: leaf, angle: 0 });
    assert.equal(response.status, 502, failure);
    const result = await response.json();
    assert.equal(result.error.code, "PROVIDER_RESPONSE", `${failure}: ${JSON.stringify(result)}`);
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
