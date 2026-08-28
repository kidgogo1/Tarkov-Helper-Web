import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const launcherPath = path.join(projectRoot, "portable", "launcher.ps1");

function localParts(date) {
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, "0"),
    day: String(date.getDate()).padStart(2, "0"),
    hour: String(date.getHours()).padStart(2, "0"),
    minute: String(date.getMinutes()).padStart(2, "0"),
    second: String(date.getSeconds()).padStart(2, "0"),
  };
}

function logTimestamp(date) {
  const value = localParts(date);
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}.000`;
}

function screenshotPrefix(date) {
  const value = localParts(date);
  return `${value.year}-${value.month}-${value.day}[${value.hour}-${value.minute}]`;
}

let nextTestPort = 46000 + (process.pid % 1000);

function startServer({ appRoot, screenshotFolder, stateDirectory, gameLogRoot }) {
  const port = nextTestPort;
  nextTestPort += 1;
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
      String(port),
      "-NoBrowser",
      "-ScreenshotFolder",
      screenshotFolder,
      "-StateDirectory",
      stateDirectory,
    ],
    {
      env: {
        ...process.env,
        ...(gameLogRoot
          ? {
              TARKOV_HELPER_TRACKER_TEST_MODE: "1",
              TARKOV_HELPER_TRACKER_TEST_LOG_ROOT: gameLogRoot,
            }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
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

test("local tracker becomes ready without synchronously scanning a huge EFT log", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-tracker-startup-"));
  const appRoot = path.join(temporaryRoot, "app");
  const screenshotFolder = path.join(temporaryRoot, "Screenshots");
  const gameLogRoot = path.join(temporaryRoot, "GameLogs");
  const gameLogSession = path.join(gameLogRoot, "log_huge_test");
  const applicationLog = path.join(gameLogSession, "huge application_000.log");
  const stateDirectory = path.join(temporaryRoot, "state");
  await mkdir(appRoot);
  await mkdir(screenshotFolder);
  await mkdir(gameLogSession, { recursive: true });
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Tracker test</title>", "utf8");
  const hugeObservationAt = new Date();
  hugeObservationAt.setMilliseconds(0);
  const handle = await open(applicationLog, "w");
  try {
    await handle.write(
      `${logTimestamp(hugeObservationAt)}|test|Debug|application|TRACE-NetworkGameCreate Location: woods_preset, Sid: huge\n`,
    );
    await handle.truncate(1024 * 1024 * 1024);
  } finally {
    await handle.close();
  }

  const startedAt = Date.now();
  const server = startServer({ appRoot, screenshotFolder, stateDirectory, gameLogRoot });
  t.after(async () => {
    await stopServer(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const baseUrl = await server.ready;
  assert.ok(Date.now() - startedAt < 8_000, "tracker startup waited for the entire EFT log scan");
  const response = await fetch(new URL("api/v1/local-tracker/status", baseUrl));
  assert.equal(response.status, 200);
  const screenshotAt = new Date();
  screenshotAt.setMilliseconds(0);
  const screenshotName = `${screenshotPrefix(screenshotAt)}_1.0, 2.0, 3.0_0.0, 0.0, 0.0, 1.0_bootstrap.png`;
  const screenshotPath = path.join(screenshotFolder, screenshotName);
  await writeFile(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await utimes(screenshotPath, screenshotAt, screenshotAt);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const eventsResponse = await fetch(new URL("api/v1/local-tracker/events?afterCursor=0&pageSize=100", baseUrl));
  assert.equal(eventsResponse.status, 200);
  const events = await eventsResponse.json();
  assert.equal(events.data.length, 0);
});

test("local tracker falls back to a mapless event when EFT logs remain unavailable", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-tracker-mapless-"));
  const appRoot = path.join(temporaryRoot, "app");
  const screenshotFolder = path.join(temporaryRoot, "Screenshots");
  const gameLogRoot = path.join(temporaryRoot, "EmptyGameLogs");
  const stateDirectory = path.join(temporaryRoot, "state");
  await mkdir(appRoot);
  await mkdir(screenshotFolder);
  await mkdir(gameLogRoot);
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Tracker test</title>", "utf8");

  const server = startServer({ appRoot, screenshotFolder, stateDirectory, gameLogRoot });
  t.after(async () => {
    await stopServer(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const baseUrl = await server.ready;
  const screenshotAt = new Date();
  screenshotAt.setMilliseconds(0);
  const screenshotName = `${screenshotPrefix(screenshotAt)}_4.0, 5.0, 6.0_0.0, 0.0, 0.0, 1.0_mapless.png`;
  const screenshotPath = path.join(screenshotFolder, screenshotName);
  await writeFile(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await utimes(screenshotPath, screenshotAt, screenshotAt);
  const events = await waitForEvents(baseUrl, 0, 1, 20_000);
  assert.equal(events.data[0].fileName, screenshotName);
  assert.equal(Object.hasOwn(events.data[0], "mapKey"), false);
});

test("local tracker invalidates cached map state when a longer log replaces the same path", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-tracker-rewrite-"));
  const appRoot = path.join(temporaryRoot, "app");
  const screenshotFolder = path.join(temporaryRoot, "Screenshots");
  const gameLogRoot = path.join(temporaryRoot, "GameLogs");
  const gameLogSession = path.join(gameLogRoot, "log_rewrite_test");
  const applicationLog = path.join(gameLogSession, "rewrite application_000.log");
  const stateDirectory = path.join(temporaryRoot, "state");
  await mkdir(appRoot);
  await mkdir(screenshotFolder);
  await mkdir(gameLogSession, { recursive: true });
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Tracker test</title>", "utf8");
  const commonPrefix = `${"x".repeat(600)}\n`;
  const firstScreenshotAt = new Date();
  firstScreenshotAt.setMilliseconds(0);
  await writeFile(
    applicationLog,
    `${commonPrefix}${logTimestamp(new Date(firstScreenshotAt.getTime() - 30_000))}|test|Debug|application|TRACE-NetworkGameCreate Location: customs_preset, Sid: first\n`,
    "utf8",
  );

  const server = startServer({ appRoot, screenshotFolder, stateDirectory, gameLogRoot });
  t.after(async () => {
    await stopServer(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const baseUrl = await server.ready;
  const firstName = `${screenshotPrefix(firstScreenshotAt)}_11.0, 12.0, 13.0_0.0, 0.0, 0.0, 1.0_first.png`;
  const firstPath = path.join(screenshotFolder, firstName);
  await writeFile(firstPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await utimes(firstPath, firstScreenshotAt, firstScreenshotAt);
  const firstEvents = await waitForEvents(baseUrl, 0, 1);
  assert.equal(firstEvents.data[0].mapKey, "Customs");

  const secondScreenshotAt = new Date(firstScreenshotAt.getTime() + 60_000);
  await writeFile(
    applicationLog,
    `${commonPrefix}${logTimestamp(new Date(secondScreenshotAt.getTime() - 30_000))}|test|Debug|application|TRACE-NetworkGameCreate Location: woods_preset, Sid: replacement\n${"tail".repeat(200)}\n`,
    "utf8",
  );
  const secondName = `${screenshotPrefix(secondScreenshotAt)}_21.0, 22.0, 23.0_0.0, 0.0, 0.0, 1.0_second.png`;
  const secondPath = path.join(screenshotFolder, secondName);
  await writeFile(secondPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await utimes(secondPath, secondScreenshotAt, secondScreenshotAt);
  const secondEvents = await waitForEvents(baseUrl, 1, 1);
  assert.equal(secondEvents.data[0].mapKey, "Woods");
});

test("local tracker emits a canonical map identity only from a fresh EFT log observation", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-tracker-"));
  const appRoot = path.join(temporaryRoot, "app");
  const screenshotFolder = path.join(temporaryRoot, "Screenshots");
  const gameLogRoot = path.join(temporaryRoot, "GameLogs");
  const now = new Date();
  now.setMilliseconds(0);
  const initialObservationAt = new Date(now.getTime() - 4 * 60_000);
  const gameLogSession = path.join(gameLogRoot, "log_current_test");
  const applicationLog = path.join(gameLogSession, "current application_000.log");
  const stateDirectory = path.join(temporaryRoot, "state");
  await mkdir(appRoot);
  await mkdir(screenshotFolder);
  await mkdir(gameLogSession, { recursive: true });
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Tracker test</title>", "utf8");
  await writeFile(
    applicationLog,
    `${logTimestamp(initialObservationAt)}|test|Debug|application|TRACE-NetworkGameCreate Location: bigmap_preset, Sid: test\n`,
    "utf8",
  );
  const canonicalScreenshotFolder = await realpath(screenshotFolder);

  const server = startServer({ appRoot, screenshotFolder, stateDirectory, gameLogRoot });
  t.after(async () => {
    await stopServer(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const baseUrl = await server.ready;
  const screenshotAt = new Date();
  screenshotAt.setMilliseconds(0);

  const statusResponse = await fetch(new URL("api/v1/local-tracker/status", baseUrl));
  assert.equal(statusResponse.status, 200);
  assert.equal(statusResponse.headers.get("access-control-allow-origin"), null);
  const initialStatus = await statusResponse.json();
  assert.match(initialStatus.instanceId, /^[a-f0-9]{32}$/);
  assert.deepEqual(initialStatus, {
    protocolVersion: 1,
    instanceId: initialStatus.instanceId,
    screenshotWatcher: { state: "WATCHING", folderPath: canonicalScreenshotFolder },
    latestCursor: 0,
  });

  const screenshotName = `${screenshotPrefix(screenshotAt)}_1.0, 2.0, 3.0_0.0, 0.0, 0.0, 1.0_test.png`;
  const screenshotPath = path.join(screenshotFolder, screenshotName);
  await writeFile(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
  await utimes(screenshotPath, screenshotAt, screenshotAt);
  await writeFile(path.join(screenshotFolder, "ignored.txt"), "not a screenshot", "utf8");

  const events = await waitForEvents(baseUrl, 0, 1);
  assert.equal(events.protocolVersion, 1);
  assert.equal(events.instanceId, initialStatus.instanceId);
  assert.deepEqual(events.data, [{
    type: "SCREENSHOT_CREATED",
    sequence: 1,
    fileName: screenshotName,
    detectedAt: events.data[0].detectedAt,
    mapKey: "Customs",
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
  assert.equal(Object.hasOwn(renamedEvents.data[0], "mapKey"), false);

  const staleAt = new Date(screenshotAt.getTime() + 2 * 60 * 60_000);
  const staleScreenshotName = `${screenshotPrefix(staleAt)}_4.0, 5.0, 6.0_0.0, 0.0, 0.0, 1.0_test.png`;
  await writeFile(
    path.join(screenshotFolder, staleScreenshotName),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );
  await utimes(
    path.join(screenshotFolder, staleScreenshotName),
    staleAt,
    staleAt,
  );
  const staleEvents = await waitForEvents(baseUrl, 2, 1, 12_000);
  assert.equal(staleEvents.data[0].fileName, staleScreenshotName);
  assert.equal(Object.hasOwn(staleEvents.data[0], "mapKey"), false);

  await writeFile(
    applicationLog,
    [
      `${logTimestamp(new Date(screenshotAt.getTime() - 4 * 60_000))}|test|Debug|application|TRACE-NetworkGameCreate Location: customs_preset, Sid: old`,
      `${logTimestamp(new Date(screenshotAt.getTime() - 60_000))}|test|Debug|application|TRACE-NetworkGameCreate Location: brand_new_map, Sid: current`,
      "",
    ].join("\n"),
    "utf8",
  );
  const unknownMapScreenshotName = `${screenshotPrefix(screenshotAt)}_7.0, 8.0, 9.0_0.0, 0.0, 0.0, 1.0_test.png`;
  await writeFile(
    path.join(screenshotFolder, unknownMapScreenshotName),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );
  await utimes(
    path.join(screenshotFolder, unknownMapScreenshotName),
    screenshotAt,
    screenshotAt,
  );
  const unknownMapEvents = await waitForEvents(baseUrl, 3, 1, 12_000);
  assert.equal(unknownMapEvents.data[0].fileName, unknownMapScreenshotName);
  assert.equal(Object.hasOwn(unknownMapEvents.data[0], "mapKey"), false);

  const preciseMinute = new Date(screenshotAt);
  preciseMinute.setMinutes(preciseMinute.getMinutes() + 2, 0, 0);
  await writeFile(
    applicationLog,
    [
      `${logTimestamp(new Date(preciseMinute.getTime() + 5_000))}|test|Debug|application|TRACE-NetworkGameCreate Location: customs_preset, Sid: current`,
      `${logTimestamp(new Date(preciseMinute.getTime() + 50_000))}|test|Debug|application|TRACE-NetworkGameCreate Location: woods_preset, Sid: later`,
      "",
    ].join("\n"),
    "utf8",
  );
  const preciseAt = new Date(preciseMinute.getTime() + 20_000);
  const preciseScreenshotName = `${screenshotPrefix(preciseAt)}_10.0, 11.0, 12.0_0.0, 0.0, 0.0, 1.0_test.png`;
  const preciseScreenshotPath = path.join(screenshotFolder, preciseScreenshotName);
  await writeFile(preciseScreenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await utimes(
    preciseScreenshotPath,
    preciseAt,
    preciseAt,
  );
  const preciseEvents = await waitForEvents(baseUrl, 4, 1, 12_000);
  assert.equal(preciseEvents.data[0].fileName, preciseScreenshotName);
  assert.equal(preciseEvents.data[0].mapKey, "Customs");

  const endedAt = new Date(preciseMinute.getTime() + 3 * 60_000);
  await writeFile(
    applicationLog,
    [
      `${logTimestamp(new Date(endedAt.getTime() - 60_000))}|test|Debug|application|TRACE-NetworkGameCreate Location: customs_preset, Sid: ended`,
      `${logTimestamp(new Date(endedAt.getTime() - 30_000))}|0.15.0|Debug|application|PrepareSelectedProfileLocally: profile returned to menu`,
      "",
    ].join("\n"),
    "utf8",
  );
  const endedScreenshotName = `${screenshotPrefix(endedAt)}_13.0, 14.0, 15.0_0.0, 0.0, 0.0, 1.0_test.png`;
  const endedScreenshotPath = path.join(screenshotFolder, endedScreenshotName);
  await writeFile(endedScreenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await utimes(endedScreenshotPath, endedAt, endedAt);
  const endedEvents = await waitForEvents(baseUrl, 5, 1, 12_000);
  assert.equal(endedEvents.data[0].fileName, endedScreenshotName);
  assert.equal(Object.hasOwn(endedEvents.data[0], "mapKey"), false);

  const newerSession = path.join(gameLogRoot, "log_newer_without_map");
  await mkdir(newerSession);
  await writeFile(
    path.join(newerSession, "newer application_000.log"),
    `${logTimestamp(new Date(endedAt.getTime() + 30_000))}|test|Debug|application|menu heartbeat\n`,
    "utf8",
  );
  const noMapAt = new Date(endedAt.getTime() + 60_000);
  const noMapScreenshotName = `${screenshotPrefix(noMapAt)}_16.0, 17.0, 18.0_0.0, 0.0, 0.0, 1.0_test.png`;
  const noMapScreenshotPath = path.join(screenshotFolder, noMapScreenshotName);
  await writeFile(noMapScreenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await utimes(noMapScreenshotPath, noMapAt, noMapAt);
  const noMapEvents = await waitForEvents(baseUrl, 6, 1, 12_000);
  assert.equal(noMapEvents.data[0].fileName, noMapScreenshotName);
  assert.equal(Object.hasOwn(noMapEvents.data[0], "mapKey"), false);

  const longRaidSession = path.join(gameLogRoot, "log_long_raid");
  const longRaidAt = new Date(noMapAt.getTime() + 60_000);
  await mkdir(longRaidSession);
  const rotatedLogs = [];
  for (let index = 0; index < 9; index += 1) {
    const rotatedLog = path.join(
      longRaidSession,
      `long application_${String(index).padStart(3, "0")}.log`,
    );
    rotatedLogs.push(rotatedLog);
    await writeFile(
      rotatedLog,
      index === 0
        ? [
            `${logTimestamp(new Date(longRaidAt.getTime() - 60_000))}|test|Debug|application|TRACE-NetworkGameCreate Location: woods_preset, Sid: long`,
            "x".repeat(5 * 1024 * 1024),
            "",
          ].join("\n")
        : `${logTimestamp(new Date(longRaidAt.getTime() - (8 - index) * 1000))}|test|Debug|application|heartbeat ${index}\n`,
      "utf8",
    );
  }
  const longRaidScreenshotName = `${screenshotPrefix(longRaidAt)}_19.0, 20.0, 21.0_0.0, 0.0, 0.0, 1.0_test.png`;
  const longRaidScreenshotPath = path.join(screenshotFolder, longRaidScreenshotName);
  await writeFile(longRaidScreenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await utimes(longRaidScreenshotPath, longRaidAt, longRaidAt);
  const longRaidEvents = await waitForEvents(baseUrl, 7, 1, 12_000);
  assert.equal(longRaidEvents.data[0].fileName, longRaidScreenshotName);
  assert.equal(longRaidEvents.data[0].mapKey, "Woods");

  await writeFile(rotatedLogs.at(-1), `${logTimestamp(longRaidAt)}|test|Debug|application|heartbeat\n`, {
    encoding: "utf8",
    flag: "a",
  });
  const continuedAt = new Date(longRaidAt.getTime() + 60_000);
  const continuedScreenshotName = `${screenshotPrefix(continuedAt)}_22.0, 23.0, 24.0_0.0, 0.0, 0.0, 1.0_test.png`;
  const continuedScreenshotPath = path.join(screenshotFolder, continuedScreenshotName);
  await writeFile(continuedScreenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await utimes(continuedScreenshotPath, continuedAt, continuedAt);
  const continuedEvents = await waitForEvents(baseUrl, 8, 1, 12_000);
  assert.equal(continuedEvents.data[0].mapKey, "Woods");

  await writeFile(
    rotatedLogs.at(-1),
    `${logTimestamp(new Date(continuedAt.getTime() + 15_000))}|0.15.0|Debug|application|PrepareSelectedProfi`,
    { encoding: "utf8", flag: "a" },
  );
  const partialAt = new Date(continuedAt.getTime() + 20_000);
  const partialName = `${screenshotPrefix(partialAt)}_23.5, 24.5, 25.5_0.0, 0.0, 0.0, 1.0_partial.png`;
  const partialPath = path.join(screenshotFolder, partialName);
  await writeFile(partialPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await utimes(partialPath, partialAt, partialAt);
  const partialEvents = await waitForEvents(baseUrl, 9, 1, 12_000);
  assert.equal(partialEvents.data[0].mapKey, "Woods");
  await writeFile(rotatedLogs.at(-1), "leLocally: returned\n", { encoding: "utf8", flag: "a" });
  const afterLongRaidAt = new Date(continuedAt.getTime() + 30_000);
  const afterLongRaidName = `${screenshotPrefix(afterLongRaidAt)}_25.0, 26.0, 27.0_0.0, 0.0, 0.0, 1.0_test.png`;
  const afterLongRaidPath = path.join(screenshotFolder, afterLongRaidName);
  await writeFile(afterLongRaidPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await utimes(afterLongRaidPath, afterLongRaidAt, afterLongRaidAt);
  const afterLongRaidEvents = await waitForEvents(baseUrl, 10, 1, 12_000);
  assert.equal(Object.hasOwn(afterLongRaidEvents.data[0], "mapKey"), false);

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
  await waitForCursor(baseUrl, 101);
  const expiredResponse = await fetch(new URL("api/v1/local-tracker/events?afterCursor=0&pageSize=10", baseUrl));
  assert.equal(expiredResponse.status, 200);
  const expired = await expiredResponse.json();
  assert.equal(expired.data.length, 10);
  assert.equal(expired.pagination.afterCursor, 0);
  assert.equal(expired.pagination.isResetRequired, true);
  assert.equal(expired.pagination.hasMore, true);
  assert.equal(expired.pagination.nextCursor, expired.data.at(-1).sequence);
  assert.equal(expired.data[0].sequence > 1, true);

  const futureCursor = await fetch(new URL(`api/v1/local-tracker/events?afterCursor=${Number.MAX_SAFE_INTEGER}&pageSize=10`, baseUrl));
  assert.equal(futureCursor.status, 400);
  const oversizedPage = await fetch(new URL("api/v1/local-tracker/events?afterCursor=0&pageSize=101", baseUrl));
  assert.equal(oversizedPage.status, 400);
});

test("local tracker starts watching when a missing configured folder appears", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-tracker-missing-"));
  const appRoot = path.join(temporaryRoot, "app");
  const screenshotFolder = path.join(temporaryRoot, "missing");
  const gameLogRoot = path.join(temporaryRoot, "GameLogs");
  const gameLogSession = path.join(gameLogRoot, "log_watcher_test");
  const stateDirectory = path.join(temporaryRoot, "state");
  await mkdir(appRoot);
  await mkdir(gameLogSession, { recursive: true });
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Tracker test</title>", "utf8");
  await writeFile(path.join(gameLogSession, "watcher application_000.log"), "menu heartbeat\n", "utf8");

  const server = startServer({
    appRoot,
    screenshotFolder,
    stateDirectory,
    gameLogRoot,
  });
  t.after(async () => {
    await stopServer(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const baseUrl = await server.ready;

  const response = await fetch(new URL("api/v1/local-tracker/status", baseUrl));
  assert.equal(response.status, 200);
  const missingStatus = await response.json();
  assert.match(missingStatus.instanceId, /^[a-f0-9]{32}$/);
  assert.deepEqual(missingStatus, {
    protocolVersion: 1,
    instanceId: missingStatus.instanceId,
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
    instanceId: missingStatus.instanceId,
    screenshotWatcher: { state: "WATCHING", folderPath: canonicalScreenshotFolder },
    latestCursor: 0,
  });

  const events = await waitForEvents(baseUrl, 0, 1);
  assert.equal(events.data[0].fileName, screenshotName);
});
