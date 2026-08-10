import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFile, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checksumText,
  collectFiles,
  createZipFromDirectory,
  sha256,
} from "../../scripts/release-utils.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const launcherPath = path.join(projectRoot, "portable", "launcher.ps1");
const workerPath = path.join(projectRoot, "portable", "app-update-worker.ps1");
const brokerPath = path.join(projectRoot, "portable", "app-update-broker.ps1");
const powershell = "powershell.exe";
const repository = "example-owner/example-repository";
const oldCommit = "1".repeat(40);
const newCommit = "2".repeat(40);

function digest(contents) {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function powerShellArguments(script, arguments_) {
  return [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", script,
    ...arguments_,
  ];
}

function runPowerShell(script, arguments_, options = {}) {
  return spawnSync(powershell, powerShellArguments(script, arguments_), {
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? 45_000,
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
  });
}

function runPowerShellAsync(script, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, powerShellArguments(script, arguments_), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`PowerShell timed out.\n${stdout}\n${stderr}`));
    }, options.timeout ?? 45_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function waitFor(read, accept, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await read().catch((error) => ({ pollError: error?.stack ?? String(error) }));
    if (accept(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for updater state. Latest: ${JSON.stringify(latest)}`);
}

async function getFreePort() {
  const blocked = new Set([
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
    103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512,
    513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
    1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
  ]);
  while (true) {
    const server = http.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    if (!blocked.has(port)) return port;
  }
}

function startReleaseServer() {
  const state = { assets: new Map(), delayedAssetIds: new Map(), release: null, requests: [] };
  const server = http.createServer((request, response) => {
    state.requests.push({ method: request.method, url: request.url });
    const send = (status, contents, contentType) => {
      const body = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
      response.writeHead(status, {
        "Content-Type": contentType,
        "Content-Length": body.length,
        Connection: "close",
      });
      response.end(body);
    };
    if (
      request.method === "GET" &&
      (request.url === `/repos/${repository}/releases/latest` || request.url === `/repos/${repository}/releases/101`)
    ) {
      send(200, `${JSON.stringify(state.release)}\n`, "application/json; charset=utf-8");
      return;
    }
    const match = new RegExp(`^/repos/${repository.replace("/", "\\/")}/releases/assets/(\\d+)$`).exec(request.url ?? "");
    if (request.method === "GET" && match && state.assets.has(Number(match[1]))) {
      const assetId = Number(match[1]);
      const contents = state.assets.get(assetId);
      const delayMilliseconds = state.delayedAssetIds.get(assetId);
      if (Number.isInteger(delayMilliseconds) && delayMilliseconds > 0) {
        const body = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
        const splitAt = Math.min(body.length, 1);
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": body.length,
          Connection: "close",
        });
        response.write(body.subarray(0, splitAt));
        setTimeout(() => response.end(body.subarray(splitAt)), delayMilliseconds);
        return;
      }
      send(200, contents, "application/octet-stream");
      return;
    }
    send(404, "not found", "text/plain; charset=utf-8");
  });
  return { server, state };
}

async function writeDirectPackage(root, { version, commit, updateConfig, extraFiles = [] }) {
  await mkdir(path.join(root, "app"), { recursive: true });
  await Promise.all([
    copyFile(launcherPath, path.join(root, "launcher.ps1")),
    copyFile(workerPath, path.join(root, "app-update-worker.ps1")),
    copyFile(brokerPath, path.join(root, "app-update-broker.ps1")),
  ]);
  await writeFile(path.join(root, "UPDATE_CONFIG.json"), `${JSON.stringify(updateConfig, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "app", "index.html"), `<!doctype html><title>Updater ${version}</title>`, "utf8");
  await writeFile(path.join(root, "app", "version.json"), `${JSON.stringify({
    schemaVersion: 1,
    product: "tarkov-helper-web",
    version,
    commit,
    updaterProtocolVersion: 1,
  }, null, 2)}\n`, "utf8");
  for (const [relative, contents] of extraFiles) {
    const filename = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, contents);
  }
  const appFiles = await collectFiles(path.join(root, "app"));
  const appBytes = appFiles.reduce((total, file) => total + file.size, 0);
  const appTreeSha256 = sha256(checksumText(appFiles));
  await writeFile(path.join(root, "PACKAGE_INFO.txt"), [
    "Tarkov Helper Web Direct Release",
    `Version: ${version}`,
    `Source commit: ${commit}`,
    "Updater protocol: 1",
    `App files: ${appFiles.length}`,
    `App bytes: ${appBytes}`,
    `App tree SHA-256: ${appTreeSha256}`,
    "Local URL: http://127.0.0.1:41753/",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "SHA256SUMS.txt"), checksumText(await collectFiles(root)), "utf8");
  return { appBytes, appFiles: appFiles.length, appTreeSha256 };
}

async function createUpdateFixture({
  tamperSignature = false,
  extraFiles = [],
  mutateArchive,
  mutateManifest,
  mutateRelease,
} = {}) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-public-update-"));
  const packageRoot = path.join(temporaryRoot, "Tarkov Helper Direct");
  const newPackageRoot = path.join(temporaryRoot, "new-package");
  const stateDirectory = path.join(temporaryRoot, "state");
  const archivePath = path.join(temporaryRoot, "tarkov-helper-web-direct-v1.1.0.zip");
  const { server, state } = startReleaseServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const releasePort = server.address().port;
  const releaseApi = `http://127.0.0.1:${releasePort}/repos/${repository}/releases/latest`;

  const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const publicKeySpkiPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const publicKeySpkiDer = keys.publicKey.export({ format: "der", type: "spki" });
  const keyId = `sha256:${sha256(publicKeySpkiDer)}`;
  const updateConfig = {
    schemaVersion: 1,
    updaterEnabled: true,
    protocolVersion: 1,
    repository,
    releaseApi,
    manifestAsset: "update-manifest-v1.json",
    signatureAsset: "update-manifest-v1.sig",
    requireImmutableRelease: true,
    signing: { algorithm: "RSA-SHA256", keyId, publicKeySpkiPem },
  };

  await writeDirectPackage(packageRoot, { version: "1.0.0", commit: oldCommit, updateConfig });
  const packageRecord = await writeDirectPackage(newPackageRoot, { version: "1.1.0", commit: newCommit, updateConfig, extraFiles });
  const archiveRoot = "Tarkov Helper Direct v1.1.0";
  await createZipFromDirectory({ directory: newPackageRoot, filename: archivePath, rootDirectory: archiveRoot });
  let archive = await readFile(archivePath);
  if (mutateArchive) archive = await mutateArchive(Buffer.from(archive));
  const unpackedFiles = await collectFiles(newPackageRoot);
  const unpacked = {
    fileCount: unpackedFiles.length,
    bytes: unpackedFiles.reduce((total, file) => total + file.size, 0),
    treeSha256: sha256(checksumText(unpackedFiles)),
  };
  const basicArtifact = (assetId, filename) => ({
    assetId,
    filename,
    format: "zip",
    bytes: 1,
    sha256: "a".repeat(64),
    rootDirectory: "unused",
    stripComponents: 1,
    unpacked: { fileCount: 1, bytes: 1, treeSha256: "b".repeat(64) },
  });
  const manifest = {
    schemaVersion: 1,
    product: "tarkov-helper-web",
    channel: "stable",
    repository,
    version: "1.1.0",
    tag: "v1.1.0",
    commit: newCommit,
    createdAt: "2026-08-09T00:00:00Z",
    releaseId: 101,
    updater: {
      protocolVersion: 1,
      configFile: "UPDATE_CONFIG.json",
      manifestAsset: "update-manifest-v1.json",
      signatureAsset: "update-manifest-v1.sig",
      requireImmutableRelease: true,
      signing: { algorithm: "RSA-SHA256", keyId },
    },
    artifacts: {
      direct: {
        assetId: 203,
        filename: path.basename(archivePath),
        format: "zip",
        bytes: archive.length,
        sha256: sha256(archive),
        rootDirectory: archiveRoot,
        stripComponents: 1,
        unpacked,
        package: {
          version: "1.1.0",
          sourceCommit: newCommit,
          updaterProtocolVersion: 1,
          appFiles: packageRecord.appFiles,
          appBytes: packageRecord.appBytes,
          appTreeSha256: packageRecord.appTreeSha256,
        },
      },
      static: basicArtifact(204, "static.zip"),
      source: { ...basicArtifact(205, "source.zip"), commit: newCommit },
    },
  };
  mutateManifest?.(manifest);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const signature = Buffer.from(sign("RSA-SHA256", manifestBytes, keys.privateKey));
  if (tamperSignature) signature[0] ^= 0xff;
  state.assets.set(201, manifestBytes);
  state.assets.set(202, signature);
  state.assets.set(203, archive);
  const asset = (id, name, contents) => ({
    id,
    name,
    state: "uploaded",
    size: contents.length,
    digest: digest(contents),
    url: `http://127.0.0.1:${releasePort}/repos/${repository}/releases/assets/${id}`,
  });
  state.release = {
    id: 101,
    draft: false,
    prerelease: false,
    immutable: true,
    tag_name: "v1.1.0",
    html_url: `https://github.com/${repository}/releases/tag/v1.1.0`,
    published_at: "2026-08-09T00:00:00Z",
    assets: [
      asset(201, "update-manifest-v1.json", manifestBytes),
      asset(202, "update-manifest-v1.sig", signature),
      asset(203, path.basename(archivePath), archive),
    ],
  };
  mutateRelease?.(state.release, { archive, manifestBytes, signature });
  return {
    archivePath,
    packageRoot,
    releaseServer: server,
    state,
    stateDirectory,
    temporaryRoot,
  };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function updateDiagnostics(stateDirectory) {
  const names = [
    "server.stdout.log",
    "server.stderr.log",
    "server.log",
    path.join("app-update", "status.json"),
    path.join("app-update", "worker.json"),
    path.join("app-update", "worker.stdout.log"),
    path.join("app-update", "worker.stderr.log"),
    path.join("app-update", "worker.log"),
    path.join("app-update", "broker.stdout.log"),
    path.join("app-update", "broker.stderr.log"),
    path.join("app-update", "broker.log"),
    path.join("app-update", "update-new.stdout.log"),
    path.join("app-update", "update-new.stderr.log"),
    path.join("app-update", "update-rollback.stdout.log"),
    path.join("app-update", "update-rollback.stderr.log"),
    path.join("app-update", "apply-journal.json"),
    path.join("app-update", "pending.json"),
    "instance.json",
  ];
  const records = [];
  for (const name of names) {
    records.push(`--- ${name}\n${await readFile(path.join(stateDirectory, name), "utf8").catch((error) => error.code)}`);
  }
  return records.join("\n");
}

async function prepareStagedFixture(fixture, port = 41753) {
  const common = [
    "-PackageRoot", fixture.packageRoot,
    "-StateDirectory", fixture.stateDirectory,
    "-Port", String(port),
    "-AllowTestHttpLoopback",
  ];
  const checked = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), ["-Action", "Check", ...common]);
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const available = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8"));
  assert.equal(available.state, "AVAILABLE", JSON.stringify(available));
  const staged = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), [
    "-Action", "Stage", ...common, "-CandidateId", available.candidateId,
  ], { timeout: 30_000 });
  assert.equal(staged.status, 0, `${staged.stdout}\n${staged.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const ready = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8"));
  assert.equal(ready.state, "READY_TO_RESTART", JSON.stringify(ready));
  return { available, ready };
}

async function runExternalBroker(fixture, port, options = {}) {
  const pendingPath = path.join(fixture.stateDirectory, "app-update", "pending.json");
  const pending = JSON.parse(await readFile(pendingPath, "utf8"));
  const trustedBroker = path.join(fixture.stateDirectory, "app-update", `broker-${pending.brokerSha256}.ps1`);
  return runPowerShellAsync(trustedBroker, [
    "-PlanPath", pendingPath,
    "-ExpectedPackageRoot", fixture.packageRoot,
    "-StateDirectory", fixture.stateDirectory,
    "-Port", String(port),
    "-SkipRunOnce",
  ], options);
}

async function ownedUpdateResidues(fixture) {
  const packageLeaf = path.basename(fixture.packageRoot);
  const stages = (await readdir(path.dirname(fixture.packageRoot)))
    .filter((name) => name.startsWith(`.${packageLeaf}.update-stage-`));
  const downloads = (await readdir(path.join(fixture.stateDirectory, "app-update")))
    .filter((name) => /^package-[A-Za-z0-9_-]{40,64}\.[0-9a-f]{32}\.zip$/.test(name));
  return { downloads, stages };
}

function replaceZipName(archive, from, to) {
  const source = Buffer.from(from, "utf8");
  const target = Buffer.from(to, "utf8");
  assert.equal(target.length, source.length, "ZIP filename mutations must preserve byte length");
  let count = 0;
  for (let offset = archive.indexOf(source); offset >= 0; offset = archive.indexOf(source, offset + source.length)) {
    target.copy(archive, offset);
    count += 1;
  }
  assert.equal(count, 2, `expected local and central ZIP names for ${from}`);
  return archive;
}

function mutateCentralEntry(archive, suffix, mutate) {
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  for (let offset = archive.indexOf(signature); offset >= 0; offset = archive.indexOf(signature, offset + 4)) {
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name.endsWith(suffix)) {
      mutate({ archive, centralOffset: offset, localOffset: archive.readUInt32LE(offset + 42), name });
      return archive;
    }
    offset += 46 + nameLength + extraLength + commentLength - 4;
  }
  throw new Error(`ZIP entry ending in ${suffix} was not found`);
}

test("portable updater exposes only the authenticated candidate API and hidden helpers", async () => {
  const [launcher, worker, broker] = await Promise.all([
    readFile(launcherPath, "utf8"),
    readFile(workerPath, "utf8"),
    readFile(brokerPath, "utf8"),
  ]);
  for (const route of ["session", "status", "check", "stage", "apply"]) assert.match(launcher, new RegExp(`/api/v1/app-update/${route}`));
  assert.match(launcher, /X-Tarkov-Update/i);
  assert.match(launcher, /Sec-Fetch-Site/i);
  assert.match(launcher, /app-update-worker\.ps1/);
  assert.match(launcher, /app-update-broker\.ps1/);
  assert.equal((launcher.match(/Start-Process/g) ?? []).length >= 3, true);
  assert.equal((launcher.match(/-WindowStyle Hidden/g) ?? []).length >= 3, true);
  assert.doesNotMatch(launcher, /candidateUrl|downloadUrl|manifestUrl/i);
  for (const script of [launcher, worker, broker]) assert.doesNotMatch(script, /\bGet-FileHash\b/);
  assert.match(worker, /RSA-SHA256/);
  assert.match(worker, /requireImmutableRelease/);
  assert.match(worker, /treeSha256/);
  assert.match(worker, /FileMode\]::CreateNew|FileMode\.CreateNew/);
  assert.match(launcher, /"-StartedAt", \$now/);
  assert.match(worker, /\[string\]\$StartedAt/);
  assert.match(worker, /\$startedAt = \$StartedAt/);
  assert.match(broker, /ROLLING_BACK/);
  assert.match(broker, /READY_TO_RESTART/);
});

test("authenticated API verifies, stages, and applies an immutable signed public release", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const env = {
    TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
    TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
  };
  let appPort;
  t.after(async () => {
    if (appPort) runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  appPort = await getFreePort();
  const started = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(appPort), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { cwd: fixture.packageRoot, env, timeout: 15_000 });
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const base = `http://127.0.0.1:${appPort}/`;

  const crossSite = await fetch(new URL("api/v1/app-update/session", base));
  assert.equal(crossSite.status, 403);
  const sessionResponse = await fetch(new URL("api/v1/app-update/session", base), { headers: { "Sec-Fetch-Site": "same-origin" } });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.protocolVersion, 1);
  assert.equal(session.capability, "PUBLIC_GITHUB_RELEASES");
  assert.equal(session.repository, repository);
  assert.match(session.token, /^[A-Za-z0-9_-]{40,64}$/);
  assert.deepEqual(session.status, { state: "IDLE", currentVersion: "1.0.0" });

  const wrongToken = await fetch(new URL("api/v1/app-update/status", base), {
    headers: { "Sec-Fetch-Site": "same-origin", "X-Tarkov-Update": "x".repeat(43) },
  });
  assert.equal(wrongToken.status, 403);
  const mutationHeaders = {
    "Content-Type": "application/json",
    Origin: base.slice(0, -1),
    "Sec-Fetch-Site": "same-origin",
    "X-Tarkov-Update": session.token,
  };
  const originalInstance = JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8"));
  const checkingResponse = await fetch(new URL("api/v1/app-update/check", base), {
    method: "POST",
    headers: mutationHeaders,
    body: "{}",
  });
  assert.equal(checkingResponse.status, 202);
  const checking = await checkingResponse.json();
  assert.equal(checking.status.state, "CHECKING");
  const statusHeaders = { "Sec-Fetch-Site": "same-origin", "X-Tarkov-Update": session.token };
  let available;
  try {
    available = await waitFor(async () => {
      const response = await fetch(new URL("api/v1/app-update/status", base), { headers: statusHeaders });
      assert.equal(response.status, 200);
      return (await response.json()).status;
    }, (status) => status?.state === "AVAILABLE" || status?.state === "ERROR", 3_000);
  } catch (error) {
    error.message += `\n${await updateDiagnostics(fixture.stateDirectory)}`;
    throw error;
  }
  assert.equal(available.state, "AVAILABLE", JSON.stringify(available));
  assert.deepEqual(Object.keys(available).sort(), [
    "candidateId", "currentVersion", "downloadBytes", "latestVersion", "publishedAt", "releasePageUrl", "state",
  ]);

  const applyBeforeReady = await fetch(new URL("api/v1/app-update/apply", base), {
    method: "POST", headers: mutationHeaders, body: JSON.stringify({ candidateId: available.candidateId }),
  });
  assert.equal(applyBeforeReady.status, 409);
  assert.equal((await applyBeforeReady.json()).error.code, "UPDATE_NOT_READY");
  assert.equal(JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8")).pid, originalInstance.pid);

  const malformedCheck = await fetch(new URL("api/v1/app-update/check", base), {
    method: "POST", headers: mutationHeaders, body: JSON.stringify({ extra: true }),
  });
  assert.equal(malformedCheck.status, 422);
  assert.equal((await malformedCheck.json()).error.code, "INVALID_REQUEST");
  const malformedStage = await fetch(new URL("api/v1/app-update/stage", base), {
    method: "POST", headers: mutationHeaders, body: "{}",
  });
  assert.equal(malformedStage.status, 422);
  assert.equal((await malformedStage.json()).error.code, "INVALID_REQUEST");
  const mismatchedCandidate = await fetch(new URL("api/v1/app-update/stage", base), {
    method: "POST", headers: mutationHeaders, body: JSON.stringify({ candidateId: "x".repeat(43) }),
  });
  assert.equal(mismatchedCandidate.status, 409);
  assert.equal((await mismatchedCandidate.json()).error.code, "CANDIDATE_MISMATCH");

  fixture.state.delayedAssetIds.set(203, 1_000);
  const stagingResponse = await fetch(new URL("api/v1/app-update/stage", base), {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ candidateId: available.candidateId }),
  });
  assert.equal(stagingResponse.status, 202);
  const initialDownloading = (await stagingResponse.clone().json()).status;
  assert.equal(initialDownloading.state, "DOWNLOADING");
  await waitFor(
    async () => JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "worker.json"), "utf8")),
    (worker) => worker?.operation === "STAGE",
    3_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  const downloadingResponse = await fetch(new URL("api/v1/app-update/status", base), { headers: statusHeaders });
  const workerDownloading = (await downloadingResponse.json()).status;
  assert.equal(workerDownloading.state, "DOWNLOADING", JSON.stringify(workerDownloading));
  assert.equal(workerDownloading.startedAt, initialDownloading.startedAt);
  const ready = await waitFor(async () => {
    const response = await fetch(new URL("api/v1/app-update/status", base), { headers: statusHeaders });
    return (await response.json()).status;
  }, (status) => status?.state === "READY_TO_RESTART" || status?.state === "ERROR", 20_000);
  assert.equal(ready.state, "READY_TO_RESTART", JSON.stringify(ready));
  assert.equal(ready.candidateId, available.candidateId);
  const malformedApply = await fetch(new URL("api/v1/app-update/apply", base), {
    method: "POST", headers: mutationHeaders, body: "{}",
  });
  assert.equal(malformedApply.status, 422);
  assert.equal((await malformedApply.json()).error.code, "INVALID_REQUEST");
  const mismatchedApply = await fetch(new URL("api/v1/app-update/apply", base), {
    method: "POST", headers: mutationHeaders, body: JSON.stringify({ candidateId: "z".repeat(43) }),
  });
  assert.equal(mismatchedApply.status, 409);
  assert.equal((await mismatchedApply.json()).error.code, "CANDIDATE_MISMATCH");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const readyRecheck = await fetch(new URL("api/v1/app-update/check", base), {
      method: "POST", headers: mutationHeaders, body: "{}",
    });
    assert.equal(readyRecheck.status, 409);
    assert.equal((await readyRecheck.json()).error.code, "UPDATE_READY");
  }

  const applyResponse = await fetch(new URL("api/v1/app-update/apply", base), {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ candidateId: available.candidateId }),
  });
  assert.equal(applyResponse.status, 202, `${await applyResponse.clone().text()}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const applying = (await applyResponse.json()).status;
  assert.equal(applying.state, "APPLYING");
  assert.equal(applying.currentVersion, "1.0.0");
  assert.equal(applying.latestVersion, "1.1.0");
  assert.match(applying.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  const replacementSession = await waitFor(async () => {
    const response = await fetch(new URL("api/v1/app-update/session", base), {
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    if (!response.ok) return null;
    return response.json();
  }, (value) => value?.status?.state === "UPDATED" && value?.status?.currentVersion === "1.1.0", 60_000);
  assert.equal(replacementSession.status.currentVersion, "1.1.0");
  assert.notEqual(replacementSession.token, session.token);
  const replacementInstance = JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8"));
  assert.notEqual(replacementInstance.pid, originalInstance.pid);
  assert.equal(replacementInstance.port, appPort);
  const version = JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8"));
  assert.equal(version.version, "1.1.0");
  const backupRoot = path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-backup`);
  assert.equal(JSON.parse(await readFile(path.join(backupRoot, "app", "version.json"), "utf8")).version, "1.0.0");
  const finalStatus = await waitFor(
    async () => JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8")),
    (value) => value?.state === "UPDATED" || value?.state === "ERROR",
    10_000,
  );
  assert.equal(finalStatus.state, "UPDATED");
  assert.equal(finalStatus.currentVersion, "1.1.0");
  assert.equal((await stat(path.join(fixture.stateDirectory, "instance.json"))).isFile(), true);
});

test("live apply rejects a changed trusted broker without stopping the running server", { skip: process.platform !== "win32", timeout: 60_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = {
    TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
    TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
  };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const started = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 15_000 });
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const { ready } = await prepareStagedFixture(fixture, port);
  const base = `http://127.0.0.1:${port}/`;
  const session = await (await fetch(new URL("api/v1/app-update/session", base), {
    headers: { "Sec-Fetch-Site": "same-origin" },
  })).json();
  const originalInstance = JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8"));
  await appendFile(path.join(fixture.packageRoot, "app-update-broker.ps1"), "\n# changed after staging\n", "utf8");

  const response = await fetch(new URL("api/v1/app-update/apply", base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: base.slice(0, -1),
      "Sec-Fetch-Site": "same-origin",
      "X-Tarkov-Update": session.token,
    },
    body: JSON.stringify({ candidateId: ready.candidateId }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "UPDATE_INVALID");
  const currentInstance = JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8"));
  assert.equal(currentInstance.pid, originalInstance.pid);
  assert.equal((await fetch(base)).status, 200);
});

test("live apply keeps the old server running when the durable handoff cannot start", { skip: process.platform !== "win32", timeout: 60_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = {
    TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
    TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
    TARKOV_HELPER_UPDATE_TEST_FAIL_HANDOFF_START: "1",
  };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const started = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 15_000 });
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const { ready } = await prepareStagedFixture(fixture, port);
  const base = `http://127.0.0.1:${port}/`;
  const session = await (await fetch(new URL("api/v1/app-update/session", base), {
    headers: { "Sec-Fetch-Site": "same-origin" },
  })).json();
  const originalInstance = JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8"));

  const response = await fetch(new URL("api/v1/app-update/apply", base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: base.slice(0, -1),
      "Sec-Fetch-Site": "same-origin",
      "X-Tarkov-Update": session.token,
    },
    body: JSON.stringify({ candidateId: ready.candidateId }),
  });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, "UPDATE_HANDOFF_FAILED");

  const currentInstance = JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8"));
  assert.equal(currentInstance.pid, originalInstance.pid);
  assert.equal(currentInstance.processStartTimeUtc, originalInstance.processStartTimeUtc);
  assert.equal((await fetch(base)).status, 200);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.0.0");
  assert.equal(JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8")).state, "READY_TO_RESTART");
  assert.equal(JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "pending.json"), "utf8")).candidateId, ready.candidateId);
});

test("live apply cancels the acknowledged helper before recovering from a response-write failure", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = {
    TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
    TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
    TARKOV_HELPER_UPDATE_TEST_FAIL_APPLY_RESPONSE: "1",
    TARKOV_HELPER_UPDATE_TEST_FAIL_HANDOFF_KILL: "1",
  };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const started = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 15_000 });
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const { ready } = await prepareStagedFixture(fixture, port);
  const base = `http://127.0.0.1:${port}/`;
  const session = await (await fetch(new URL("api/v1/app-update/session", base), {
    headers: { "Sec-Fetch-Site": "same-origin" },
  })).json();
  const originalInstance = JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8"));

  const response = await fetch(new URL("api/v1/app-update/apply", base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: base.slice(0, -1),
      "Sec-Fetch-Site": "same-origin",
      "X-Tarkov-Update": session.token,
    },
    body: JSON.stringify({ candidateId: ready.candidateId }),
  });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, "UPDATE_HANDOFF_CANCELLED");
  const currentInstance = JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8"));
  assert.equal(currentInstance.pid, originalInstance.pid);
  assert.equal(currentInstance.processStartTimeUtc, originalInstance.processStartTimeUtc);
  assert.equal((await fetch(base)).status, 200);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.0.0");
  assert.equal(JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8")).state, "READY_TO_RESTART");
  assert.equal(JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "pending.json"), "utf8")).candidateId, ready.candidateId);

  const stopped = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.0.0");
  assert.equal(JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "pending.json"), "utf8")).candidateId, ready.candidateId);
});

test("live apply gives a verified large-tree handoff a size-aware acknowledgement budget", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = {
    TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
    TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
    TARKOV_HELPER_UPDATE_TEST_HANDOFF_VERIFY_DELAY_MS: "11000",
  };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const started = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 15_000 });
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const { ready } = await prepareStagedFixture(fixture, port);
  const base = `http://127.0.0.1:${port}/`;
  const session = await (await fetch(new URL("api/v1/app-update/session", base), {
    headers: { "Sec-Fetch-Site": "same-origin" },
  })).json();
  const response = await fetch(new URL("api/v1/app-update/apply", base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: base.slice(0, -1),
      "Sec-Fetch-Site": "same-origin",
      "X-Tarkov-Update": session.token,
    },
    body: JSON.stringify({ candidateId: ready.candidateId }),
  });
  assert.equal(response.status, 202, `${await response.clone().text()}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const replacement = await waitFor(async () => {
    const result = await fetch(new URL("api/v1/app-update/session", base), {
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    if (!result.ok) return null;
    return result.json();
  }, (value) => value?.status?.state === "UPDATED", 60_000);
  assert.equal(replacement.status.currentVersion, "1.1.0");
});

test("live apply does not lose an acknowledged handoff when best-effort ACK cleanup fails", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = {
    TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
    TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
    TARKOV_HELPER_UPDATE_TEST_FAIL_HANDOFF_ACK_DELETE: "1",
  };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const started = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 15_000 });
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const { ready } = await prepareStagedFixture(fixture, port);
  const base = `http://127.0.0.1:${port}/`;
  const session = await (await fetch(new URL("api/v1/app-update/session", base), {
    headers: { "Sec-Fetch-Site": "same-origin" },
  })).json();
  const response = await fetch(new URL("api/v1/app-update/apply", base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: base.slice(0, -1),
      "Sec-Fetch-Site": "same-origin",
      "X-Tarkov-Update": session.token,
    },
    body: JSON.stringify({ candidateId: ready.candidateId }),
  });
  assert.equal(response.status, 202, `${await response.clone().text()}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const replacement = await waitFor(async () => {
    const result = await fetch(new URL("api/v1/app-update/session", base), {
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    if (!result.ok) return null;
    return result.json();
  }, (value) => value?.status?.state === "UPDATED", 60_000);
  assert.equal(replacement.status.currentVersion, "1.1.0");
});

test("an update replacement with no first client lease shuts down after its handoff grace period", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = {
    TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
    TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
    TARKOV_HELPER_UPDATE_TEST_FIRST_CLIENT_DEADLINE_MS: "1500",
  };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const started = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 15_000 });
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const { ready } = await prepareStagedFixture(fixture, port);
  const base = `http://127.0.0.1:${port}/`;
  const session = await (await fetch(new URL("api/v1/app-update/session", base), {
    headers: { "Sec-Fetch-Site": "same-origin" },
  })).json();
  const response = await fetch(new URL("api/v1/app-update/apply", base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: base.slice(0, -1),
      "Sec-Fetch-Site": "same-origin",
      "X-Tarkov-Update": session.token,
    },
    body: JSON.stringify({ candidateId: ready.candidateId }),
  });
  assert.equal(response.status, 202, `${await response.clone().text()}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const finalStatus = await waitFor(
    async () => JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8")),
    (value) => value?.state === "UPDATED" || value?.state === "ERROR",
    60_000,
  );
  assert.equal(finalStatus.state, "UPDATED", await updateDiagnostics(fixture.stateDirectory));
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
  const instanceState = await waitFor(async () => {
    try {
      return JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8"));
    } catch (error) {
      return { errorCode: error?.code };
    }
  }, (value) => value?.errorCode === "ENOENT", 8_000);
  assert.equal(instanceState.errorCode, "ENOENT");
});

test("an update replacement keeps its existing last-tab close semantics after the first lease", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = {
    TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
    TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
    TARKOV_HELPER_UPDATE_TEST_FIRST_CLIENT_DEADLINE_MS: "3000",
  };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const started = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 15_000 });
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const { ready } = await prepareStagedFixture(fixture, port);
  const base = `http://127.0.0.1:${port}/`;
  const updateSession = await (await fetch(new URL("api/v1/app-update/session", base), {
    headers: { "Sec-Fetch-Site": "same-origin" },
  })).json();
  const applyResponse = await fetch(new URL("api/v1/app-update/apply", base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: base.slice(0, -1),
      "Sec-Fetch-Site": "same-origin",
      "X-Tarkov-Update": updateSession.token,
    },
    body: JSON.stringify({ candidateId: ready.candidateId }),
  });
  assert.equal(applyResponse.status, 202, `${await applyResponse.clone().text()}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const clientSession = await waitFor(async () => {
    const result = await fetch(new URL("api/v1/client/session", base));
    if (!result.ok) return null;
    return result.json();
  }, (value) => typeof value?.leaseToken === "string", 60_000);
  await new Promise((resolve) => setTimeout(resolve, 3500));
  assert.equal((await fetch(base)).status, 200, "the first lease must permanently disarm the one-shot handoff deadline");
  const closeResponse = await fetch(new URL("api/v1/client/close", base), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base.slice(0, -1) },
    body: JSON.stringify({ leaseToken: clientSession.leaseToken }),
  });
  assert.equal(closeResponse.status, 204);
  const instanceState = await waitFor(async () => {
    try {
      return JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8"));
    } catch (error) {
      return { errorCode: error?.code };
    }
  }, (value) => value?.errorCode === "ENOENT", 8_000);
  assert.equal(instanceState.errorCode, "ENOENT");
});

test("a rollback replacement with no first client lease also shuts down after its handoff grace period", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = {
    TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
    TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
    TARKOV_HELPER_UPDATE_TEST_FAIL_HEALTH: "1",
    TARKOV_HELPER_UPDATE_TEST_FIRST_CLIENT_DEADLINE_MS: "1500",
  };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const started = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 15_000 });
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const { ready } = await prepareStagedFixture(fixture, port);
  const base = `http://127.0.0.1:${port}/`;
  const session = await (await fetch(new URL("api/v1/app-update/session", base), {
    headers: { "Sec-Fetch-Site": "same-origin" },
  })).json();
  const response = await fetch(new URL("api/v1/app-update/apply", base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: base.slice(0, -1),
      "Sec-Fetch-Site": "same-origin",
      "X-Tarkov-Update": session.token,
    },
    body: JSON.stringify({ candidateId: ready.candidateId }),
  });
  assert.equal(response.status, 202, `${await response.clone().text()}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const finalStatus = await waitFor(
    async () => JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8")),
    (value) => value?.state === "ERROR",
    60_000,
  );
  assert.equal(finalStatus.currentVersion, "1.0.0");
  assert.equal(finalStatus.code, "APPLY_FAILED", await updateDiagnostics(fixture.stateDirectory));
  const instanceState = await waitFor(async () => {
    try {
      return JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8"));
    } catch (error) {
      return { errorCode: error?.code };
    }
  }, (value) => value?.errorCode === "ENOENT", 8_000);
  assert.equal(instanceState.errorCode, "ENOENT");
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.0.0");
});

test("live apply health failure automatically restores the old server on the same port", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = {
    TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
    TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
    TARKOV_HELPER_UPDATE_TEST_FAIL_HEALTH: "1",
  };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const started = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 15_000 });
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const { ready } = await prepareStagedFixture(fixture, port);
  const base = `http://127.0.0.1:${port}/`;
  const session = await (await fetch(new URL("api/v1/app-update/session", base), {
    headers: { "Sec-Fetch-Site": "same-origin" },
  })).json();
  const response = await fetch(new URL("api/v1/app-update/apply", base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: base.slice(0, -1),
      "Sec-Fetch-Site": "same-origin",
      "X-Tarkov-Update": session.token,
    },
    body: JSON.stringify({ candidateId: ready.candidateId }),
  });
  assert.equal(response.status, 202, `${await response.clone().text()}\n${await updateDiagnostics(fixture.stateDirectory)}`);

  const restored = await waitFor(async () => {
    const result = await fetch(new URL("api/v1/app-update/session", base), {
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    if (!result.ok) return null;
    return result.json();
  }, (value) => value?.status?.state === "ERROR", 60_000);
  assert.equal(restored.status.currentVersion, "1.0.0");
  assert.equal(restored.status.operation, "APPLY");
  assert.equal(restored.status.code, "APPLY_FAILED");
  assert.notEqual(restored.token, session.token);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.0.0");
  assert.equal(JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8")).port, port);
});

test("worker fails closed on a tampered detached manifest signature", { skip: process.platform !== "win32", timeout: 60_000 }, async (t) => {
  const fixture = await createUpdateFixture({ tamperSignature: true });
  t.after(async () => {
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });
  const result = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), [
    "-Action", "Check", "-PackageRoot", fixture.packageRoot, "-StateDirectory", fixture.stateDirectory, "-Port", "41753", "-AllowTestHttpLoopback",
  ]);
  assert.equal(result.status, 4, `${result.stdout}\n${result.stderr}`);
  const status = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8"));
  assert.deepEqual(status, {
    state: "ERROR",
    currentVersion: "1.0.0",
    operation: "CHECK",
    code: "SIGNATURE_INVALID",
    message: "The downloaded update could not be authenticated.",
  });
  await assert.rejects(readFile(path.join(fixture.stateDirectory, "app-update", "candidate.json")), { code: "ENOENT" });
});

test("worker accepts the exact signed immutable-release fixture", { skip: process.platform !== "win32", timeout: 60_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  t.after(async () => {
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });
  const result = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), [
    "-Action", "Check", "-PackageRoot", fixture.packageRoot, "-StateDirectory", fixture.stateDirectory, "-Port", "41753", "-AllowTestHttpLoopback",
  ]);
  const status = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8"));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(status.state, "AVAILABLE", `${JSON.stringify(status)}\n${await updateDiagnostics(fixture.stateDirectory)}`);
});

test("release trust binding rejects mutable metadata and identity or digest drift", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const cases = [
    ["mutable", { mutateRelease: (release) => { release.immutable = false; } }],
    ["draft", { mutateRelease: (release) => { release.draft = true; } }],
    ["prerelease", { mutateRelease: (release) => { release.prerelease = true; } }],
    ["release id", { mutateManifest: (manifest) => { manifest.releaseId = 102; } }],
    ["asset id", { mutateManifest: (manifest) => { manifest.artifacts.direct.assetId = 999; } }],
    ["asset digest", { mutateRelease: (release) => { release.assets[2].digest = `sha256:${"0".repeat(64)}`; } }],
  ];
  for (const [label, options] of cases) {
    await t.test(label, async () => {
      const fixture = await createUpdateFixture(options);
      try {
        const result = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), [
          "-Action", "Check", "-PackageRoot", fixture.packageRoot, "-StateDirectory", fixture.stateDirectory,
          "-Port", "41753", "-AllowTestHttpLoopback",
        ]);
        assert.notEqual(result.status, 0, `${label} unexpectedly passed\n${result.stdout}\n${result.stderr}`);
        const status = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8"));
        assert.equal(status.state, "ERROR", `${label}: ${JSON.stringify(status)}`);
        await assert.rejects(readFile(path.join(fixture.stateDirectory, "app-update", "candidate.json")), { code: "ENOENT" });
      } finally {
        await closeServer(fixture.releaseServer);
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      }
    });
  }
});

test("stage revalidates the exact reviewed immutable candidate before download", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const fixture = await createUpdateFixture();
  try {
    const checked = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), [
      "-Action", "Check", "-PackageRoot", fixture.packageRoot, "-StateDirectory", fixture.stateDirectory,
      "-Port", "41753", "-AllowTestHttpLoopback",
    ]);
    assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
    const available = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8"));
    fixture.state.release.assets[2].digest = `sha256:${"f".repeat(64)}`;
    const requestCountBeforeStage = fixture.state.requests.length;
    const staged = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), [
      "-Action", "Stage", "-PackageRoot", fixture.packageRoot, "-StateDirectory", fixture.stateDirectory,
      "-Port", "41753", "-CandidateId", available.candidateId, "-AllowTestHttpLoopback",
    ]);
    assert.notEqual(staged.status, 0, `${staged.stdout}\n${staged.stderr}`);
    const laterRequests = fixture.state.requests.slice(requestCountBeforeStage).map((request) => request.url);
    assert.equal(laterRequests.some((url) => url?.endsWith("/releases/assets/203")), false, "drifted candidate must fail before package download");
    assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.0.0");
    await assert.rejects(readFile(path.join(fixture.stateDirectory, "app-update", "pending.json")), { code: "ENOENT" });
  } finally {
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("restricted ZIP preflight rejects unsafe Windows paths, reparse entries, collisions, and bombs", { skip: process.platform !== "win32", timeout: 120_000 }, async (t) => {
  const cases = [
    ["traversal", {
      extraFiles: [["safe/path.txt", "unsafe traversal fixture"]],
      mutateArchive: (archive) => replaceZipName(archive, "safe/path.txt", "../x/path.txt"),
    }],
    ["alternate data stream", {
      extraFiles: [["safe_file.txt", "unsafe ADS fixture"]],
      mutateArchive: (archive) => replaceZipName(archive, "safe_file.txt", "safe:file.txt"),
    }],
    ["superscript reserved device", {
      extraFiles: [["safe1.txt", "unsafe reserved fixture"]],
      mutateArchive: (archive) => replaceZipName(archive, "safe1.txt", "COM¹.txt"),
    }],
    ["case collision", {
      extraFiles: [["casea.txt", "first"], ["caseb.txt", "second"]],
      mutateArchive: (archive) => replaceZipName(archive, "caseb.txt", "CASEA.txt"),
    }],
    ["reparse entry", {
      extraFiles: [["link.txt", "not really a link"]],
      mutateArchive: (archive) => mutateCentralEntry(archive, "/link.txt", ({ archive: bytes, centralOffset }) => {
        bytes.writeUInt32LE(0xa1ff0000, centralOffset + 38);
      }),
    }],
    ["declared expansion bomb", {
      extraFiles: [["bomb.txt", "small compressed body"]],
      mutateArchive: (archive) => mutateCentralEntry(archive, "/bomb.txt", ({ archive: bytes, centralOffset, localOffset }) => {
        bytes.writeUInt32LE(300 * 1024 * 1024, centralOffset + 24);
        bytes.writeUInt32LE(300 * 1024 * 1024, localOffset + 22);
      }),
    }],
  ];
  for (const [label, options] of cases) {
    await t.test(label, async () => {
      const fixture = await createUpdateFixture(options);
      try {
        const checked = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), [
          "-Action", "Check", "-PackageRoot", fixture.packageRoot, "-StateDirectory", fixture.stateDirectory,
          "-Port", "41753", "-AllowTestHttpLoopback",
        ]);
        assert.equal(checked.status, 0, `${label} check failed before ZIP preflight\n${checked.stdout}\n${checked.stderr}`);
        const available = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8"));
        const staged = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), [
          "-Action", "Stage", "-PackageRoot", fixture.packageRoot, "-StateDirectory", fixture.stateDirectory,
          "-Port", "41753", "-CandidateId", available.candidateId, "-AllowTestHttpLoopback",
        ], { timeout: 30_000 });
        assert.equal(staged.status, 8, `${label} ZIP unexpectedly staged\n${staged.stdout}\n${staged.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
        const status = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8"));
        assert.equal(status.code, "INVALID_PACKAGE", `${label}: ${JSON.stringify(status)}`);
        assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.0.0");
        await assert.rejects(readFile(path.join(fixture.stateDirectory, "app-update", "pending.json")), { code: "ENOENT" });
        const residue = (await readdir(fixture.temporaryRoot)).filter((name) => name.includes(".update-stage-"));
        assert.deepEqual(residue, [], `${label} left staging residue: ${residue.join(", ")}`);
      } finally {
        await closeServer(fixture.releaseServer);
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      }
    });
  }
});

test("the next exclusive worker scavenges hard-crash download and extraction residues", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  for (const phase of ["DOWNLOAD", "EXTRACTED"]) {
    await t.test(phase, async () => {
      const fixture = await createUpdateFixture();
      const port = await getFreePort();
      const common = [
        "-PackageRoot", fixture.packageRoot,
        "-StateDirectory", fixture.stateDirectory,
        "-Port", String(port),
        "-AllowTestHttpLoopback",
      ];
      try {
        const checked = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), ["-Action", "Check", ...common]);
        assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
        const available = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8"));
        const crashed = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), [
          "-Action", "Stage", ...common, "-CandidateId", available.candidateId,
        ], {
          env: { TARKOV_HELPER_UPDATE_TEST_STAGE_CRASH_PHASE: phase },
          timeout: 30_000,
        });
        assert.equal(crashed.status, 98, `${phase}\n${crashed.stdout}\n${crashed.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
        const dirty = await ownedUpdateResidues(fixture);
        assert.equal(dirty.stages.length, 1, `${phase} must leave one interrupted sibling stage`);
        assert.equal(dirty.downloads.length, 1, `${phase} must leave one interrupted archive`);

        const restarted = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), ["-Action", "Check", ...common]);
        assert.equal(restarted.status, 0, `${phase}\n${restarted.stdout}\n${restarted.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
        assert.deepEqual(await ownedUpdateResidues(fixture), { downloads: [], stages: [] });
      } finally {
        await closeServer(fixture.releaseServer);
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      }
    });
  }
});

test("health failure rolls back safely and a fresh candidate can later apply", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const baseEnv = {
    TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
    TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
  };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env: baseEnv, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  await mkdir(fixture.stateDirectory, { recursive: true });
  const stateMarker = path.join(fixture.stateDirectory, "local-storage-origin.marker");
  await writeFile(stateMarker, "origin state survives package swaps\n", "utf8");
  await prepareStagedFixture(fixture, port);
  const failed = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env: { ...baseEnv, TARKOV_HELPER_UPDATE_TEST_FAIL_HEALTH: "1" }, timeout: 40_000 });
  assert.equal(failed.status, 2, `${failed.stdout}\n${failed.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.0.0");
  const rollbackStatus = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8"));
  assert.equal(rollbackStatus.state, "ERROR");
  assert.equal(rollbackStatus.code, "APPLY_FAILED", await updateDiagnostics(fixture.stateDirectory));
  await assert.rejects(readFile(path.join(fixture.stateDirectory, "app-update", "pending.json")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(fixture.stateDirectory, "app-update", "candidate.json")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(fixture.stateDirectory, "app-update", "apply-journal.json")), { code: "ENOENT" });
  assert.deepEqual((await readdir(fixture.temporaryRoot)).filter((name) => name.includes(".update-failed-")), []);
  assert.equal((await readFile(stateMarker, "utf8")).trim(), "origin state survives package swaps");

  await prepareStagedFixture(fixture, port);
  let stopped = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env: baseEnv });
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
  const failedAgain = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env: { ...baseEnv, TARKOV_HELPER_UPDATE_TEST_FAIL_HEALTH: "1" }, timeout: 40_000 });
  assert.equal(failedAgain.status, 2, `${failedAgain.stdout}\n${failedAgain.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.deepEqual((await readdir(fixture.temporaryRoot)).filter((name) => name.includes(".update-failed-")), [], "repeated failures must not accumulate package trees");

  await prepareStagedFixture(fixture, port);
  stopped = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env: baseEnv });
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
  const retried = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env: baseEnv, timeout: 40_000 });
  assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
  const instance = JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8"));
  assert.equal(instance.port, port, "the browser origin port must survive update and rollback");
  assert.equal((await readFile(stateMarker, "utf8")).trim(), "origin state survives package swaps");
});

test("a stale rollback backup from an older transaction is replaced before a fresh apply", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
  const backupRoot = path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-backup`);
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  await cp(fixture.packageRoot, backupRoot, { recursive: true });
  await writeFile(path.join(backupRoot, "app", "version.json"), `${JSON.stringify({
    schemaVersion: 1,
    product: "tarkov-helper-web",
    version: "0.9.0",
    commit: "9".repeat(40),
    updaterProtocolVersion: 1,
  }, null, 2)}\n`, "utf8");
  await prepareStagedFixture(fixture, port);

  const applied = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 40_000 });
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
  assert.equal(JSON.parse(await readFile(path.join(backupRoot, "app", "version.json"), "utf8")).version, "1.0.0");
});

test("pending update is bound to the staged browser-origin port", { skip: process.platform !== "win32", timeout: 60_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const stagedPort = await getFreePort();
  let otherPort = await getFreePort();
  while (otherPort === stagedPort) otherPort = await getFreePort();
  const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });
  await prepareStagedFixture(fixture, stagedPort);
  const mismatched = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(otherPort), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 15_000 });
  assert.equal(mismatched.status, 2, `${mismatched.stdout}\n${mismatched.stderr}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.0.0");
  assert.equal(JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "pending.json"), "utf8")).port, stagedPort);

  const applied = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(stagedPort), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 40_000 });
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8")).port, stagedPort);
});

test("disabled updater exposes a disabled session and rejects mutations", { skip: process.platform !== "win32", timeout: 30_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
  await writeFile(path.join(fixture.packageRoot, "UPDATE_CONFIG.json"), `${JSON.stringify({
    schemaVersion: 1, updaterEnabled: false, protocolVersion: 1,
  }, null, 2)}\n`, "utf8");
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });
  const started = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 15_000 });
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const base = `http://127.0.0.1:${port}`;
  const response = await fetch(`${base}/api/v1/app-update/session`, { headers: { "Sec-Fetch-Site": "same-origin" } });
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.equal(session.repository, null);
  assert.deepEqual(session.status, { state: "DISABLED", currentVersion: "1.0.0", reason: "NOT_CONFIGURED" });
  const mutation = await fetch(`${base}/api/v1/app-update/check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: base,
      "Sec-Fetch-Site": "same-origin",
      "X-Tarkov-Update": session.token,
    },
    body: "{}",
  });
  assert.equal(mutation.status, 409);
  assert.equal((await mutation.json()).error.code, "NOT_CONFIGURED");
});

test("external broker recovers every durable apply phase idempotently", { skip: process.platform !== "win32", timeout: 180_000 }, async (t) => {
  const phases = ["PREPARED", "OLD_MOVED", "NEW_MOVED", "NEW_STARTED", "HEALTHY", "COMMITTED"];
  for (const phase of phases) {
    await t.test(phase, async () => {
      const fixture = await createUpdateFixture();
      const port = await getFreePort();
      const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
      try {
        await prepareStagedFixture(fixture, port);
        const interrupted = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
          "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
        ], { env: { ...env, TARKOV_HELPER_UPDATE_TEST_CRASH_PHASE: phase }, timeout: 30_000 });
        assert.equal(interrupted.status, 2, `${phase}\n${interrupted.stdout}\n${interrupted.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
        const journal = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "apply-journal.json"), "utf8"));
        assert.equal(journal.phase, phase);
        if (phase === "COMMITTED") {
          // Model a power loss after terminal journal cleanup but before the
          // last transaction trigger (pending.json) is removed.
          await rm(path.join(fixture.stateDirectory, "app-update", "apply-journal.json"));
        }

        const recovered = await runExternalBroker(fixture, port, { timeout: 40_000 });
        assert.equal(recovered.status, 0, `${phase}\n${recovered.stdout}\n${recovered.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
        assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
        const status = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8"));
        assert.equal(status.state, "UPDATED");
        await assert.rejects(readFile(path.join(fixture.stateDirectory, "app-update", "pending.json")), { code: "ENOENT" });
        await assert.rejects(readFile(path.join(fixture.stateDirectory, "app-update", "apply-journal.json")), { code: "ENOENT" });
      } finally {
        runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
        await closeServer(fixture.releaseServer);
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      }
    });
  }
});

test("rollback cleanup crash remains replayable and does not poison the next candidate", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });
  await prepareStagedFixture(fixture, port);
  const interrupted = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], {
    env: {
      ...env,
      TARKOV_HELPER_UPDATE_TEST_FAIL_HEALTH: "1",
      TARKOV_HELPER_UPDATE_TEST_CRASH_PHASE: "ROLLED_BACK",
    },
    timeout: 40_000,
  });
  assert.equal(interrupted.status, 2, `${interrupted.stdout}\n${interrupted.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const journalPath = path.join(fixture.stateDirectory, "app-update", "apply-journal.json");
  assert.equal(JSON.parse(await readFile(journalPath, "utf8")).phase, "ROLLED_BACK");
  await rm(journalPath);

  const replayed = await runExternalBroker(fixture, port, { timeout: 40_000 });
  assert.equal(replayed.status, 10, `${replayed.stdout}\n${replayed.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.0.0");
  await assert.rejects(readFile(path.join(fixture.stateDirectory, "app-update", "pending.json")), { code: "ENOENT" });
  assert.deepEqual((await readdir(fixture.temporaryRoot)).filter((name) => name.includes(".update-failed-")), []);

  await prepareStagedFixture(fixture, port);
  const stopped = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env });
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
  const applied = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 40_000 });
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
});

test("rollback journal preserves a live delayed server identity across a hard crash", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  await prepareStagedFixture(fixture, port);
  const interrupted = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], {
    env: {
      ...env,
      TARKOV_HELPER_UPDATE_TEST_FAIL_HEALTH: "1",
      TARKOV_HELPER_UPDATE_TEST_CRASH_PHASE: "ROLLING_BACK",
    },
    timeout: 30_000,
  });
  assert.equal(interrupted.status, 2, `${interrupted.stdout}\n${interrupted.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const journalPath = path.join(fixture.stateDirectory, "app-update", "apply-journal.json");
  const interruptedJournal = JSON.parse(await readFile(journalPath, "utf8"));
  assert.equal(interruptedJournal.phase, "ROLLING_BACK");
  assert.ok(interruptedJournal.serverPid > 0, "the exact started server PID must remain durable");
  assert.match(interruptedJournal.serverProcessStartTimeUtc, /^\d{4}-\d{2}-\d{2}T/);

  const recovered = await runExternalBroker(fixture, port, { timeout: 40_000 });
  assert.equal(recovered.status, 10, `${recovered.stdout}\n${recovered.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.0.0");
  await assert.rejects(readFile(path.join(fixture.stateDirectory, "app-update", "pending.json")), { code: "ENOENT" });
  await assert.rejects(readFile(journalPath), { code: "ENOENT" });
});
