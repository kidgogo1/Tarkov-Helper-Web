import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { chromium } from "playwright";

const directReleaseRoot = process.env.TARKOV_HELPER_DIRECT_ROOT
  ? path.resolve(process.env.TARKOV_HELPER_DIRECT_ROOT)
  : null;
const appRoot = directReleaseRoot ? path.join(directReleaseRoot, "app") : path.resolve("dist");
const launcherPath = directReleaseRoot
  ? path.join(directReleaseRoot, "launcher.ps1")
  : path.resolve("portable", "launcher.ps1");
const outputDirectory = path.resolve("output", "playwright");
const storageProbeKey = "tarkov-helper-direct-e2e";
const serverStartupTimeoutMs = 30_000;
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-direct-e2e-"));
const screenshotFolder = path.join(temporaryRoot, "Escape from Tarkov", "Screenshots");
const stateDirectory = path.join(temporaryRoot, "state");
await mkdir(screenshotFolder, { recursive: true });
const canonicalScreenshotFolder = await realpath(screenshotFolder);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertMapCentered(page, label) {
  const geometry = await page.evaluate(() => {
    const viewport = globalThis.document.querySelector('[data-testid="map-viewport"]');
    const map = globalThis.document.querySelector("object.map-svg-image");
    if (!(viewport instanceof globalThis.HTMLElement) || !(map instanceof globalThis.HTMLElement)) return null;
    const viewportRect = viewport.getBoundingClientRect();
    const mapRect = map.getBoundingClientRect();
    return {
      viewportCenterX: viewportRect.left + viewportRect.width / 2,
      viewportCenterY: viewportRect.top + viewportRect.height / 2,
      mapCenterX: mapRect.left + mapRect.width / 2,
      mapCenterY: mapRect.top + mapRect.height / 2,
      mapWidth: mapRect.width,
      mapHeight: mapRect.height,
      viewportWidth: viewportRect.width,
      viewportHeight: viewportRect.height,
    };
  });
  assert(geometry, `${label}: map geometry was unavailable`);
  assert(
    Math.abs(geometry.mapCenterX - geometry.viewportCenterX) <= 2 &&
      Math.abs(geometry.mapCenterY - geometry.viewportCenterY) <= 2,
    `${label}: map is not centered: ${JSON.stringify(geometry)}`,
  );
  assert(
    geometry.mapWidth <= geometry.viewportWidth + 2 &&
      geometry.mapHeight <= geometry.viewportHeight + 2,
    `${label}: fitted map exceeds the viewport: ${JSON.stringify(geometry)}`,
  );
}

function browserExecutable() {
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ]
    : [];
  return process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? candidates.find(existsSync);
}

async function findFirstFile(directory, extensions) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFirstFile(filename, extensions);
      if (nested) return nested;
    } else if (extensions.includes(path.extname(entry.name).toLowerCase())) {
      return filename;
    }
  }
  return null;
}

function encodedAppPath(filename) {
  return path.relative(appRoot, filename).split(path.sep).map(encodeURIComponent).join("/");
}

function startServer() {
  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath,
      "-Action",
      "Serve",
      "-Root",
      appRoot,
      "-ScreenshotFolder",
      screenshotFolder,
      "-StateDirectory",
      stateDirectory,
      "-NoBrowser",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Direct server startup timed out.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, serverStartupTimeoutMs);
    const inspect = () => {
      const match = stdout.match(/TARKOV_HELPER_URL=(http:\/\/127\.0\.0\.1:41753\/)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    };
    child.stdout.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Direct server exited with code ${code}.\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });

  return { child, ready, output: () => ({ stdout, stderr }) };
}

async function stopServer(server) {
  if (server.child.exitCode !== null) return;
  server.child.kill();
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    server.child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

if (process.platform !== "win32") {
  throw new Error("The direct launcher E2E is Windows-only.");
}

let server = startServer();
let browser;

try {
  const baseUrl = await server.ready;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(server.child.exitCode === null, `Direct server did not remain running: ${JSON.stringify(server.output())}`);

  const executablePath = browserExecutable();
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const browserErrors = [];
  const failedResponses = [];
  const externalRequests = [];
  let expectedHeadlessOverlayConflictSeen = false;

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") browserErrors.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    const responseUrl = new URL(response.url());
    const isExpectedHeadlessOverlayConflict =
      response.status() === 409 && responseUrl.pathname === "/api/v1/native-overlay/minimap";
    if (isExpectedHeadlessOverlayConflict) expectedHeadlessOverlayConflictSeen = true;
    if (response.status() >= 400 && !isExpectedHeadlessOverlayConflict) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(baseUrl).origin) externalRequests.push(request.url());
  });

  const documentResponse = await page.goto(baseUrl, { waitUntil: "networkidle" });
  assert(documentResponse?.status() === 200, "Direct release document did not return HTTP 200");
  assert(documentResponse.headers()["x-frame-options"] === "DENY", "Direct release is missing frame protection");
  await page.getByText("TARKOV HELPER", { exact: true }).waitFor();
  assert(await page.getByRole("tab").count() === 6, "Expected six primary tabs");
  const levelInput = page.locator('input[aria-label="레벨"]');
  const expectedLevel = String(Number(await levelInput.inputValue()) + 1);
  await page.getByRole("button", { name: "레벨 증가" }).click();
  assert(await levelInput.inputValue() === expectedLevel, "Profile level change was not applied");

  const sampleFiles = await Promise.all([
    findFirstFile(appRoot, [".svg"]),
    findFirstFile(appRoot, [".png"]),
    findFirstFile(appRoot, [".webp"]),
  ]);
  assert(sampleFiles.every(Boolean), "The direct release is missing SVG, PNG, or WebP assets");
  const sampleResults = await page.evaluate(async (paths) => Promise.all(paths.map(async (assetPath) => {
    const response = await fetch(assetPath);
    return { path: assetPath, status: response.status, type: response.headers.get("content-type") };
  })), sampleFiles.map(encodedAppPath));
  assert(sampleResults.every((result) => result.status === 200), `Static asset failure: ${JSON.stringify(sampleResults)}`);
  assert(sampleResults[0].type?.startsWith("image/svg+xml"), `Wrong SVG MIME: ${sampleResults[0].type}`);
  assert(sampleResults[1].type === "image/png", `Wrong PNG MIME: ${sampleResults[1].type}`);
  assert(sampleResults[2].type === "image/webp", `Wrong WebP MIME: ${sampleResults[2].type}`);

  await page.getByRole("tab", { name: "시세" }).click();
  await page.getByRole("searchbox", { name: "아이템 시세 검색" }).fill("LEDX");
  await page.getByRole("button", { name: /LEDX Skin Transilluminator/ }).waitFor();

  await page.getByRole("tab", { name: /^지도$/ }).click();
  await page.locator("object.map-svg-image").waitFor();
  await page.waitForFunction(() => Boolean(globalThis.document.querySelector("object.map-svg-image")?.contentDocument?.documentElement));
  await page.locator('.map-tracker-status[data-state="watching"]').waitFor();
  assert(
    await page.locator(".map-tracker-path").textContent() === canonicalScreenshotFolder,
    "The map did not report the watched EFT screenshot folder",
  );

  await page.locator("#map-picker").selectOption("Customs");
  await page.waitForFunction(() =>
    Boolean(globalThis.document.querySelector("object.map-svg-image")?.contentDocument?.documentElement),
  );
  await assertMapCentered(page, "Direct Customs initial fit");
  const trackedScreenshotName = "2026-08-08[00-20]_100, 1, 200_0, 0.7071068, 0, 0.7071068_16.74.png";
  await writeFile(path.join(screenshotFolder, trackedScreenshotName), Buffer.alloc(0));
  await page.locator(".map-player-marker").waitFor({ timeout: 10_000 });
  const playerMarkerLabel = await page.locator(".map-player-marker").getAttribute("aria-label");
  assert(
    playerMarkerLabel?.includes("X 100") && playerMarkerLabel.includes("Y 1") && playerMarkerLabel.includes("Z 200"),
    `Automatic screenshot tracking did not update the player position: ${playerMarkerLabel}`,
  );

  await mkdir(outputDirectory, { recursive: true });
  const miniMapPagePromise = context.waitForEvent("page", { timeout: 5_000 }).catch(() => null);
  await page.locator("button.map-minimap-toggle").click();
  const miniMapPage = await miniMapPagePromise;
  if (miniMapPage) {
    try {
      await miniMapPage.locator('[data-testid="map-minimap-player"]').waitFor();
      await miniMapPage.locator("object.map-minimap-map").waitFor();
      await miniMapPage.locator(".map-minimap").screenshot({
        path: path.join(outputDirectory, "direct-minimap.png"),
      });
    } catch (error) {
      if (!miniMapPage.isClosed()) throw error;
      await page.locator('[data-testid="map-minimap-fallback"]').waitFor();
      await page.locator('[data-testid="map-minimap-player"]').waitFor();
      await page.locator('[data-testid="map-minimap-fallback"] object.map-minimap-map').waitFor();
    }
  } else {
    await page.locator('[data-testid="map-minimap-fallback"]').waitFor();
    await page.locator('[data-testid="map-minimap-player"]').waitFor();
    await page.locator('[data-testid="map-minimap-fallback"] object.map-minimap-map').waitFor();
  }
  await page.screenshot({ path: path.join(outputDirectory, "direct-release-1440.png"), fullPage: true });

  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [storageProbeKey, "persisted"]);
  await page.goto("about:blank");
  await stopServer(server);
  server = startServer();
  const restartedUrl = await server.ready;
  assert(restartedUrl === baseUrl, `Direct release origin changed: ${baseUrl} -> ${restartedUrl}`);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  assert(await page.evaluate((key) => localStorage.getItem(key), storageProbeKey) === "persisted", "Local storage did not survive server restart");
  assert(await levelInput.inputValue() === expectedLevel, "App progress did not survive direct server restart");
  await page.evaluate((key) => localStorage.removeItem(key), storageProbeKey);

  assert(failedResponses.length === 0, `HTTP failures:\n${failedResponses.join("\n")}`);
  assert(externalRequests.length === 0, `Unexpected external requests:\n${externalRequests.join("\n")}`);
  const unexpectedBrowserErrors = browserErrors.filter((error) => !(
    expectedHeadlessOverlayConflictSeen &&
    error === "error: Failed to load resource: the server responded with a status of 409 (Conflict)"
  ));
  assert(unexpectedBrowserErrors.length === 0, `Browser console errors:\n${unexpectedBrowserErrors.join("\n")}`);
  await context.close();
  process.stdout.write(`Direct release browser flow passed: ${baseUrl}\n`);
} finally {
  if (browser) await browser.close();
  await stopServer(server);
  await rm(temporaryRoot, { recursive: true, force: true });
}
