import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const launcherPath = path.join(projectRoot, "portable", "launcher.ps1");
const commandPath = path.join(projectRoot, "portable", "문제 해결용 실행.cmd");

test("portable Start allows slow machines to finish authenticated readiness", async () => {
  const launcher = await readFile(launcherPath, "utf8");
  assert.match(
    launcher,
    /\$deadline = \[DateTime\]::UtcNow\.AddSeconds\(30\)/,
    "Start readiness must allow Defender/slow-disk initialization to complete",
  );
});

test("portable Start archives a stale staged update from another completed installation", { skip: process.platform !== "win32" }, async (t) => {
  const temporaryParent = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-stale-update-"));
  const packageRoot = path.join(temporaryParent, "Tarkov Helper 바로 실행 v1.0.20");
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
  await writeFile(
    path.join(appUpdateDirectory, "pending.json"),
    JSON.stringify({
      schemaVersion: 1,
      state: "READY_TO_RESTART",
      candidateId: "b".repeat(40),
      packageRoot: path.join(temporaryParent, "old-install-v1.0.14"),
      stageRoot: path.join(temporaryParent, "old-stage"),
      stateDirectory,
      port: testPort,
      currentVersion: "1.0.19",
      currentCommit: "c".repeat(40),
      latestVersion: "1.0.20",
      latestCommit: "d".repeat(40),
      treeSha256: "e".repeat(64),
      fileCount: 1,
      unpackedBytes: 1,
      brokerSha256: "f".repeat(64),
      healthNonce: "g".repeat(40),
      stagedAt: "2026-01-01T00:00:00.0000000Z",
    }),
    "utf8",
  );

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
