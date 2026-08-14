import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const portableRoot = path.join(projectRoot, "portable");
const launcherPath = path.join(portableRoot, "launcher.ps1");
const startVbsPath = path.join(portableRoot, "Tarkov Helper 실행.vbs");
const stopVbsPath = path.join(portableRoot, "Tarkov Helper 종료.vbs");
const diagnosticCommandPath = path.join(portableRoot, "문제 해결용 실행.cmd");
const repairCommandPath = path.join(portableRoot, "Tarkov Helper 상태 복구.cmd");

function runLauncher(arguments_, timeout = 15_000, options = {}) {
  return spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath,
      ...arguments_,
    ],
    { cwd: options.cwd, env: options.env ? { ...process.env, ...options.env } : undefined, encoding: "utf8", windowsHide: true, timeout },
  );
}

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for lifecycle state.");
}

async function getUnusedLoopbackPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("double-click scripts start and stop the hidden broker without a console", async () => {
  const [startVbs, stopVbs, diagnosticCommand, repairCommand, launcher, updateBroker] = await Promise.all([
    readFile(startVbsPath, "utf8"),
    readFile(stopVbsPath, "utf8"),
    readFile(diagnosticCommandPath, "utf8"),
    readFile(repairCommandPath, "utf8"),
    readFile(launcherPath, "utf8"),
    readFile(path.join(portableRoot, "app-update-broker.ps1"), "utf8"),
  ]);

  assert.match(startVbs, /WScript\.Shell/i);
  assert.match(startVbs, /-Action Start/i);
  assert.match(startVbs, /\.Run\([\s\S]*,\s*0\s*,/i);
  assert.doesNotMatch(startVbs, /cmd\.exe/i);
  assert.match(stopVbs, /-Action Stop/i);
  assert.match(stopVbs, /\.Run\([\s\S]*,\s*0\s*,/i);
  assert.match(diagnosticCommand, /-Action Serve/i);
  assert.match(repairCommand, /-Action Repair/i);
  const instanceReader = /function Read-PortableInstance \{([\s\S]*?)\n\}/.exec(launcher)?.[1] ?? "";
  assert.match(instanceReader, /Length -gt 32768/);
  assert.match(instanceReader, /FileStream/);
  assert.doesNotMatch(instanceReader, /Get-Content/);
  assert.match(launcher, /Start-Process[\s\S]*-WindowStyle Hidden/i);
  const launcherStarts = launcher.match(/^\s*(?:\$\w+\s*=\s*)?Start-Process\b/gm) ?? [];
  const hiddenLauncherStarts = launcher.match(/^\s*(?:\$\w+\s*=\s*)?Start-Process\b[\s\S]{0,300}?-WindowStyle Hidden/gm) ?? [];
  assert.ok(launcherStarts.length >= 3, "expected the launcher, worker, and update handoff process starts");
  assert.equal(hiddenLauncherStarts.length, launcherStarts.length);
  assert.match(updateBroker, /Start-Process\b[\s\S]{0,300}?-WindowStyle Hidden/i);
  assert.equal((launcher.match(/Get-StateMutexName -Purpose "Control"/g) ?? []).length, 3);
  assert.match(launcher, /function Get-FileSha256Hex/);
  assert.match(launcher, /Get-FileSha256Hex -Path \$PSCommandPath/);
  assert.match(launcher, /\$Root = \$rootPath[\s\S]*?\$ScreenshotFolder = \[IO\.Path\]::GetFullPath\(\$ScreenshotFolder\)[\s\S]*?\$StateDirectory = \[IO\.Path\]::GetFullPath\(\$serveWorkingDirectory\)[\s\S]*?SetCurrentDirectory/);
});

test("Start reuses one hidden server and Stop gracefully terminates only its recorded instance", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-lifecycle-"));
  const appRoot = path.join(temporaryRoot, "app");
  const otherAppRoot = path.join(temporaryRoot, "other-app");
  const screenshotFolder = path.join(temporaryRoot, "Screenshots with space");
  const screenshotFolderArgument = `${screenshotFolder}${path.sep}`;
  const stateDirectory = path.join(temporaryRoot, "state");
  const instancePath = path.join(stateDirectory, "instance.json");
  const configPath = path.join(stateDirectory, "config.json");
  await mkdir(appRoot);
  await mkdir(otherAppRoot);
  await mkdir(screenshotFolder);
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Lifecycle test</title>", "utf8");
  await writeFile(path.join(otherAppRoot, "index.html"), "<!doctype html><title>Different build</title>", "utf8");
  const canonicalScreenshotFolderArgument = `${await realpath(screenshotFolder)}${path.sep}`;

  let instance;
  t.after(async () => {
    runLauncher(["-Action", "Stop", "-StateDirectory", stateDirectory], 5_000);
    if (instance?.pid) {
      spawnSync("taskkill.exe", ["/PID", String(instance.pid), "/T", "/F"], { windowsHide: true });
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const commonArguments = [
    "-Root", appRoot,
    "-Port", "0",
    "-NoBrowser",
    "-ScreenshotFolder", screenshotFolderArgument,
    "-StateDirectory", stateDirectory,
  ];
  const started = runLauncher(["-Action", "Start", ...commonArguments]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);

  instance = JSON.parse(await readFile(instancePath, "utf8"));
  assert.equal(instance.protocolVersion, 1);
  assert.equal(Number.isInteger(instance.pid), true);
  assert.match(instance.controlToken, /^[A-Za-z0-9_-]{40,}$/);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
    protocolVersion: 1,
    screenshotFolder: canonicalScreenshotFolderArgument,
  });
  const baseUrl = `http://127.0.0.1:${instance.port}/`;
  const response = await fetch(new URL("api/v1/local-tracker/status", baseUrl));
  assert.equal(response.status, 200);

  const repeated = runLauncher(["-Action", "Start", ...commonArguments]);
  assert.equal(repeated.status, 0, `${repeated.stdout}\n${repeated.stderr}`);
  const repeatedInstance = JSON.parse(await readFile(instancePath, "utf8"));
  assert.equal(repeatedInstance.pid, instance.pid);
  assert.equal(repeatedInstance.controlToken, instance.controlToken);

  const mismatched = runLauncher([
    "-Action", "Start",
    "-Root", otherAppRoot,
    "-Port", "0",
    "-NoBrowser",
    "-ScreenshotFolder", screenshotFolder,
    "-StateDirectory", stateDirectory,
  ]);
  assert.equal(mismatched.status, 2, `${mismatched.stdout}\n${mismatched.stderr}`);
  assert.match(`${mismatched.stdout}\n${mismatched.stderr}`, /different build|stop.*restart/i);
  const afterMismatch = JSON.parse(await readFile(instancePath, "utf8"));
  assert.equal(afterMismatch.pid, instance.pid);
  assert.equal(afterMismatch.controlToken, instance.controlToken);
  assert.equal((await fetch(baseUrl)).status, 200);

  const stopped = runLauncher(["-Action", "Stop", "-StateDirectory", stateDirectory]);
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
  await waitFor(async () => {
    try {
      await access(instancePath);
      return false;
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
  });
  await assert.rejects(fetch(baseUrl));

  const stoppedAgain = runLauncher(["-Action", "Stop", "-StateDirectory", stateDirectory]);
  assert.equal(stoppedAgain.status, 0, `${stoppedAgain.stdout}\n${stoppedAgain.stderr}`);
});

test("Start resolves relative root, state, and screenshot paths before changing the child CWD", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-relative-start-"));
  const packageRoot = path.join(temporaryRoot, "package");
  const appRoot = path.join(packageRoot, "app");
  const screenshotFolder = path.join(temporaryRoot, "screenshots");
  const stateDirectory = path.join(temporaryRoot, "state");
  await mkdir(appRoot, { recursive: true });
  await mkdir(screenshotFolder);
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Relative path test</title>", "utf8");

  t.after(async () => {
    runLauncher(["-Action", "Stop", "-StateDirectory", stateDirectory], 5_000);
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const started = runLauncher([
    "-Action", "Start",
    "-Root", "app",
    "-Port", "0",
    "-NoBrowser",
    "-ScreenshotFolder", `${path.join("..", "screenshots")}${path.sep}`,
    "-StateDirectory", path.join("..", "state"),
  ], 15_000, { cwd: packageRoot });
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const instance = JSON.parse(await readFile(path.join(stateDirectory, "instance.json"), "utf8"));
  assert.equal(instance.rootPath, await realpath(appRoot));
  let config;
  await waitFor(async () => {
    try {
      config = JSON.parse(await readFile(path.join(stateDirectory, "config.json"), "utf8"));
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  });
  assert.equal(config.screenshotFolder, `${await realpath(screenshotFolder)}${path.sep}`);
});

test("the authenticated browser lease shuts the server down after the tab closes", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-client-lease-"));
  const appRoot = path.join(temporaryRoot, "app");
  const stateDirectory = path.join(temporaryRoot, "state");
  const instancePath = path.join(stateDirectory, "instance.json");
  await mkdir(appRoot);
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Client lease test</title>", "utf8");

  t.after(async () => {
    runLauncher(["-Action", "Stop", "-StateDirectory", stateDirectory], 5_000);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const started = runLauncher([
    "-Action", "Start",
    "-Root", appRoot,
    "-Port", "0",
    "-NoBrowser",
    "-StateDirectory", stateDirectory,
  ]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const instance = JSON.parse(await readFile(instancePath, "utf8"));
  const baseUrl = `http://127.0.0.1:${instance.port}/`;
  const sessionResponse = await fetch(new URL("api/v1/client/session", baseUrl));
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.protocolVersion, 1);
  assert.match(session.leaseToken, /^[A-Za-z0-9_-]{40,64}$/);
  assert.equal(session.heartbeatIntervalMs, 2000);
  assert.equal(session.timeoutMs, 600000);

  const headers = {
    "content-type": "application/json",
    origin: new URL(baseUrl).origin,
  };
  const heartbeat = await fetch(new URL("api/v1/client/heartbeat", baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({ leaseToken: session.leaseToken }),
  });
  assert.equal(heartbeat.status, 204);

  const close = await fetch(new URL("api/v1/client/close", baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({ leaseToken: session.leaseToken }),
  });
  assert.equal(close.status, 204);
  await waitFor(async () => {
    try {
      await access(instancePath);
      return false;
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
  }, 8_000);
  await assert.rejects(fetch(baseUrl));
});

test("direct Serve moves its process CWD out of the package before a live swap", { skip: process.platform !== "win32", timeout: 30_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-serve-cwd-"));
  const packageRoot = path.join(temporaryRoot, "package");
  const movedPackageRoot = path.join(temporaryRoot, "package-moved");
  const appRoot = path.join(packageRoot, "app");
  const stateDirectory = path.join(temporaryRoot, "runtime", "state");
  const instancePath = path.join(stateDirectory, "instance.json");
  await mkdir(appRoot, { recursive: true });
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Serve CWD test</title>", "utf8");

  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcherPath,
      "-Action", "Serve", "-Root", "app", "-Port", "0", "-NoBrowser", "-StateDirectory", path.join("..", "runtime", "state"),
    ],
    { cwd: packageRoot, stdio: "ignore", windowsHide: true },
  );
  t.after(async () => {
    runLauncher(["-Action", "Stop", "-StateDirectory", stateDirectory], 5_000);
    if (child.exitCode === null) spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  await waitFor(async () => {
    try {
      return Boolean(JSON.parse(await readFile(instancePath, "utf8")).pid);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  });
  await rename(packageRoot, movedPackageRoot);
  const stopped = runLauncher(["-Action", "Stop", "-StateDirectory", stateDirectory], 10_000);
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
});

test("lease expiry never shuts down an armed client lifecycle", async () => {
  const launcher = await readFile(launcherPath, "utf8");
  const updateFunction = launcher.match(/function Update-ClientLeases[\s\S]*?\n}\r?\n\r?\nfunction Initialize-NativeOverlayBridge/);
  assert(updateFunction, "Expected the client lease maintenance function.");
  assert.match(updateFunction[0], /-not \$script:clientLifecycleArmed[\s\S]*?clientFirstLeaseDeadlineUtc[\s\S]*?shutdownRequested/);
  const armedLeaseMaintenance = updateFunction[0].slice(updateFunction[0].indexOf("foreach ($token"));
  assert.doesNotMatch(armedLeaseMaintenance, /\$script:\s*shutdownRequested\s*=\s*\$true/);
  assert.match(launcher, /if \(\$Closing\)[\s\S]*?clientLeases\.Remove\(\$Token\)[\s\S]*?clientLeases\.Count -eq 0[\s\S]*?shutdownRequested/);
});

test("Start preserves a live recorded instance when authenticated health probes time out", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-live-state-"));
  const appRoot = path.join(temporaryRoot, "app");
  const stateDirectory = path.join(temporaryRoot, "state");
  const instancePath = path.join(stateDirectory, "instance.json");
  const indexContents = "<!doctype html><title>Live state test</title>";
  await mkdir(appRoot);
  await mkdir(stateDirectory);
  await writeFile(path.join(appRoot, "index.html"), indexContents, "utf8");

  const fakeSockets = new Set();
  const fakeServer = net.createServer((socket) => {
    fakeSockets.add(socket);
    socket.once("close", () => fakeSockets.delete(socket));
    // Deliberately leave the connection unanswered until the broker probe times out.
  });
  await new Promise((resolve, reject) => {
    fakeServer.once("error", reject);
    fakeServer.listen(0, "127.0.0.1", resolve);
  });
  const address = fakeServer.address();
  assert(address && typeof address === "object");

  const startTimeResult = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-Command", `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToString('o')`],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(startTimeResult.status, 0, startTimeResult.stderr);
  const recordedInstance = {
    protocolVersion: 1,
    pid: process.pid,
    processStartTimeUtc: startTimeResult.stdout.trim(),
    port: address.port,
    controlToken: "A".repeat(43),
    buildIdentity: createHash("sha256").update(`${createHash("sha256").update(indexContents).digest("hex")}:${createHash("sha256").update(await readFile(launcherPath)).digest("hex")}`).digest("hex"),
    rootPath: appRoot,
    startedAt: new Date().toISOString(),
  };
  await writeFile(instancePath, JSON.stringify(recordedInstance), "utf8");

  t.after(async () => {
    const finalState = JSON.parse(await readFile(instancePath, "utf8").catch(() => "null"));
    if (finalState?.pid !== process.pid) {
      runLauncher(["-Action", "Stop", "-StateDirectory", stateDirectory], 5_000);
    }
    for (const socket of fakeSockets) socket.destroy();
    await new Promise((resolve) => fakeServer.close(resolve));
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const result = runLauncher([
    "-Action", "Start",
    "-Root", appRoot,
    "-Port", "0",
    "-NoBrowser",
    "-StateDirectory", stateDirectory,
  ]);
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /could not be authenticated|already running/i);
  assert.deepEqual(JSON.parse(await readFile(instancePath, "utf8")), recordedInstance);
  assert.equal(fakeServer.listening, true);
});

test("Start and Stop preserve corrupt instance state and report that it cannot be authenticated", { skip: process.platform !== "win32" }, async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-corrupt-state-"));
  const appRoot = path.join(temporaryRoot, "app");
  const stateDirectory = path.join(temporaryRoot, "state");
  const instancePath = path.join(stateDirectory, "instance.json");
  await mkdir(appRoot);
  await mkdir(stateDirectory);
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Corrupt state test</title>", "utf8");
  await writeFile(instancePath, "{not valid json", "utf8");

  try {
    const startResult = runLauncher([
      "-Action", "Start",
      "-Root", appRoot,
      "-Port", "0",
      "-NoBrowser",
      "-StateDirectory", stateDirectory,
    ]);
    assert.equal(startResult.status, 2, `${startResult.stdout}\n${startResult.stderr}`);
    assert.match(`${startResult.stdout}\n${startResult.stderr}`, /state|instance|authenticate/i);
    assert.equal(await readFile(instancePath, "utf8"), "{not valid json");

    const result = runLauncher(["-Action", "Stop", "-StateDirectory", stateDirectory]);
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /state|instance|authenticate/i);
    assert.equal(await readFile(instancePath, "utf8"), "{not valid json");
  } finally {
    runLauncher(["-Action", "Stop", "-StateDirectory", stateDirectory], 5_000);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Repair explicitly quarantines corrupt instance state before a clean restart", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-repair-corrupt-state-"));
  const appRoot = path.join(temporaryRoot, "app");
  const stateDirectory = path.join(temporaryRoot, "state");
  const instancePath = path.join(stateDirectory, "instance.json");
  const corruptState = "{not valid json";
  await mkdir(appRoot);
  await mkdir(stateDirectory);
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Repair state test</title>", "utf8");
  await writeFile(instancePath, corruptState, "utf8");
  const repairPort = await getUnusedLoopbackPort();

  t.after(async () => {
    runLauncher(["-Action", "Stop", "-StateDirectory", stateDirectory], 5_000);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const repaired = runLauncher(["-Action", "Repair", "-Port", String(repairPort), "-StateDirectory", stateDirectory]);
  assert.equal(repaired.status, 0, `${repaired.stdout}\n${repaired.stderr}`);
  assert.match(`${repaired.stdout}\n${repaired.stderr}`, /quarantined|repair|recovery/i);
  await assert.rejects(readFile(instancePath, "utf8"), { code: "ENOENT" });
  const quarantined = (await readdir(stateDirectory)).filter((name) => /^instance\.corrupt-[0-9]{8}T[0-9]{6}-[0-9a-f]{32}\.json$/.test(name));
  assert.equal(quarantined.length, 1);
  assert.equal(await readFile(path.join(stateDirectory, quarantined[0]), "utf8"), corruptState);

  const started = runLauncher([
    "-Action", "Start",
    "-Root", appRoot,
    "-Port", "0",
    "-NoBrowser",
    "-StateDirectory", stateDirectory,
  ]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
});

test("Repair quarantines a directory occupying the instance-state path", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-repair-directory-state-"));
  const appRoot = path.join(temporaryRoot, "app");
  const stateDirectory = path.join(temporaryRoot, "state");
  const instancePath = path.join(stateDirectory, "instance.json");
  await mkdir(appRoot);
  await mkdir(stateDirectory);
  await mkdir(instancePath);
  await writeFile(path.join(instancePath, "preserved.txt"), "do not delete", "utf8");
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Repair directory state test</title>", "utf8");
  const repairPort = await getUnusedLoopbackPort();

  t.after(async () => {
    runLauncher(["-Action", "Stop", "-StateDirectory", stateDirectory], 5_000);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const repaired = runLauncher(["-Action", "Repair", "-Port", String(repairPort), "-StateDirectory", stateDirectory]);
  assert.equal(repaired.status, 0, `${repaired.stdout}\n${repaired.stderr}`);
  const quarantined = (await readdir(stateDirectory)).filter((name) => /^instance\.corrupt-[0-9]{8}T[0-9]{6}-[0-9a-f]{32}\.directory$/.test(name));
  assert.equal(quarantined.length, 1);
  assert.equal(await readFile(path.join(stateDirectory, quarantined[0], "preserved.txt"), "utf8"), "do not delete");

  const started = runLauncher([
    "-Action", "Start",
    "-Root", appRoot,
    "-Port", "0",
    "-NoBrowser",
    "-StateDirectory", stateDirectory,
  ]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
});

test("Repair bounds and quarantines an oversized corrupt instance-state file", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-repair-oversized-state-"));
  const stateDirectory = path.join(temporaryRoot, "state");
  const instancePath = path.join(stateDirectory, "instance.json");
  const oversizedState = "x".repeat(1024 * 1024);
  await mkdir(stateDirectory);
  await writeFile(instancePath, oversizedState, "utf8");
  const repairPort = await getUnusedLoopbackPort();

  t.after(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const repaired = runLauncher(["-Action", "Repair", "-Port", String(repairPort), "-StateDirectory", stateDirectory], 5_000);
  assert.equal(repaired.status, 0, `${repaired.stdout}\n${repaired.stderr}`);
  const quarantined = (await readdir(stateDirectory)).filter((name) => /^instance\.corrupt-[0-9]{8}T[0-9]{6}-[0-9a-f]{32}\.json$/.test(name));
  assert.equal(quarantined.length, 1);
  assert.equal((await readFile(path.join(stateDirectory, quarantined[0]))).byteLength, oversizedState.length);
});

test("Repair refuses to alter an authenticated running instance", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-repair-running-state-"));
  const appRoot = path.join(temporaryRoot, "app");
  const stateDirectory = path.join(temporaryRoot, "state");
  const instancePath = path.join(stateDirectory, "instance.json");
  await mkdir(appRoot);
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Repair running test</title>", "utf8");

  t.after(async () => {
    runLauncher(["-Action", "Stop", "-StateDirectory", stateDirectory], 5_000);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const started = runLauncher([
    "-Action", "Start",
    "-Root", appRoot,
    "-Port", "0",
    "-NoBrowser",
    "-StateDirectory", stateDirectory,
  ]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const originalState = await readFile(instancePath, "utf8");
  const runningPort = JSON.parse(originalState).port;

  const repaired = runLauncher(["-Action", "Repair", "-Port", String(runningPort), "-StateDirectory", stateDirectory]);
  assert.equal(repaired.status, 2, `${repaired.stdout}\n${repaired.stderr}`);
  assert.match(`${repaired.stdout}\n${repaired.stderr}`, /running|stop|refused/i);
  assert.equal(await readFile(instancePath, "utf8"), originalState);
});

test("Repair quarantines only a bound corrupt pending update before a clean restart", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-repair-corrupt-update-"));
  const appRoot = path.join(temporaryRoot, "app");
  const stateDirectory = path.join(temporaryRoot, "state");
  const updateDirectory = path.join(stateDirectory, "app-update");
  const pendingPath = path.join(updateDirectory, "pending.json");
  const portProbe = net.createServer();
  await new Promise((resolve, reject) => portProbe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const portAddress = portProbe.address();
  assert.ok(portAddress && typeof portAddress !== "string");
  const freePort = portAddress.port;
  await new Promise((resolve) => portProbe.close(resolve));
  const corruptPending = JSON.stringify({
    schemaVersion: 1,
    state: "READY_TO_RESTART",
    packageRoot: portableRoot,
    stateDirectory,
    port: freePort,
    brokerSha256: "not-a-valid-sha256",
    unexpected: true,
  });
  await mkdir(appRoot);
  await mkdir(updateDirectory, { recursive: true });
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Repair update state test</title>", "utf8");
  await writeFile(pendingPath, corruptPending, "utf8");

  t.after(async () => {
    runLauncher(["-Action", "Stop", "-StateDirectory", stateDirectory], 5_000);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const failedStart = runLauncher([
    "-Action", "Start",
    "-Root", appRoot,
    "-Port", "0",
    "-NoBrowser",
    "-StateDirectory", stateDirectory,
  ]);
  assert.equal(failedStart.status, 2, `${failedStart.stdout}\n${failedStart.stderr}`);
  assert.equal(await readFile(pendingPath, "utf8"), corruptPending);

  const repaired = runLauncher(["-Action", "Repair", "-Port", String(freePort), "-StateDirectory", stateDirectory]);
  assert.equal(repaired.status, 0, `${repaired.stdout}\n${repaired.stderr}`);
  assert.match(`${repaired.stdout}\n${repaired.stderr}`, /update.*quarantined|quarantined.*update/i);
  await assert.rejects(readFile(pendingPath, "utf8"), { code: "ENOENT" });
  const quarantined = (await readdir(stateDirectory)).filter((name) => /^app-update\.pending-corrupt-[0-9]{8}T[0-9]{6}-[0-9a-f]{32}\.json$/.test(name));
  assert.equal(quarantined.length, 1);
  assert.equal(await readFile(path.join(stateDirectory, quarantined[0]), "utf8"), corruptPending);

  const started = runLauncher([
    "-Action", "Start",
    "-Root", appRoot,
    "-Port", "0",
    "-NoBrowser",
    "-StateDirectory", stateDirectory,
  ]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
});

test("Repair preserves a corrupt pending update when any apply journal exists", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-repair-update-journal-"));
  const stateDirectory = path.join(temporaryRoot, "state");
  const updateDirectory = path.join(stateDirectory, "app-update");
  const pendingPath = path.join(updateDirectory, "pending.json");
  const journalPath = path.join(updateDirectory, "apply-journal.json");
  const corruptPending = JSON.stringify({ state: "CORRUPT", packageRoot: portableRoot, stateDirectory });
  const journal = "{not a valid journal";
  await mkdir(updateDirectory, { recursive: true });
  await writeFile(pendingPath, corruptPending, "utf8");
  await writeFile(journalPath, journal, "utf8");
  const repairPort = await getUnusedLoopbackPort();

  t.after(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const repaired = runLauncher(["-Action", "Repair", "-Port", String(repairPort), "-StateDirectory", stateDirectory]);
  assert.equal(repaired.status, 2, `${repaired.stdout}\n${repaired.stderr}`);
  assert.match(`${repaired.stdout}\n${repaired.stderr}`, /journal|transaction|refused|preserved/i);
  assert.equal(await readFile(pendingPath, "utf8"), corruptPending);
  assert.equal(await readFile(journalPath, "utf8"), journal);
  assert.equal((await readdir(stateDirectory)).some((name) => name.startsWith("app-update.pending-corrupt-")), false);
});

test("Repair preserves pending update evidence while a recorded update worker is alive", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-repair-live-worker-"));
  const stateDirectory = path.join(temporaryRoot, "state");
  const updateDirectory = path.join(stateDirectory, "app-update");
  const pendingPath = path.join(updateDirectory, "pending.json");
  const workerPath = path.join(updateDirectory, "worker.json");
  const corruptPending = JSON.stringify({ state: "CORRUPT", packageRoot: portableRoot, stateDirectory });
  await mkdir(updateDirectory, { recursive: true });
  await writeFile(pendingPath, corruptPending, "utf8");
  const repairPort = await getUnusedLoopbackPort();
  const worker = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"], {
    windowsHide: true,
    stdio: "ignore",
  });

  t.after(async () => {
    worker.kill();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  await waitFor(() => worker.pid && worker.exitCode === null, 5_000);
  const queried = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `(Get-Process -Id ${worker.pid}).StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)`,
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(queried.status, 0, queried.stderr);
  await writeFile(workerPath, JSON.stringify({
    protocolVersion: 1,
    pid: worker.pid,
    processStartTimeUtc: queried.stdout.trim(),
    operation: "STAGE",
  }), "utf8");

  const repaired = runLauncher(["-Action", "Repair", "-Port", String(repairPort), "-StateDirectory", stateDirectory]);
  assert.equal(repaired.status, 2, `${repaired.stdout}\n${repaired.stderr}`);
  assert.match(`${repaired.stdout}\n${repaired.stderr}`, /worker|update|refused|running/i);
  assert.equal(await readFile(pendingPath, "utf8"), corruptPending);
});

test("Repair refuses a reparse point at a dangerous update bookkeeping path", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-repair-update-reparse-"));
  const stateDirectory = path.join(temporaryRoot, "state");
  const updateDirectory = path.join(stateDirectory, "app-update");
  const pendingPath = path.join(updateDirectory, "pending.json");
  const reparseTarget = path.join(temporaryRoot, "reparse-target");
  await mkdir(updateDirectory, { recursive: true });
  await mkdir(reparseTarget);
  await writeFile(path.join(reparseTarget, "preserved.txt"), "do not alter", "utf8");
  await symlink(reparseTarget, pendingPath, "junction");
  const repairPort = await getUnusedLoopbackPort();

  t.after(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const repaired = runLauncher(["-Action", "Repair", "-Port", String(repairPort), "-StateDirectory", stateDirectory]);
  assert.equal(repaired.status, 2, `${repaired.stdout}\n${repaired.stderr}`);
  assert.match(`${repaired.stdout}\n${repaired.stderr}`, /reparse|unsafe|refused|preserved/i);
  assert.equal(await readFile(path.join(pendingPath, "preserved.txt"), "utf8"), "do not alter");
});

test("Repair preserves a bound corrupt pending update when its recorded loopback port is occupied", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-repair-update-port-"));
  const stateDirectory = path.join(temporaryRoot, "state");
  const updateDirectory = path.join(stateDirectory, "app-update");
  const pendingPath = path.join(updateDirectory, "pending.json");
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const corruptPending = JSON.stringify({ state: "CORRUPT", packageRoot: portableRoot, stateDirectory, port: address.port });
  await mkdir(updateDirectory, { recursive: true });
  await writeFile(pendingPath, corruptPending, "utf8");

  t.after(async () => {
    await new Promise((resolve) => listener.close(resolve));
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const repaired = runLauncher(["-Action", "Repair", "-Port", String(address.port), "-StateDirectory", stateDirectory]);
  assert.equal(repaired.status, 2, `${repaired.stdout}\n${repaired.stderr}`);
  assert.match(`${repaired.stdout}\n${repaired.stderr}`, /port|server|occupied|refused|preserved/i);
  assert.equal(await readFile(pendingPath, "utf8"), corruptPending);
});

test("Repair preserves instance identity when pending quarantine cannot complete", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-repair-atomic-update-"));
  const stateDirectory = path.join(temporaryRoot, "state");
  const updateDirectory = path.join(stateDirectory, "app-update");
  const instancePath = path.join(stateDirectory, "instance.json");
  const pendingPath = path.join(updateDirectory, "pending.json");
  const portProbe = net.createServer();
  await new Promise((resolve, reject) => portProbe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = portProbe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve) => portProbe.close(resolve));
  const corruptInstance = "{not valid instance json";
  const corruptPending = JSON.stringify({
    state: "CORRUPT",
    packageRoot: portableRoot,
    stateDirectory,
    port: address.port,
  });
  await mkdir(updateDirectory, { recursive: true });
  await writeFile(instancePath, corruptInstance, "utf8");
  await writeFile(pendingPath, corruptPending, "utf8");

  t.after(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const repaired = runLauncher(["-Action", "Repair", "-Port", String(address.port), "-StateDirectory", stateDirectory], 15_000, {
    env: { TARKOV_HELPER_UPDATE_TEST_FAIL_REPAIR_PENDING_MOVE: "1" },
  });
  assert.equal(repaired.status, 2, `${repaired.stdout}\n${repaired.stderr}`);
  assert.equal(await readFile(instancePath, "utf8"), corruptInstance);
  assert.equal(await readFile(pendingPath, "utf8"), corruptPending);
  assert.equal((await readdir(stateDirectory)).some((name) => name.startsWith("instance.corrupt-")), false);
});

test("Repair quarantines a plain directory blocking the cross-session update lock", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-repair-lock-directory-"));
  const appRoot = path.join(temporaryRoot, "app");
  const stateDirectory = path.join(temporaryRoot, "state");
  const lockPath = path.join(stateDirectory, "app-update.transaction.lock");
  await mkdir(appRoot);
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Repair lock directory test</title>", "utf8");
  await writeFile(path.join(lockPath, "preserved.txt"), "do not delete", "utf8");
  const repairPort = await getUnusedLoopbackPort();

  t.after(async () => {
    runLauncher(["-Action", "Stop", "-StateDirectory", stateDirectory], 5_000);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const repaired = runLauncher(["-Action", "Repair", "-Port", String(repairPort), "-StateDirectory", stateDirectory]);
  assert.equal(repaired.status, 0, `${repaired.stdout}\n${repaired.stderr}`);
  assert.match(`${repaired.stdout}\n${repaired.stderr}`, /lock|update|quarantined|recovery/i);
  const quarantined = (await readdir(stateDirectory)).filter((name) => /^app-update\.transaction-lock-corrupt-[0-9]{8}T[0-9]{6}-[0-9a-f]{32}\.directory$/.test(name));
  assert.equal(quarantined.length, 1);
  assert.equal(await readFile(path.join(stateDirectory, quarantined[0], "preserved.txt"), "utf8"), "do not delete");

  const started = runLauncher([
    "-Action", "Start",
    "-Root", appRoot,
    "-Port", "0",
    "-NoBrowser",
    "-StateDirectory", stateDirectory,
  ]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
});

test("Repair preserves corrupt instance state while its requested port is occupied outside the serve mutex", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-repair-cross-session-port-"));
  const stateDirectory = path.join(temporaryRoot, "state");
  const instancePath = path.join(stateDirectory, "instance.json");
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const corruptInstance = "{not valid instance json";
  await mkdir(stateDirectory);
  await writeFile(instancePath, corruptInstance, "utf8");

  t.after(async () => {
    await new Promise((resolve) => listener.close(resolve));
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const repaired = runLauncher(["-Action", "Repair", "-Port", String(address.port), "-StateDirectory", stateDirectory]);
  assert.equal(repaired.status, 2, `${repaired.stdout}\n${repaired.stderr}`);
  assert.match(`${repaired.stdout}\n${repaired.stderr}`, /port|server|occupied|refused|preserved/i);
  assert.equal(await readFile(instancePath, "utf8"), corruptInstance);
});

test("Serve refuses a second listener that would overwrite the same instance state", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-serve-singleton-"));
  const appRoot = path.join(temporaryRoot, "app");
  const stateDirectory = path.join(temporaryRoot, "state");
  const instancePath = path.join(stateDirectory, "instance.json");
  await mkdir(appRoot);
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Serve singleton test</title>", "utf8");

  let originalInstance;
  t.after(async () => {
    if (originalInstance) {
      const current = JSON.parse(await readFile(instancePath, "utf8").catch(() => "null"));
      if (current?.pid !== originalInstance.pid) {
        await writeFile(instancePath, JSON.stringify(originalInstance), "utf8");
      }
      runLauncher(["-Action", "Stop", "-StateDirectory", stateDirectory], 5_000);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const started = runLauncher([
    "-Action", "Start",
    "-Root", appRoot,
    "-Port", "0",
    "-NoBrowser",
    "-StateDirectory", stateDirectory,
  ]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  originalInstance = JSON.parse(await readFile(instancePath, "utf8"));

  const competing = runLauncher([
    "-Action", "Serve",
    "-Root", appRoot,
    "-Port", "0",
    "-NoBrowser",
    "-StateDirectory", stateDirectory,
  ], 3_000);
  assert.equal(competing.status, 2, `${competing.stdout}\n${competing.stderr}`);
  assert.deepEqual(JSON.parse(await readFile(instancePath, "utf8")), originalInstance);
});
