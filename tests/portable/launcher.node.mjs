import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const launcherPath = path.join(projectRoot, "portable", "launcher.ps1");

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for portable launcher test state.");
}
const commandPath = path.join(projectRoot, "portable", "문제 해결용 실행.cmd");

test("portable Start allows slow machines to finish authenticated readiness", async () => {
  const launcher = await readFile(launcherPath, "utf8");
  assert.match(
    launcher,
    /\$deadline = \[DateTime\]::UtcNow\.AddSeconds\(30\)/,
    "Start readiness must allow Defender/slow-disk initialization to complete",
  );
});

test("read-only recovery never reuses a server whose update mode is not attested", { skip: process.platform !== "win32", timeout: 30_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-read-only-reuse-"));
  const appRoot = path.join(temporaryRoot, "app");
  const stateDirectory = path.join(temporaryRoot, "state");
  const portProbe = net.createServer();
  await new Promise((resolve, reject) => {
    portProbe.once("error", reject);
    portProbe.listen(0, "127.0.0.1", resolve);
  });
  const port = portProbe.address().port;
  await new Promise((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));
  await mkdir(appRoot, { recursive: true });
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>unattested update mode</title>", "utf8");
  const server = spawn("powershell.exe", [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcherPath,
    "-Action", "Serve", "-Root", appRoot, "-Port", String(port), "-NoBrowser", "-StateDirectory", stateDirectory,
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  t.after(async () => {
    spawnSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcherPath,
      "-Action", "Stop", "-StateDirectory", stateDirectory,
    ], { encoding: "utf8", windowsHide: true });
    if (server.exitCode === null) server.kill();
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  await waitForUrl(server);

  const refused = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcherPath,
    "-Action", "Start", "-Root", appRoot, "-Port", String(port), "-NoBrowser", "-StateDirectory", stateDirectory,
    "-DisablePackageUpdates",
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(refused.status, 2, `${refused.stdout}\n${refused.stderr}`);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /read-only|isolated recovery|stop/i);
});

test("portable logs use a bounded mutex and never persist raw child output", async () => {
  const launcher = await readFile(launcherPath, "utf8");
  assert.match(launcher, /function Protect-PortableLogMessage/);
  assert.match(launcher, /WaitOne\(200\)/);
  assert.match(launcher, /Threading\.AbandonedMutexException/);
  assert.match(launcher, /function Rotate-PortableLogFile/);
  assert.match(launcher, /protectedPortableLogPaths = \[Collections\.Generic\.HashSet\[string\]\]/);
  assert.match(launcher, /if \(-not \$script:protectedPortableLogPaths\.Contains\(\$candidateLogPath\)\)/);
  assert.match(launcher, /1048576/);
  assert.match(launcher, /\.previous/);
  assert.doesNotMatch(launcher, /RedirectStandard(?:Output|Error)/);
  assert.doesNotMatch(launcher, /(?:server|worker)\.(?:stdout|stderr)\.log/);
});

test("every native overlay internal failure is recorded before returning the generic error", async () => {
  const launcher = await readFile(launcherPath, "utf8");
  const lines = launcher.split(/\r?\n/);
  const nativeFailureLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /-Code "NATIVE_FAILURE"/.test(line));
  assert.ok(nativeFailureLines.length > 0);
  for (const { index } of nativeFailureLines) {
    assert.match(
      lines.slice(Math.max(0, index - 5), index).join("\n"),
      /Write-PortableLog/,
      `NATIVE_FAILURE at launcher.ps1:${index + 1} must have a nearby durable diagnostic event`,
    );
  }
});

test("portable background failures and fatal serve exits record causes distinct from a normal stop", async () => {
  const launcher = await readFile(launcherPath, "utf8");
  assert.match(launcher, /Screenshot watcher startup failed: \$\(\$_\.Exception\.GetType\(\)\.Name\): \$\(\$_\.Exception\.Message\)/);
  assert.match(launcher, /Screenshot watcher reconciliation failed: \$\(\$_\.Exception\.GetType\(\)\.Name\): \$\(\$_\.Exception\.Message\)/);
  assert.match(launcher, /Native overlay periodic reconciliation failed: \$\(\$_\.Exception\.GetType\(\)\.Name\): \$\(\$_\.Exception\.Message\)/);
  assert.match(launcher, /Server terminated unexpectedly: \$\(\$_\.Exception\.GetType\(\)\.Name\): \$\(\$_\.Exception\.Message\)/);
  assert.match(launcher, /Server preflight failed: \$\(\$_\.Exception\.GetType\(\)\.Name\): \$\(\$_\.Exception\.Message\)/);
  assert.match(launcher, /Screenshot watcher cleanup failed:/);
  assert.match(launcher, /Listener cleanup failed:/);
  assert.match(launcher, /Instance state cleanup failed:/);
  assert.match(launcher, /Server stopped normally\./);
});

test("portable logger sanitizes legacy server current and previous logs before appending", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-legacy-server-log-"));
  const appRoot = path.join(temporaryRoot, "app");
  const stateDirectory = path.join(temporaryRoot, "state");
  await mkdir(appRoot, { recursive: true });
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(path.join(stateDirectory, "server.log"), `Authorization: Bearer ${"D".repeat(100)} legacy-server-current`, "utf8");
  await writeFile(path.join(stateDirectory, "server.previous.log"), "C:/Users/O'Brien/legacy-server-previous/file.ps1", "utf8");
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const result = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcherPath,
    "-Action", "Serve", "-Root", appRoot, "-NoBrowser", "-StateDirectory", stateDirectory,
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  const current = await readFile(path.join(stateDirectory, "server.log"), "utf8");
  const previous = await readFile(path.join(stateDirectory, "server.previous.log"), "utf8");
  assert.doesNotMatch(`${current}\n${previous}`, /legacy-server-current|legacy-server-previous|O'Brien|D{20}/i);
  assert.match(current, /index\.html is missing/);
});

test("portable Start archives a stale staged update from another completed installation", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryParent = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-stale-update-"));
  const packageRoot = path.join(temporaryParent, "Tarkov Helper 바로 실행 v1.0.20");
  const oldPackageRoot = path.join(temporaryParent, "old-install-v1.0.14");
  const appRoot = path.join(packageRoot, "app");
  const stateDirectory = path.join(temporaryParent, "state");
  const appUpdateDirectory = path.join(stateDirectory, "app-update");
  const portProbe = net.createServer();
  await new Promise((resolve, reject) => {
    portProbe.once("error", reject);
    portProbe.listen(0, "127.0.0.1", resolve);
  });
  const testPort = portProbe.address().port;
  await new Promise((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));
  await mkdir(appRoot, { recursive: true });
  await mkdir(appUpdateDirectory, { recursive: true });
  await copyFile(launcherPath, path.join(packageRoot, "launcher.ps1"));
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>stale state recovery</title>", "utf8");
  await writeFile(
    path.join(appRoot, "version.json"),
    JSON.stringify({
      schemaVersion: 1,
      product: "tarkov-helper-web",
      version: "1.0.20",
      commit: "a".repeat(40),
      updaterProtocolVersion: 1,
    }),
    "utf8",
  );
  const legacyPending = {
    state: "READY_TO_RESTART",
    packageRoot: oldPackageRoot,
    latestVersion: "1.0.20",
  };
  const pendingPath = path.join(appUpdateDirectory, "pending.json");

  // Pre-tag builds emitted this minimal shape. A missing optional field is a
  // compatibility case, while a present-but-invalid value must remain fail-closed.
  await mkdir(path.join(oldPackageRoot, "app"), { recursive: true });
  const invalidPortPending = { ...legacyPending, port: "not-a-port" };
  await writeFile(pendingPath, JSON.stringify(invalidPortPending), "utf8");
  const refusedInvalidPort = spawnSync(
    "powershell.exe",
    [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(packageRoot, "launcher.ps1"),
      "-Action", "Start", "-Root", appRoot, "-Port", String(testPort), "-NoBrowser", "-StateDirectory", stateDirectory,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(refusedInvalidPort.status, 2, `${refusedInvalidPort.stdout}\n${refusedInvalidPort.stderr}`);
  assert.deepEqual(JSON.parse(await readFile(pendingPath, "utf8")), invalidPortPending);
  assert.equal((await readdir(stateDirectory)).some((entry) => entry.startsWith("app-update-stale-backup-")), false);

  await rm(oldPackageRoot, { recursive: true, force: true });
  await writeFile(pendingPath, JSON.stringify(legacyPending), "utf8");

  const transactionLockPath = path.join(stateDirectory, "app-update.transaction.lock");
  const lockReadyPath = path.join(stateDirectory, "transaction-lock-ready");
  const lockHolder = spawn("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "$stream = [IO.FileStream]::new($env:TARKOV_LOCK_PATH, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); [IO.File]::WriteAllText($env:TARKOV_LOCK_READY, 'ready'); try { [Console]::In.ReadLine() | Out-Null } finally { $stream.Dispose() }",
  ], {
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
    env: { ...process.env, TARKOV_LOCK_PATH: transactionLockPath, TARKOV_LOCK_READY: lockReadyPath },
  });
  await waitFor(async () => readFile(lockReadyPath, "utf8").then(() => true).catch(() => false));

  const refusedWhileLocked = spawnSync(
    "powershell.exe",
    [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(packageRoot, "launcher.ps1"),
      "-Action", "Start", "-Root", appRoot, "-Port", String(testPort), "-NoBrowser", "-StateDirectory", stateDirectory,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(refusedWhileLocked.status, 2, `${refusedWhileLocked.stdout}\n${refusedWhileLocked.stderr}`);
  assert.equal((await readdir(stateDirectory)).some((entry) => entry.startsWith("app-update-stale-backup-")), false);
  assert.deepEqual(JSON.parse(await readFile(pendingPath, "utf8")), legacyPending);
  lockHolder.stdin.end("\n");
  await new Promise((resolve) => lockHolder.once("exit", resolve));

  const occupiedProbe = net.createServer();
  await new Promise((resolve, reject) => {
    occupiedProbe.once("error", reject);
    occupiedProbe.listen(testPort, "127.0.0.1", resolve);
  });
  const refusedWhilePortOccupied = spawnSync(
    "powershell.exe",
    [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(packageRoot, "launcher.ps1"),
      "-Action", "Start", "-Root", appRoot, "-Port", String(testPort), "-NoBrowser", "-StateDirectory", stateDirectory,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(refusedWhilePortOccupied.status, 2, `${refusedWhilePortOccupied.stdout}\n${refusedWhilePortOccupied.stderr}`);
  assert.equal((await readdir(stateDirectory)).some((entry) => entry.startsWith("app-update-stale-backup-")), false);
  assert.deepEqual(JSON.parse(await readFile(pendingPath, "utf8")), legacyPending);
  await new Promise((resolve, reject) => occupiedProbe.close((error) => error ? reject(error) : resolve()));

  const legacyCleanupEvidence = path.join(
    path.dirname(oldPackageRoot),
    `.${path.basename(oldPackageRoot)}.update-cleanup-${"A".repeat(40)}`,
  );
  await mkdir(legacyCleanupEvidence);
  const refusedWithLegacyEvidence = spawnSync(
    "powershell.exe",
    [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(packageRoot, "launcher.ps1"),
      "-Action", "Start", "-Root", appRoot, "-Port", String(testPort), "-NoBrowser", "-StateDirectory", stateDirectory,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(refusedWithLegacyEvidence.status, 2, `${refusedWithLegacyEvidence.stdout}\n${refusedWithLegacyEvidence.stderr}`);
  assert.deepEqual(JSON.parse(await readFile(pendingPath, "utf8")), legacyPending);
  assert.equal((await stat(legacyCleanupEvidence)).isDirectory(), true);
  await rm(legacyCleanupEvidence, { recursive: true });

  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(packageRoot, "launcher.ps1"),
      "-Action",
      "Start",
      "-Root",
      appRoot,
      "-Port",
      String(testPort),
      "-NoBrowser",
      "-StateDirectory",
      stateDirectory,
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await rm(temporaryParent, { recursive: true, force: true });
  });

  const { url } = await waitForUrl(child);
  assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${testPort}/$`));
  const stateEntries = await readdir(stateDirectory);
  const staleBackups = stateEntries.filter((entry) => entry.startsWith("app-update-stale-backup-"));
  assert.equal(staleBackups.length, 1);
  assert.equal(await readFile(path.join(appRoot, "version.json"), "utf8").then((value) => JSON.parse(value).version), "1.0.20");

  const stopped = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(packageRoot, "launcher.ps1"), "-Action", "Stop", "-StateDirectory", stateDirectory],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
});

test("portable Start preserves a stale transaction once apply topology exists", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryParent = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-stale-active-update-"));
  const packageRoot = path.join(temporaryParent, "current-install");
  const oldPackageRoot = path.join(temporaryParent, "old-install");
  const appRoot = path.join(packageRoot, "app");
  const stateDirectory = path.join(temporaryParent, "state");
  const updateDirectory = path.join(stateDirectory, "app-update");
  const pendingPath = path.join(updateDirectory, "pending.json");
  const journalPath = path.join(updateDirectory, "apply-journal.json");
  await mkdir(appRoot, { recursive: true });
  await mkdir(path.join(oldPackageRoot, "app"), { recursive: true });
  await mkdir(updateDirectory, { recursive: true });
  await copyFile(launcherPath, path.join(packageRoot, "launcher.ps1"));
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>preserve active update</title>", "utf8");
  await writeFile(path.join(appRoot, "version.json"), JSON.stringify({
    schemaVersion: 1, product: "tarkov-helper-web", version: "1.0.20", commit: "a".repeat(40), updaterProtocolVersion: 1,
  }), "utf8");
  const pending = { state: "READY_TO_RESTART", packageRoot: oldPackageRoot, latestVersion: "1.0.20" };
  await writeFile(pendingPath, JSON.stringify(pending), "utf8");
  await writeFile(journalPath, JSON.stringify({ phase: "OLD_MOVED" }), "utf8");
  t.after(async () => rm(temporaryParent, { recursive: true, force: true }));

  const result = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(packageRoot, "launcher.ps1"),
    "-Action", "Start", "-Root", appRoot, "-Port", "41753", "-NoBrowser", "-StateDirectory", stateDirectory,
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(await readFile(pendingPath, "utf8")), pending);
  assert.equal(JSON.parse(await readFile(journalPath, "utf8")).phase, "OLD_MOVED");
  assert.equal((await readdir(stateDirectory)).some((entry) => entry.startsWith("app-update-stale-backup-")), false);
});

function waitForUrl(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for launcher URL.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 30_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/TARKOV_HELPER_URL=(http:\/\/127\.0\.0\.1:(\d+)\/)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ url: match[1], port: Number(match[2]) });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Launcher exited before startup with code ${code}.\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Launcher did not stop after MaxRequests."));
    }, 10_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

function rawRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => socket.end(request));
    let response = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", () => resolve(response));
    socket.once("error", (error) => response ? resolve(response) : reject(error));
  });
}

test("portable launcher serves the app safely on loopback", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryParent = await mkdtemp(path.join(os.tmpdir(), "tarkov helper portable "));
  const appRoot = path.join(temporaryParent, "앱 파일");
  const otherAppRoot = path.join(temporaryParent, "다른 앱 파일");
  const stateDirectory = path.join(temporaryParent, "state");
  await mkdir(path.join(appRoot, "data"), { recursive: true });
  await mkdir(path.join(appRoot, "assets"), { recursive: true });
  await mkdir(path.join(otherAppRoot, "data"), { recursive: true });
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Tarkov Helper</title>", "utf8");
  await writeFile(path.join(appRoot, "data", "sample.json"), '{"ready":true}', "utf8");
  await writeFile(path.join(appRoot, "data", "tarkov-data.json"), '{"version":"current"}', "utf8");
  await writeFile(path.join(appRoot, "assets", "app.js"), "globalThis.ready = true;", "utf8");
  await writeFile(path.join(appRoot, "assets", "item icon.webp"), Buffer.from([0x52, 0x49, 0x46, 0x46]));
  await writeFile(path.join(otherAppRoot, "index.html"), "<!doctype html><title>Tarkov Helper</title>", "utf8");
  await writeFile(path.join(otherAppRoot, "data", "tarkov-data.json"), '{"version":"older"}', "utf8");
  await writeFile(path.join(temporaryParent, "secret.txt"), "must-not-leak", "utf8");
  const canonicalAppRoot = await realpath(appRoot);

  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath,
      "-Root",
      appRoot,
      "-Port",
      "0",
      "-NoBrowser",
      "-StateDirectory",
      stateDirectory,
      "-MaxRequests",
      "13",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  const { url, port } = await waitForUrl(child);
  const instancePath = path.join(stateDirectory, "instance.json");
  const runningInstance = JSON.parse(await readFile(instancePath, "utf8"));
  assert.equal(runningInstance.rootPath, canonicalAppRoot);
  const authenticatedHealth = await fetch(new URL(".tarkov-helper-portable", url), {
    headers: { "x-tarkov-control": runningInstance.controlToken },
  });
  assert.equal(authenticatedHealth.status, 200);
  assert.equal(await authenticatedHealth.text(), `tarkov-helper-web-portable-v1:${runningInstance.buildIdentity}:authenticated`);

  const reused = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath,
      "-Root",
      appRoot,
      "-Port",
      String(port),
      "-NoBrowser",
      "-StateDirectory",
      stateDirectory,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(reused.status, 0, `${reused.stdout}\n${reused.stderr}`);
  assert.match(reused.stdout, /already running/i);

  const mismatchedBuild = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath,
      "-Root",
      otherAppRoot,
      "-Port",
      String(port),
      "-NoBrowser",
      "-StateDirectory",
      stateDirectory,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(mismatchedBuild.status, 2);
  assert.match(`${mismatchedBuild.stdout}\n${mismatchedBuild.stderr}`, /used by another program|owns this local runtime state/i);

  const instanceState = await readFile(instancePath, "utf8");
  await rm(instancePath);
  const unauthenticatedReuse = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath,
      "-Root",
      appRoot,
      "-Port",
      String(port),
      "-NoBrowser",
      "-StateDirectory",
      stateDirectory,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(unauthenticatedReuse.status, 2);
  assert.match(`${unauthenticatedReuse.stdout}\n${unauthenticatedReuse.stderr}`, /used by another program|owns this local runtime state/i);
  await writeFile(instancePath, instanceState, "utf8");

  const indexResponse = await fetch(url);
  assert.equal(indexResponse.status, 200);
  assert.match(indexResponse.headers.get("content-type") ?? "", /^text\/html; charset=utf-8$/);
  assert.equal(indexResponse.headers.get("x-frame-options"), "DENY");
  assert.equal(indexResponse.headers.get("content-security-policy"), "frame-ancestors 'none'");
  assert.match(await indexResponse.text(), /Tarkov Helper/);

  const headResponse = await fetch(new URL("data/sample.json", url), { method: "HEAD" });
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(await headResponse.text(), "");

  const scriptResponse = await fetch(new URL("assets/app.js?cache=1", url));
  assert.equal(scriptResponse.status, 200);
  assert.equal(scriptResponse.headers.get("content-type"), "text/javascript; charset=utf-8");

  const spacedAssetResponse = await fetch(new URL("assets/item%20icon.webp", url));
  assert.equal(spacedAssetResponse.status, 200);
  assert.equal(spacedAssetResponse.headers.get("content-type"), "image/webp");

  const missingResponse = await fetch(new URL("missing.svg", url));
  assert.equal(missingResponse.status, 404);

  const postResponse = await fetch(url, { method: "POST" });
  assert.equal(postResponse.status, 405);
  assert.equal(postResponse.headers.get("allow"), "GET, HEAD");

  const traversalResponse = await rawRequest(
    port,
    `GET /%2e%2e/secret.txt HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
  );
  assert.match(traversalResponse, /^HTTP\/1\.1 403 Forbidden/);
  assert.doesNotMatch(traversalResponse, /must-not-leak/);

  const invalidHostResponse = await rawRequest(
    port,
    "GET / HTTP/1.1\r\nHost: attacker.invalid\r\nConnection: close\r\n\r\n",
  );
  assert.match(invalidHostResponse, /^HTTP\/1\.1 400 Bad Request/);

  const backslashTraversalResponse = await rawRequest(
    port,
    `GET /%2e%2e%5csecret.txt HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
  );
  assert.match(backslashTraversalResponse, /^HTTP\/1\.1 400 Bad Request/);

  const malformedEscapeResponse = await rawRequest(
    port,
    `GET /bad%ZZpath HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
  );
  assert.match(malformedEscapeResponse, /^HTTP\/1\.1 400 Bad Request/);

  const oversizedHeaderResponse = await rawRequest(
    port,
    `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Large: ${"a".repeat(17_000)}\r\n\r\n`,
  );
  assert.match(oversizedHeaderResponse, /^HTTP\/1\.1 431 Request Header Fields Too Large/);

  const exit = await waitForExit(child);
  assert.deepEqual(exit, { code: 0, signal: null });
  await rm(temporaryParent, { recursive: true, force: true });
});

test("portable launcher fails clearly when index.html is missing", { skip: process.platform !== "win32" }, async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-empty-"));
  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcherPath, "-Root", temporaryRoot, "-NoBrowser"],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 2);
    assert.match(`${result.stdout}\n${result.stderr}`, /index\.html/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("diagnostic command resolves the launcher beside itself", async () => {
  const command = await readFile(commandPath, "utf8");
  const launcher = await readFile(launcherPath, "utf8");
  assert.match(command, /%~dp0launcher\.ps1/);
  assert.match(command, /powershell\.exe/i);
  assert.match(command, /-Action Serve/i);
  assert.match(command, /TARKOV_HELPER_EXIT/);
  assert.match(command, /endlocal & exit \/b/i);
  assert.match(command, /%\*/);
  assert.doesNotMatch(command, /node|npm|pnpm/i);
  assert.match(launcher, /\[int\]\$Port = 41753/);
});

test("diagnostic command starts its sibling app outside the package working directory", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryParent = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-command-"));
  const packageRoot = path.join(temporaryParent, "Tarkov Helper 바로 실행");
  const appRoot = path.join(packageRoot, "app");
  await mkdir(appRoot, { recursive: true });
  await copyFile(launcherPath, path.join(packageRoot, "launcher.ps1"));
  await copyFile(commandPath, path.join(packageRoot, "문제 해결용 실행.cmd"));
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Direct command</title>", "utf8");

  const child = spawn(
    "cmd.exe",
    [
      "/d",
      "/c",
      path.join(packageRoot, "문제 해결용 실행.cmd"),
      "-NoBrowser",
      "-Port",
      "0",
      "-MaxRequests",
      "1",
      "-StateDirectory",
      path.join(temporaryParent, "state"),
    ],
    { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await rm(temporaryParent, { recursive: true, force: true });
  });

  const { url } = await waitForUrl(child);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Direct command/);
  assert.deepEqual(await waitForExit(child), { code: 0, signal: null });

  await rm(appRoot, { recursive: true, force: true });
  const failed = spawnSync(
    "cmd.exe",
    ["/d", "/c", path.join(packageRoot, "문제 해결용 실행.cmd"), "-NoBrowser"],
    { cwd: projectRoot, encoding: "utf8", windowsHide: true },
  );
  assert.equal(failed.status, 2, `${failed.stdout}\n${failed.stderr}`);
  assert.match(`${failed.stdout}\n${failed.stderr}`, /index\.html/);
});
