import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const launcherPath = path.join(projectRoot, "portable", "launcher.ps1");

function startServer({ appRoot, screenshotFolder, stateDirectory }) {
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
      "-Port",
      "0",
      "-NoBrowser",
      "-ScreenshotFolder",
      screenshotFolder,
      "-StateDirectory",
      stateDirectory,
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
      reject(new Error(`Tracker server startup timed out.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 10_000);
    const inspect = () => {
      const match = stdout.match(/TARKOV_HELPER_URL=(http:\/\/127\.0\.0\.1:\d+\/)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    };
    child.stdout.on("data", inspect);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Tracker server exited with ${code}.\nstdout: ${stdout}\nstderr: ${stderr}`));
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

async function waitForEvents(baseUrl, afterCursor, expectedCount, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(new URL(`api/v1/local-tracker/events?afterCursor=${afterCursor}&pageSize=100`, baseUrl));
    assert.equal(response.status, 200);
    const payload = await response.json();
    if (payload.data.length >= expectedCount) return payload;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${expectedCount} tracker events.`);
}

async function waitForCursor(baseUrl, expectedCursor, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(new URL("api/v1/local-tracker/status", baseUrl));
    assert.equal(response.status, 200);
    const payload = await response.json();
    if (payload.latestCursor >= expectedCursor) return payload.latestCursor;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for tracker cursor ${expectedCursor}.`);
}

async function waitForWatcherState(baseUrl, expectedState, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(new URL("api/v1/local-tracker/status", baseUrl));
    assert.equal(response.status, 200);
    const payload = await response.json();
    if (payload.screenshotWatcher.state === expectedState) return payload;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for screenshot watcher state ${expectedState}.`);
}

test("local tracker reports watcher state and emits debounced filename-only events", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-tracker-"));
  const appRoot = path.join(temporaryRoot, "app");
  const screenshotFolder = path.join(temporaryRoot, "Screenshots");
  const stateDirectory = path.join(temporaryRoot, "state");
  await mkdir(appRoot);
  await mkdir(screenshotFolder);
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Tracker test</title>", "utf8");
  const canonicalScreenshotFolder = await realpath(screenshotFolder);

  const server = startServer({ appRoot, screenshotFolder, stateDirectory });
  t.after(async () => {
    await stopServer(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const baseUrl = await server.ready;

  const statusResponse = await fetch(new URL("api/v1/local-tracker/status", baseUrl));
  assert.equal(statusResponse.status, 200);
  assert.equal(statusResponse.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(await statusResponse.json(), {
    protocolVersion: 1,
    screenshotWatcher: { state: "WATCHING", folderPath: canonicalScreenshotFolder },
    latestCursor: 0,
  });

  const screenshotName = "2026-08-07[12-34]_1.0, 2.0, 3.0_0.0, 0.0, 0.0, 1.0_test.png";
  const screenshotPath = path.join(screenshotFolder, screenshotName);
  await writeFile(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
  await writeFile(path.join(screenshotFolder, "ignored.txt"), "not a screenshot", "utf8");

  const events = await waitForEvents(baseUrl, 0, 1);
  assert.equal(events.protocolVersion, 1);
  assert.deepEqual(events.data, [{
    type: "SCREENSHOT_CREATED",
    sequence: 1,
    fileName: screenshotName,
    detectedAt: events.data[0].detectedAt,
  }]);
  assert.match(events.data[0].detectedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(JSON.stringify(events).includes(screenshotFolder), false);
  assert.deepEqual(events.pagination, {
    afterCursor: 0,
    nextCursor: 1,
    hasMore: false,
    isResetRequired: false,
  });

  const renamedScreenshotName = "renamed-into-screenshot-folder.png";
  const temporaryScreenshotPath = path.join(screenshotFolder, "capture-in-progress.tmp");
  await writeFile(temporaryScreenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await rename(temporaryScreenshotPath, path.join(screenshotFolder, renamedScreenshotName));
  const renamedEvents = await waitForEvents(baseUrl, 1, 1, 12_000);
  assert.equal(renamedEvents.data[0].fileName, renamedScreenshotName);

  const invalidCursor = await fetch(new URL("api/v1/local-tracker/events?afterCursor=-1&pageSize=10", baseUrl));
  assert.equal(invalidCursor.status, 400);

  const instance = JSON.parse(await readFile(path.join(stateDirectory, "instance.json"), "utf8"));
  const unauthenticatedShutdown = await fetch(new URL("api/v1/control/shutdown", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthenticatedShutdown.status, 403);
  assert.equal(unauthenticatedShutdown.headers.get("access-control-allow-origin"), null);
  const crossOriginShutdown = await fetch(new URL("api/v1/control/shutdown", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://attacker.invalid",
      "x-tarkov-control": instance.controlToken,
    },
    body: "{}",
  });
  assert.equal(crossOriginShutdown.status, 403);

  await Promise.all(Array.from({ length: 105 }, (_, index) =>
    writeFile(path.join(screenshotFolder, `cursor-${String(index).padStart(3, "0")}.png`), Buffer.from([index])),
  ));
  const latestCursor = await waitForCursor(baseUrl, 101);
  const expiredResponse = await fetch(new URL("api/v1/local-tracker/events?afterCursor=0&pageSize=10", baseUrl));
  assert.equal(expiredResponse.status, 200);
  const expired = await expiredResponse.json();
  assert.equal(expired.data.length, 10);
  assert.equal(expired.pagination.afterCursor, 0);
  assert.equal(expired.pagination.isResetRequired, true);
  assert.equal(expired.pagination.hasMore, true);
  assert.equal(expired.pagination.nextCursor, expired.data.at(-1).sequence);
  assert.equal(expired.data[0].sequence > 1, true);

  const futureCursor = await fetch(new URL(`api/v1/local-tracker/events?afterCursor=${latestCursor + 1}&pageSize=10`, baseUrl));
  assert.equal(futureCursor.status, 400);
  const oversizedPage = await fetch(new URL("api/v1/local-tracker/events?afterCursor=0&pageSize=101", baseUrl));
  assert.equal(oversizedPage.status, 400);
});

test("local tracker starts watching when a missing configured folder appears", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-tracker-missing-"));
  const appRoot = path.join(temporaryRoot, "app");
  const screenshotFolder = path.join(temporaryRoot, "missing");
  const stateDirectory = path.join(temporaryRoot, "state");
  await mkdir(appRoot);
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Tracker test</title>", "utf8");

  const server = startServer({
    appRoot,
    screenshotFolder,
    stateDirectory,
  });
  t.after(async () => {
    await stopServer(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const baseUrl = await server.ready;

  const response = await fetch(new URL("api/v1/local-tracker/status", baseUrl));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    protocolVersion: 1,
    screenshotWatcher: { state: "NOT_FOUND" },
    latestCursor: 0,
  });

  await mkdir(screenshotFolder);
  const canonicalScreenshotFolder = await realpath(screenshotFolder);
  const screenshotName = "folder-created-before-watcher-reattaches.png";
  await writeFile(path.join(screenshotFolder, screenshotName), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const watching = await waitForWatcherState(baseUrl, "WATCHING");
  assert.deepEqual(watching, {
    protocolVersion: 1,
    screenshotWatcher: { state: "WATCHING", folderPath: canonicalScreenshotFolder },
    latestCursor: 0,
  });

  const events = await waitForEvents(baseUrl, 0, 1);
  assert.equal(events.data[0].fileName, screenshotName);
});
