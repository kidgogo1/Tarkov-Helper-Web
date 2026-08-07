import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const portableRoot = path.join(projectRoot, "portable");
const launcherPath = path.join(portableRoot, "launcher.ps1");
const startVbsPath = path.join(portableRoot, "Tarkov Helper 실행.vbs");
const stopVbsPath = path.join(portableRoot, "Tarkov Helper 종료.vbs");
const diagnosticCommandPath = path.join(portableRoot, "문제 해결용 실행.cmd");

function runLauncher(arguments_, timeout = 15_000) {
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
    { encoding: "utf8", windowsHide: true, timeout },
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
  const [startVbs, stopVbs, diagnosticCommand, launcher] = await Promise.all([
    readFile(startVbsPath, "utf8"),
    readFile(stopVbsPath, "utf8"),
    readFile(diagnosticCommandPath, "utf8"),
    readFile(launcherPath, "utf8"),
  ]);

  assert.match(startVbs, /WScript\.Shell/i);
  assert.match(startVbs, /-Action Start/i);
  assert.match(startVbs, /\.Run\([\s\S]*,\s*0\s*,/i);
  assert.doesNotMatch(startVbs, /cmd\.exe/i);
  assert.match(stopVbs, /-Action Stop/i);
  assert.match(stopVbs, /\.Run\([\s\S]*,\s*0\s*,/i);
  assert.match(diagnosticCommand, /-Action Serve/i);
  assert.match(launcher, /Start-Process[\s\S]*-WindowStyle Hidden/i);
});

test("Start reuses one hidden server and Stop gracefully terminates only its recorded instance", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-lifecycle-"));
  const appRoot = path.join(temporaryRoot, "app");
  const screenshotFolder = path.join(temporaryRoot, "Screenshots");
  const stateDirectory = path.join(temporaryRoot, "state");
  const instancePath = path.join(stateDirectory, "instance.json");
  await mkdir(appRoot);
  await mkdir(screenshotFolder);
  await writeFile(path.join(appRoot, "index.html"), "<!doctype html><title>Lifecycle test</title>", "utf8");

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
    "-ScreenshotFolder", screenshotFolder,
    "-StateDirectory", stateDirectory,
  ];
  const started = runLauncher(["-Action", "Start", ...commonArguments]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);

  instance = JSON.parse(await readFile(instancePath, "utf8"));
  assert.equal(instance.protocolVersion, 1);
  assert.equal(Number.isInteger(instance.pid), true);
  assert.match(instance.controlToken, /^[A-Za-z0-9_-]{40,}$/);
  const baseUrl = `http://127.0.0.1:${instance.port}/`;
  const response = await fetch(new URL("api/v1/local-tracker/status", baseUrl));
  assert.equal(response.status, 200);

  const repeated = runLauncher(["-Action", "Start", ...commonArguments]);
  assert.equal(repeated.status, 0, `${repeated.stdout}\n${repeated.stderr}`);
  const repeatedInstance = JSON.parse(await readFile(instancePath, "utf8"));
  assert.equal(repeatedInstance.pid, instance.pid);
  assert.equal(repeatedInstance.controlToken, instance.controlToken);

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
