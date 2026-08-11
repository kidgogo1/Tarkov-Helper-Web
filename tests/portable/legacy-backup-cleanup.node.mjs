import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const sourceLauncher = path.join(projectRoot, "portable", "launcher.ps1");
const repository = "kidgogo1/Tarkov-Helper-Web";

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function packageFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (child === "SHA256SUMS.txt") continue;
    if (entry.isDirectory()) files.push(...await packageFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function writePackage(root, version, commit) {
  await mkdir(path.join(root, "app"), { recursive: true });
  await copyFile(sourceLauncher, path.join(root, "launcher.ps1"));
  await writeFile(path.join(root, "app", "index.html"), `<!doctype html><title>${version}</title>`, "utf8");
  await writeFile(path.join(root, "app", "version.json"), `${JSON.stringify({
    schemaVersion: 1,
    product: "tarkov-helper-web",
    version,
    commit,
    updaterProtocolVersion: 1,
  })}\n`, "utf8");
  await writeFile(path.join(root, "PACKAGE_INFO.txt"), [
    "Tarkov Helper Web - Direct Run Package",
    `Version: ${version}`,
    `Source commit: ${commit}`,
    "Updater protocol: 1",
    "App files: 2",
    "App bytes: 1",
    `App tree SHA-256: ${"f".repeat(64)}`,
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "UPDATE_CONFIG.json"), `${JSON.stringify({
    schemaVersion: 1,
    updaterEnabled: true,
    protocolVersion: 1,
    repository,
    releaseApi: `https://api.github.com/repos/${repository}/releases/latest`,
    manifestAsset: "update-manifest-v1.json",
    signatureAsset: "update-manifest-v1.sig",
    requireImmutableRelease: true,
    signing: {
      algorithm: "RSA-SHA256",
      keyId: `sha256:${"a".repeat(64)}`,
      publicKeySpkiPem: "test-public-key",
    },
  })}\n`, "utf8");

  const files = (await packageFiles(root)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const records = [];
  for (const relative of files) {
    const contents = await readFile(path.join(root, relative));
    records.push(`${sha256(contents)}  ${contents.byteLength}  ${relative.replaceAll(path.sep, "/")}`);
  }
  await writeFile(path.join(root, "SHA256SUMS.txt"), `${records.join("\n")}\n`, "utf8");
}

function runLauncher(packageRoot, stateDirectory, extraEnvironment = {}, timeout = 45_000) {
  return spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(packageRoot, "launcher.ps1"),
    "-Action",
    "Start",
    "-Root",
    path.join(packageRoot, "app"),
    "-Port",
    "0",
    "-NoBrowser",
    "-StateDirectory",
    stateDirectory,
  ], {
    cwd: os.tmpdir(),
    env: { ...process.env, ...extraEnvironment },
    stdio: "ignore",
    timeout,
    windowsHide: true,
  });
}

function stopLauncher(packageRoot, stateDirectory) {
  return spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(packageRoot, "launcher.ps1"),
    "-Action",
    "Stop",
    "-StateDirectory",
    stateDirectory,
  ], { cwd: os.tmpdir(), stdio: "ignore", timeout: 10_000, windowsHide: true });
}

function startReplacementServe(packageRoot, stateDirectory) {
  return spawn("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(packageRoot, "launcher.ps1"),
    "-Action",
    "Serve",
    "-Root",
    path.join(packageRoot, "app"),
    "-Port",
    "0",
    "-NoBrowser",
    "-StateDirectory",
    stateDirectory,
    "-UpdateNonce",
    "n".repeat(40),
  ], { cwd: os.tmpdir(), stdio: "ignore", windowsHide: true });
}

async function waitFor(check, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for legacy cleanup state.");
}

async function makeFixture({ backupVersion = "1.0.29", previousVersion = "1.0.29" } = {}) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "타르코프 %TEMP%, legacy-cleanup-"));
  const packageRoot = path.join(temporaryRoot, "Tarkov Helper 바로 실행 v1.0.29");
  const backupRoot = path.join(temporaryRoot, `.${path.basename(packageRoot)}.update-backup`);
  const stateDirectory = path.join(temporaryRoot, "state");
  const updateDirectory = path.join(stateDirectory, "app-update");
  const currentCommit = "b".repeat(40);
  const previousCommit = "a".repeat(40);
  await writePackage(packageRoot, "1.0.30", currentCommit);
  await writePackage(backupRoot, backupVersion, previousCommit);
  await mkdir(updateDirectory, { recursive: true });
  await writeFile(path.join(updateDirectory, "status.json"), JSON.stringify({
    state: "UPDATED",
    currentVersion: "1.0.30",
    previousVersion,
    updatedAt: "2026-08-12T00:00:00.0000000Z",
  }), "utf8");
  return {
    temporaryRoot,
    packageRoot,
    backupRoot,
    stateDirectory,
    updateDirectory,
    currentCommit,
    previousCommit,
  };
}

async function cleanupDirectories(temporaryRoot, packageRoot) {
  const prefix = `.${path.basename(packageRoot)}.update-cleanup-legacy-`;
  return (await readdir(temporaryRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(temporaryRoot, entry.name));
}

test("the first new-version Start removes the exact legacy committed backup left by an old broker", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await makeFixture();
  t.after(async () => {
    stopLauncher(fixture.packageRoot, fixture.stateDirectory);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const started = runLauncher(fixture.packageRoot, fixture.stateDirectory);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  assert.equal(await exists(fixture.backupRoot), false);
  assert.deepEqual(await cleanupDirectories(fixture.temporaryRoot, fixture.packageRoot), []);
  assert.equal(await exists(path.join(fixture.updateDirectory, "legacy-cleanup.json")), false);
  assert.equal(JSON.parse(await readFile(path.join(fixture.updateDirectory, "status.json"), "utf8")).state, "UPDATED");
});

test("an older direct-release broker backup is cleaned when its strict version precedes the current package", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await makeFixture({ backupVersion: "1.0.20", previousVersion: "1.0.20" });
  t.after(async () => {
    stopLauncher(fixture.packageRoot, fixture.stateDirectory);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const started = runLauncher(fixture.packageRoot, fixture.stateDirectory);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  assert.equal(await exists(fixture.backupRoot), false);
  assert.equal(await exists(path.join(fixture.updateDirectory, "legacy-cleanup.json")), false);
});

test("strict old-broker topology is claimed even if a manual check replaced UPDATED before the first cleanup pass", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await makeFixture();
  t.after(async () => {
    stopLauncher(fixture.packageRoot, fixture.stateDirectory);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });
  await writeFile(path.join(fixture.updateDirectory, "status.json"), JSON.stringify({
    state: "CURRENT",
    currentVersion: "1.0.30",
    latestVersion: "1.0.30",
    checkedAt: "2026-08-12T00:01:00.0000000Z",
  }), "utf8");

  const started = runLauncher(fixture.packageRoot, fixture.stateDirectory);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  assert.equal(await exists(fixture.backupRoot), false);
  assert.deepEqual(await cleanupDirectories(fixture.temporaryRoot, fixture.packageRoot), []);
  assert.equal(await exists(path.join(fixture.updateDirectory, "legacy-cleanup.json")), false);
  assert.equal(JSON.parse(await readFile(path.join(fixture.updateDirectory, "status.json"), "utf8")).state, "CURRENT");
});

test("a locked legacy backup becomes hidden deferred cleanup and is retried without blocking Start", { skip: process.platform !== "win32", timeout: 120_000 }, async (t) => {
  const fixture = await makeFixture();
  t.after(async () => {
    stopLauncher(fixture.packageRoot, fixture.stateDirectory);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const first = runLauncher(fixture.packageRoot, fixture.stateDirectory, {
    TARKOV_HELPER_UPDATE_TEST_LEGACY_CLEANUP_DELETE_FAILURES: "8",
  });
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  stopLauncher(fixture.packageRoot, fixture.stateDirectory);
  assert.equal(await exists(fixture.backupRoot), false);
  const [deferred] = await cleanupDirectories(fixture.temporaryRoot, fixture.packageRoot);
  assert.ok(deferred);
  assert.equal(await exists(path.join(fixture.updateDirectory, "legacy-cleanup.json")), true);

  const attributes = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `[int](Get-Item -LiteralPath '${deferred.replaceAll("'", "''")}' -Force).Attributes`,
  ], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(Number(attributes.stdout.trim()) & 0x2, 0x2, attributes.stderr);

  await writeFile(path.join(fixture.updateDirectory, "status.json"), JSON.stringify({
    state: "CURRENT",
    currentVersion: "1.0.30",
    latestVersion: "1.0.30",
    checkedAt: "2026-08-12T00:01:00.0000000Z",
  }), "utf8");

  const second = runLauncher(fixture.packageRoot, fixture.stateDirectory);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.deepEqual(await cleanupDirectories(fixture.temporaryRoot, fixture.packageRoot), []);
  assert.equal(await exists(path.join(fixture.updateDirectory, "legacy-cleanup.json")), false);
  assert.equal(JSON.parse(await readFile(path.join(fixture.updateDirectory, "status.json"), "utf8")).state, "CURRENT");
});

test("a power loss after the durable receipt but before rename resumes without losing the backup", { skip: process.platform !== "win32", timeout: 120_000 }, async (t) => {
  const fixture = await makeFixture();
  t.after(async () => {
    stopLauncher(fixture.packageRoot, fixture.stateDirectory);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const crashed = runLauncher(fixture.packageRoot, fixture.stateDirectory, {
    TARKOV_HELPER_UPDATE_TEST_LEGACY_CLEANUP_CRASH_AFTER_RECEIPT: "1",
  });
  assert.notEqual(crashed.status, 0);
  assert.equal((await stat(fixture.backupRoot)).isDirectory(), true);
  assert.deepEqual(await cleanupDirectories(fixture.temporaryRoot, fixture.packageRoot), []);
  assert.equal(await exists(path.join(fixture.updateDirectory, "legacy-cleanup.json")), true);

  const recovered = runLauncher(fixture.packageRoot, fixture.stateDirectory);
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
  assert.equal(await exists(fixture.backupRoot), false);
  assert.equal(await exists(path.join(fixture.updateDirectory, "legacy-cleanup.json")), false);
});

test("a corrupt durable receipt preserves its deferred cleanup tree and never blocks Start", { skip: process.platform !== "win32", timeout: 120_000 }, async (t) => {
  const fixture = await makeFixture();
  t.after(async () => {
    stopLauncher(fixture.packageRoot, fixture.stateDirectory);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const deferred = runLauncher(fixture.packageRoot, fixture.stateDirectory, {
    TARKOV_HELPER_UPDATE_TEST_LEGACY_CLEANUP_DELETE_FAILURES: "8",
  });
  assert.equal(deferred.status, 0, `${deferred.stdout}\n${deferred.stderr}`);
  stopLauncher(fixture.packageRoot, fixture.stateDirectory);
  await writeFile(path.join(fixture.updateDirectory, "legacy-cleanup.json"), "{", "utf8");

  const restarted = runLauncher(fixture.packageRoot, fixture.stateDirectory);
  assert.equal(restarted.status, 0, `${restarted.stdout}\n${restarted.stderr}`);
  assert.equal(await exists(fixture.backupRoot), false);
  assert.equal((await cleanupDirectories(fixture.temporaryRoot, fixture.packageRoot)).length, 1);
  assert.equal(await readFile(path.join(fixture.updateDirectory, "legacy-cleanup.json"), "utf8"), "{");
});

test("a power loss after the legacy backup rename resumes from the durable receipt", { skip: process.platform !== "win32", timeout: 120_000 }, async (t) => {
  const fixture = await makeFixture();
  t.after(async () => {
    stopLauncher(fixture.packageRoot, fixture.stateDirectory);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const crashed = runLauncher(fixture.packageRoot, fixture.stateDirectory, {
    TARKOV_HELPER_UPDATE_TEST_LEGACY_CLEANUP_CRASH_AFTER_RENAME: "1",
  });
  assert.notEqual(crashed.status, 0);
  assert.equal(await exists(fixture.backupRoot), false);
  assert.equal((await cleanupDirectories(fixture.temporaryRoot, fixture.packageRoot)).length, 1);
  assert.equal(await exists(path.join(fixture.updateDirectory, "legacy-cleanup.json")), true);

  const recovered = runLauncher(fixture.packageRoot, fixture.stateDirectory);
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
  assert.deepEqual(await cleanupDirectories(fixture.temporaryRoot, fixture.packageRoot), []);
  assert.equal(await exists(path.join(fixture.updateDirectory, "legacy-cleanup.json")), false);
});

test("a mismatched sibling is preserved and never treated as an updater-owned backup", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await makeFixture({ backupVersion: "9.9.9" });
  t.after(async () => {
    stopLauncher(fixture.packageRoot, fixture.stateDirectory);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const started = runLauncher(fixture.packageRoot, fixture.stateDirectory);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  assert.equal((await stat(fixture.backupRoot)).isDirectory(), true);
  assert.deepEqual(await cleanupDirectories(fixture.temporaryRoot, fixture.packageRoot), []);
  assert.equal(await exists(path.join(fixture.updateDirectory, "legacy-cleanup.json")), false);
});

test("a reparse point anywhere in the legacy backup preserves the entire backup", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await makeFixture();
  const outside = path.join(fixture.temporaryRoot, "outside-preserved");
  await mkdir(outside);
  await writeFile(path.join(outside, "keep.txt"), "keep", "utf8");
  await symlink(outside, path.join(fixture.backupRoot, "unsafe-junction"), "junction");
  t.after(async () => {
    stopLauncher(fixture.packageRoot, fixture.stateDirectory);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const started = runLauncher(fixture.packageRoot, fixture.stateDirectory);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  assert.equal((await stat(fixture.backupRoot)).isDirectory(), true);
  assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "keep");
  assert.equal(await exists(path.join(fixture.updateDirectory, "legacy-cleanup.json")), false);
});

test("Start leaves the legacy backup untouched while an apply journal is present", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await makeFixture();
  await writeFile(path.join(fixture.updateDirectory, "apply-journal.json"), "{}", "utf8");
  t.after(async () => {
    stopLauncher(fixture.packageRoot, fixture.stateDirectory);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const started = runLauncher(fixture.packageRoot, fixture.stateDirectory);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  assert.equal((await stat(fixture.backupRoot)).isDirectory(), true);
  assert.deepEqual(await cleanupDirectories(fixture.temporaryRoot, fixture.packageRoot), []);
  assert.equal(await exists(path.join(fixture.updateDirectory, "legacy-cleanup.json")), false);
});

test("the healthy old-broker replacement Serve cleans only after pending state reaches UPDATED", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await makeFixture();
  const pendingPath = path.join(fixture.updateDirectory, "pending.json");
  await writeFile(pendingPath, "{}", "utf8");
  await writeFile(path.join(fixture.updateDirectory, "status.json"), JSON.stringify({
    state: "APPLYING",
    currentVersion: "1.0.29",
    latestVersion: "1.0.30",
    startedAt: "2026-08-12T00:00:00.0000000Z",
  }), "utf8");
  const server = startReplacementServe(fixture.packageRoot, fixture.stateDirectory);
  t.after(async () => {
    stopLauncher(fixture.packageRoot, fixture.stateDirectory);
    if (server.exitCode === null) server.kill();
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const instancePath = path.join(fixture.stateDirectory, "instance.json");
  await waitFor(() => exists(instancePath));
  const instance = JSON.parse(await readFile(instancePath, "utf8"));
  const health = await fetch(`http://127.0.0.1:${instance.port}/.tarkov-helper-portable`);
  assert.equal(health.status, 200);
  assert.equal((await stat(fixture.backupRoot)).isDirectory(), true);

  await rm(pendingPath);
  await writeFile(path.join(fixture.updateDirectory, "status.json"), JSON.stringify({
    state: "UPDATED",
    currentVersion: "1.0.30",
    previousVersion: "1.0.29",
    updatedAt: "2026-08-12T00:00:00.0000000Z",
  }), "utf8");
  await waitFor(async () => (
    !(await exists(fixture.backupRoot)) &&
    (await cleanupDirectories(fixture.temporaryRoot, fixture.packageRoot)).length === 0 &&
    !(await exists(path.join(fixture.updateDirectory, "legacy-cleanup.json")))
  ));
  assert.equal(await exists(path.join(fixture.updateDirectory, "legacy-cleanup.json")), false);
});

test("replacement Serve cleanup uses a nonblocking mutex and a bounded retry window", async () => {
  const launcher = await readFile(sourceLauncher, "utf8");
  assert.match(launcher, /legacyAppUpdateCleanupDeadlineUtc\s*=\s*\[DateTime\]::UtcNow\.AddMinutes\(5\)/);
  assert.match(launcher, /function Invoke-LegacyAppUpdateBackupCleanupFromServe[\s\S]*?\.WaitOne\(0\)/);
});
