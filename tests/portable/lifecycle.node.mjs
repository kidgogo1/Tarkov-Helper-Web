import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
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
    { cwd: options.cwd, encoding: "utf8", windowsHide: true, timeout },
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

test("double-click scripts start and stop the hidden broker without a console", async () => {
  const [startVbs, stopVbs, diagnosticCommand, launcher, updateBroker] = await Promise.all([
    readFile(startVbsPath, "utf8"),
    readFile(stopVbsPath, "utf8"),
    readFile(diagnosticCommandPath, "utf8"),
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
  assert.match(launcher, /Start-Process[\s\S]*-WindowStyle Hidden/i);
  const launcherStarts = launcher.match(/^\s*(?:\$\w+\s*=\s*)?Start-Process\b/gm) ?? [];
  const hiddenLauncherStarts = launcher.match(/^\s*(?:\$\w+\s*=\s*)?Start-Process\b[\s\S]{0,300}?-WindowStyle Hidden/gm) ?? [];
  assert.ok(launcherStarts.length >= 3, "expected the launcher, worker, and update handoff process starts");
  assert.equal(hiddenLauncherStarts.length, launcherStarts.length);
  assert.match(updateBroker, /Start-Process\b[\s\S]{0,300}?-WindowStyle Hidden/i);
  assert.equal((launcher.match(/Get-StateMutexName -Purpose "Control"/g) ?? []).length, 2);
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
