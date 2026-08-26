import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readZipArchive } from "../../scripts/release-utils.mjs";
import { buildWindowsLauncher } from "../../scripts/build-windows-launcher.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
const createScript = path.join(repositoryRoot, "scripts", "create-release-bundle.mjs");
const verifyScript = path.join(repositoryRoot, "scripts", "verify-release-bundle.mjs");
const signingKeys = generateKeyPairSync("rsa", { modulusLength: 3072 });
const signingPrivateKey = signingKeys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const signingPublicKey = signingKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
const signingKeyId = `sha256:${createHash("sha256")
  .update(signingKeys.publicKey.export({ format: "der", type: "spki" }))
  .digest("hex")}`;

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function collect(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(absolute, relative));
    if (entry.isFile()) {
      const contents = await readFile(absolute);
      files.push({ path: relative, size: contents.length, sha256: sha256(contents) });
    }
  }
  return files;
}

function sums(files) {
  return `${files.map((file) => `${file.sha256}  ${file.size}  ${file.path}`).join("\n")}\n`;
}

async function createFixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "tarkov-release-bundle-"));
  const config = path.join(parent, "release.config.json");
  const project = path.join(parent, "project");
  const direct = path.join(parent, "direct");
  const staticDirectory = path.join(parent, "static");
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(path.join(project, "portable"), { recursive: true });
  await mkdir(path.join(direct, "app", "data", "weapon-modding"), { recursive: true });
  await mkdir(path.join(staticDirectory, "data", "weapon-modding"), { recursive: true });

  const releaseConfig = JSON.parse(await readFile(path.join(repositoryRoot, "release.config.example.json"), "utf8"));
  releaseConfig.updater.signing.trustedKeyId = signingKeyId;
  await writeFile(config, `${JSON.stringify(releaseConfig, null, 2)}\n`);

  await writeFile(path.join(project, "package.json"), `${JSON.stringify({ name: "tarkov-helper-web", version: "1.2.3" }, null, 2)}\n`);
  await writeFile(path.join(project, "src", "main.js"), "export const fixture = true;\n");
  await writeFile(path.join(project, "portable", "app-update-worker.ps1"), "# fixture worker\n");
  await writeFile(path.join(project, "portable", "app-update-broker.ps1"), "# fixture broker\n");
  execFileSync("git", ["init", "--quiet"], { cwd: project });
  execFileSync("git", ["config", "user.name", "Release Test"], { cwd: project });
  execFileSync("git", ["config", "user.email", "release-test@example.invalid"], { cwd: project });
  execFileSync("git", ["add", "."], { cwd: project });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: project });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
  execFileSync("git", ["tag", "v1.2.3"], { cwd: project });

  await writeFile(path.join(staticDirectory, "index.html"), "<!doctype html><title>fixture</title>\n");
  await writeFile(path.join(staticDirectory, "data", "tarkov-data.json"), "{}\n");
  await writeFile(path.join(staticDirectory, "data", "weapon-modding", "catalog.json"), "{}\n");
  await writeFile(path.join(staticDirectory, "LICENSE"), "fixture license\n");
  await writeFile(path.join(staticDirectory, "THIRD_PARTY_NOTICES.md"), "fixture notices\n");
  await writeFile(path.join(direct, "app", "index.html"), "<!doctype html><title>fixture</title>\n");
  await writeFile(path.join(direct, "app", "data", "tarkov-data.json"), "{}\n");
  await writeFile(path.join(direct, "app", "data", "weapon-modding", "catalog.json"), "{}\n");
  await writeFile(path.join(direct, "launcher.ps1"), "Write-Output 'fixture'\n");
  await copyFile(path.join(repositoryRoot, "portable", "TarkovHelper.ico"), path.join(direct, "TarkovHelper.ico"));
  await buildWindowsLauncher({
    output: path.join(direct, "Tarkov Helper.exe"),
    version: "1.2.3",
  });
  await writeFile(path.join(direct, "start-menu.ps1"), "# fixture Start menu tool\n");
  await writeFile(path.join(direct, "Tarkov Helper 실행.vbs"), "' fixture launcher\n");
  await writeFile(path.join(direct, "Tarkov Helper 종료.vbs"), "' fixture stop launcher\n");
  await writeFile(path.join(direct, "Tarkov Helper 시작 메뉴 등록.vbs"), "' fixture registration\n");
  await writeFile(path.join(direct, "Tarkov Helper 시작 메뉴 제거.vbs"), "' fixture removal\n");
  await writeFile(path.join(direct, "문제 해결용 실행.cmd"), "@rem fixture diagnostics\r\n");
  await writeFile(path.join(direct, "Tarkov Helper 상태 복구.cmd"), "@rem fixture state repair\r\n");
  await writeFile(path.join(direct, "Tarkov Helper 격리 복구 실행.cmd"), "@rem fixture isolated recovery\r\n");
  await writeFile(path.join(direct, "사용 안내.txt"), "fixture guide\n");

  const appFiles = await collect(path.join(direct, "app"));
  const appManifest = sums(appFiles);
  const appBytes = appFiles.reduce((total, file) => total + file.size, 0);
  await writeFile(path.join(direct, "PACKAGE_INFO.txt"), [
    "Tarkov Helper Web Direct Release",
    `Source commit: ${commit}`,
    `App files: ${appFiles.length}`,
    `App bytes: ${appBytes}`,
    `App tree SHA-256: ${sha256(appManifest)}`,
    "Local URL: http://127.0.0.1:41753/",
    "",
  ].join("\n"));
  await writeFile(path.join(direct, "SHA256SUMS.txt"), sums(await collect(direct)));

  return { commit, config, direct, parent, project, staticDirectory };
}

function run(script, args, environment = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    maxBuffer: 10 * 1024 * 1024,
  });
}

const signingEnvironment = {
  UPDATE_SIGNING_PRIVATE_KEY: signingPrivateKey,
  UPDATE_SIGNING_PUBLIC_KEY: signingPublicKey,
};

test("production release config rejects an accidental update trust-root rotation", async () => {
  const fixture = await createFixture();
  const output = path.join(fixture.parent, "rotated-trust-root");
  try {
    const result = run(createScript, [
      "--project-root", fixture.project,
      "--direct", fixture.direct,
      "--static", fixture.staticDirectory,
      "--output", output,
      "--tag", "v1.2.3",
      "--commit", fixture.commit,
      "--repository", "example-owner/example-repository",
      "--release-id", "101",
      "--direct-asset-id", "201",
      "--static-asset-id", "202",
      "--source-asset-id", "203",
    ], signingEnvironment);

    assert.notEqual(result.status, 0, "a newly generated key must not replace the public key pinned by old clients");
    assert.match(`${result.stdout}\n${result.stderr}`, /trust root|trusted signing key|key id/i);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

function createArguments(fixture, output, extra = []) {
  return [
    "--config", fixture.config,
    "--project-root", fixture.project,
    "--direct", fixture.direct,
    "--static", fixture.staticDirectory,
    "--output", output,
    "--tag", "v1.2.3",
    "--commit", fixture.commit,
    ...extra,
  ];
}

test("creates a deterministic public release bundle and verifies its provenance", async () => {
  const fixture = await createFixture();
  const first = path.join(fixture.parent, "release-first");
  const second = path.join(fixture.parent, "release-second");
  const repository = "example-owner/example-repository";
  const identityArguments = [
    "--repository", repository,
    "--release-id", "101",
    "--direct-asset-id", "201",
    "--static-asset-id", "202",
    "--source-asset-id", "203",
  ];
  try {
    for (const output of [first, second]) {
      const result = run(createScript, createArguments(fixture, output, identityArguments), signingEnvironment);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }

    const expectedFiles = [
      "SHA256SUMS.txt",
      "tarkov-helper-web-direct-v1.2.3.zip",
      "tarkov-helper-web-source-v1.2.3.zip",
      "tarkov-helper-web-static-v1.2.3.zip",
      "update-manifest-v1.json",
      "update-manifest-v1.sig",
    ];
    assert.deepEqual((await readdir(first)).sort(), expectedFiles);
    assert.deepEqual((await readdir(second)).sort(), expectedFiles);

    for (const filename of expectedFiles) {
      assert.equal(
        sha256(await readFile(path.join(first, filename))),
        sha256(await readFile(path.join(second, filename))),
        `${filename} must be reproducible`,
      );
    }

    const manifest = JSON.parse(await readFile(path.join(first, "update-manifest-v1.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.product, "tarkov-helper-web");
    assert.equal(manifest.channel, "stable");
    assert.equal(manifest.repository, repository);
    assert.equal(manifest.version, "1.2.3");
    assert.equal(manifest.tag, "v1.2.3");
    assert.equal(manifest.commit, fixture.commit);
    assert.equal(manifest.releaseId, 101);
    assert.deepEqual(manifest.updater, {
      configFile: "UPDATE_CONFIG.json",
      manifestAsset: "update-manifest-v1.json",
      protocolVersion: 1,
      requireImmutableRelease: true,
      signatureAsset: "update-manifest-v1.sig",
      signing: {
        algorithm: "RSA-SHA256",
        keyId: manifest.updater.signing.keyId,
      },
    });
    assert.match(manifest.updater.signing.keyId, /^sha256:[0-9a-f]{64}$/);
    assert.equal(manifest.artifacts.direct.assetId, 201);
    assert.equal(manifest.artifacts.static.assetId, 202);
    assert.equal(manifest.artifacts.source.assetId, 203);
    assert.equal(manifest.artifacts.direct.unpacked.fileCount > 0, true);
    assert.equal(manifest.artifacts.direct.unpacked.bytes > 0, true);
    assert.match(manifest.artifacts.direct.unpacked.treeSha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.artifacts.direct.rootDirectory, "Tarkov Helper 바로 실행 v1.2.3");
    assert.equal(manifest.artifacts.direct.stripComponents, 1);
    assert.equal(manifest.artifacts.direct.package.sourceCommit, fixture.commit);
    assert.equal(manifest.artifacts.direct.package.version, "1.2.3");
    assert.equal(manifest.artifacts.direct.package.updaterProtocolVersion, 1);
    assert.match(manifest.artifacts.direct.sha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.artifacts.direct.bytes, (await stat(path.join(first, manifest.artifacts.direct.filename))).size);

    const signature = await readFile(path.join(first, "update-manifest-v1.sig"));
    assert.equal(verifySignature(
      "RSA-SHA256",
      await readFile(path.join(first, "update-manifest-v1.json")),
      signingPublicKey,
      signature,
    ), true);

    const directArchive = await readZipArchive(path.join(first, "tarkov-helper-web-direct-v1.2.3.zip"));
    assert(directArchive.entries.some((entry) => entry.path.endsWith("/app/data/weapon-modding/catalog.json")));
    const staticArchive = await readZipArchive(path.join(first, "tarkov-helper-web-static-v1.2.3.zip"));
    assert(staticArchive.entries.some((entry) => entry.path.endsWith("/data/weapon-modding/catalog.json")));
    const configEntry = directArchive.entries.find((entry) => entry.path.endsWith("/UPDATE_CONFIG.json"));
    assert(configEntry);
    const updateConfig = JSON.parse(configEntry.contents.toString("utf8"));
    assert.equal(updateConfig.repository, repository);
    assert.equal(updateConfig.requireImmutableRelease, true);
    assert.equal(updateConfig.signing.publicKeySpkiPem, signingPublicKey);
    assert.equal(updateConfig.signing.keyId, manifest.updater.signing.keyId);
    const versionEntry = directArchive.entries.find((entry) => entry.path.endsWith("/app/version.json"));
    assert(versionEntry);
    assert.deepEqual(JSON.parse(versionEntry.contents.toString("utf8")), {
      schemaVersion: 1,
      product: "tarkov-helper-web",
      version: "1.2.3",
      commit: fixture.commit,
      updaterProtocolVersion: 1,
    });

    const verification = run(verifyScript, [
      "--config", fixture.config,
      "--project-root", fixture.project,
      "--bundle", first,
      "--tag", "v1.2.3",
      "--commit", fixture.commit,
      "--repository", repository,
      "--release-id", "101",
      "--direct-asset-id", "201",
      "--static-asset-id", "202",
      "--source-asset-id", "203",
    ], { UPDATE_SIGNING_PUBLIC_KEY: signingPublicKey });
    assert.equal(verification.status, 0, `${verification.stdout}\n${verification.stderr}`);
    const report = JSON.parse(verification.stdout);
    assert.equal(report.valid, true);
    assert.equal(report.archives.direct.rootDirectory, "Tarkov Helper 바로 실행 v1.2.3");
    assert.equal(report.archives.direct.forwardSlashPaths, true);
    assert.equal(report.archives.source.commit, fixture.commit);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("release creation rejects Direct and static inputs missing the weapon modding catalog", async () => {
  const fixture = await createFixture();
  try {
    await rm(path.join(fixture.direct, "app", "data", "weapon-modding", "catalog.json"));
    await rm(path.join(fixture.direct, "SHA256SUMS.txt"));
    await writeFile(path.join(fixture.direct, "SHA256SUMS.txt"), sums(await collect(fixture.direct)));

    const missingDirect = run(createScript, createArguments(
      fixture,
      path.join(fixture.parent, "release-missing-direct-catalog"),
      ["--updater-disabled"],
    ));
    assert.notEqual(missingDirect.status, 0);
    assert.match(`${missingDirect.stdout}\n${missingDirect.stderr}`, /weapon-modding[\\/]catalog\.json/i);

    await mkdir(path.join(fixture.direct, "app", "data", "weapon-modding"), { recursive: true });
    await writeFile(path.join(fixture.direct, "app", "data", "weapon-modding", "catalog.json"), "{}\n");
    await rm(path.join(fixture.direct, "SHA256SUMS.txt"));
    await writeFile(path.join(fixture.direct, "SHA256SUMS.txt"), sums(await collect(fixture.direct)));
    await rm(path.join(fixture.staticDirectory, "data", "weapon-modding", "catalog.json"));

    const missingStatic = run(createScript, createArguments(
      fixture,
      path.join(fixture.parent, "release-missing-static-catalog"),
      ["--updater-disabled"],
    ));
    assert.notEqual(missingStatic.status, 0);
    assert.match(`${missingStatic.stdout}\n${missingStatic.stderr}`, /weapon-modding[\\/]catalog\.json/i);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("supports an explicit updater-disabled local bundle without repository identity", async () => {
  const fixture = await createFixture();
  const output = path.join(fixture.parent, "release-local");
  try {
    const result = run(createScript, createArguments(fixture, output, ["--updater-disabled"]));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual((await readdir(output)).sort(), [
      "SHA256SUMS.txt",
      "tarkov-helper-web-direct-v1.2.3.zip",
      "tarkov-helper-web-source-v1.2.3.zip",
      "tarkov-helper-web-static-v1.2.3.zip",
    ]);
    const directArchive = await readZipArchive(path.join(output, "tarkov-helper-web-direct-v1.2.3.zip"));
    const configEntry = directArchive.entries.find((entry) => entry.path.endsWith("/UPDATE_CONFIG.json"));
    assert(configEntry);
    assert.deepEqual(JSON.parse(configEntry.contents.toString("utf8")), {
      schemaVersion: 1,
      updaterEnabled: false,
      protocolVersion: 1,
    });

    const verification = run(verifyScript, [
      "--config", fixture.config,
      "--project-root", fixture.project,
      "--bundle", output,
      "--tag", "v1.2.3",
      "--commit", fixture.commit,
      "--updater-disabled",
    ]);
    assert.equal(verification.status, 0, `${verification.stdout}\n${verification.stderr}`);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("prepares ZIPs without a private key and finalizes them on a separate signing runner", async () => {
  const fixture = await createFixture();
  const prepared = path.join(fixture.parent, "prepared-zips");
  const finalized = path.join(fixture.parent, "finalized-release");
  const repository = "example-owner/example-repository";
  try {
    const prepare = run(createScript, createArguments(fixture, prepared, [
      "--repository", repository,
      "--prepare-only",
    ]), { UPDATE_SIGNING_PUBLIC_KEY: signingPublicKey, UPDATE_SIGNING_PRIVATE_KEY: "" });
    assert.equal(prepare.status, 0, `${prepare.stdout}\n${prepare.stderr}`);
    assert.deepEqual((await readdir(prepared)).sort(), [
      "tarkov-helper-web-direct-v1.2.3.zip",
      "tarkov-helper-web-source-v1.2.3.zip",
      "tarkov-helper-web-static-v1.2.3.zip",
    ]);

    const preparedVerification = run(verifyScript, [
      "--config", fixture.config,
      "--project-root", fixture.project,
      "--bundle", prepared,
      "--tag", "v1.2.3",
      "--commit", fixture.commit,
      "--repository", repository,
      "--prepared-only",
    ], { UPDATE_SIGNING_PUBLIC_KEY: signingPublicKey });
    assert.equal(preparedVerification.status, 0, `${preparedVerification.stdout}\n${preparedVerification.stderr}`);

    const finalize = run(createScript, [
      "--config", fixture.config,
      "--project-root", fixture.project,
      "--prepared", prepared,
      "--output", finalized,
      "--tag", "v1.2.3",
      "--commit", fixture.commit,
      "--repository", repository,
      "--release-id", "101",
      "--direct-asset-id", "201",
      "--static-asset-id", "202",
      "--source-asset-id", "203",
    ], signingEnvironment);
    assert.equal(finalize.status, 0, `${finalize.stdout}\n${finalize.stderr}`);
    assert.deepEqual((await readdir(finalized)).sort(), [
      "SHA256SUMS.txt",
      "tarkov-helper-web-direct-v1.2.3.zip",
      "tarkov-helper-web-source-v1.2.3.zip",
      "tarkov-helper-web-static-v1.2.3.zip",
      "update-manifest-v1.json",
      "update-manifest-v1.sig",
    ]);
    for (const filename of (await readdir(prepared))) {
      assert.equal(sha256(await readFile(path.join(prepared, filename))), sha256(await readFile(path.join(finalized, filename))));
    }
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("finalizes an unsigned release manifest without exposing a private key", async () => {
  const fixture = await createFixture();
  const prepared = path.join(fixture.parent, "prepared-unsigned-zips");
  const unsigned = path.join(fixture.parent, "unsigned-release-first");
  const unsignedSecond = path.join(fixture.parent, "unsigned-release-second");
  const repository = "example-owner/example-repository";
  try {
    const prepare = run(createScript, createArguments(fixture, prepared, [
      "--repository", repository,
      "--prepare-only",
    ]), { UPDATE_SIGNING_PUBLIC_KEY: signingPublicKey, UPDATE_SIGNING_PRIVATE_KEY: "" });
    assert.equal(prepare.status, 0, `${prepare.stdout}\n${prepare.stderr}`);

    for (const output of [unsigned, unsignedSecond]) {
      const finalize = run(createScript, [
        "--config", fixture.config,
        "--project-root", fixture.project,
        "--prepared", prepared,
        "--finalize-unsigned",
        "--output", output,
        "--tag", "v1.2.3",
        "--commit", fixture.commit,
        "--repository", repository,
        "--release-id", "101",
        "--direct-asset-id", "201",
        "--static-asset-id", "202",
        "--source-asset-id", "203",
      ], { UPDATE_SIGNING_PUBLIC_KEY: signingPublicKey, UPDATE_SIGNING_PRIVATE_KEY: "must-not-be-read" });
      assert.equal(finalize.status, 0, `${finalize.stdout}\n${finalize.stderr}`);
    }
    const expectedUnsignedFiles = [
      "tarkov-helper-web-direct-v1.2.3.zip",
      "tarkov-helper-web-source-v1.2.3.zip",
      "tarkov-helper-web-static-v1.2.3.zip",
      "update-manifest-v1.json",
    ];
    assert.deepEqual((await readdir(unsigned)).sort(), expectedUnsignedFiles);
    assert.deepEqual((await readdir(unsignedSecond)).sort(), expectedUnsignedFiles);
    for (const filename of expectedUnsignedFiles) {
      assert.equal(
        sha256(await readFile(path.join(unsigned, filename))),
        sha256(await readFile(path.join(unsignedSecond, filename))),
        `${filename} must be deterministic before signing`,
      );
    }

    const verification = run(verifyScript, [
      "--config", fixture.config,
      "--project-root", fixture.project,
      "--bundle", unsigned,
      "--tag", "v1.2.3",
      "--commit", fixture.commit,
      "--repository", repository,
      "--release-id", "101",
      "--direct-asset-id", "201",
      "--static-asset-id", "202",
      "--source-asset-id", "203",
      "--unsigned-finalized",
    ], { UPDATE_SIGNING_PUBLIC_KEY: signingPublicKey });
    assert.equal(verification.status, 0, `${verification.stdout}\n${verification.stderr}`);
    assert.equal(JSON.parse(verification.stdout).unsignedFinalized, true);

    const manifestPath = path.join(unsigned, "update-manifest-v1.json");
    const manifestText = await readFile(manifestPath, "utf8");
    const forgedTree = JSON.parse(manifestText);
    forgedTree.artifacts.direct.unpacked.treeSha256 = "0".repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(forgedTree, null, 2)}\n`);
    const rejectedTreeClaim = run(verifyScript, [
      "--config", fixture.config,
      "--project-root", fixture.project,
      "--bundle", unsigned,
      "--tag", "v1.2.3",
      "--commit", fixture.commit,
      "--repository", repository,
      "--release-id", "101",
      "--direct-asset-id", "201",
      "--static-asset-id", "202",
      "--source-asset-id", "203",
      "--unsigned-finalized",
    ], { UPDATE_SIGNING_PUBLIC_KEY: signingPublicKey });
    assert.notEqual(rejectedTreeClaim.status, 0);
    assert.match(`${rejectedTreeClaim.stdout}\n${rejectedTreeClaim.stderr}`, /unpacked metadata mismatch/i);

    const forgedPackage = JSON.parse(manifestText);
    forgedPackage.artifacts.direct.package.appFiles += 1;
    await writeFile(manifestPath, `${JSON.stringify(forgedPackage, null, 2)}\n`);
    const rejectedPackageClaim = run(verifyScript, [
      "--config", fixture.config,
      "--project-root", fixture.project,
      "--bundle", unsigned,
      "--tag", "v1.2.3",
      "--commit", fixture.commit,
      "--repository", repository,
      "--release-id", "101",
      "--direct-asset-id", "201",
      "--static-asset-id", "202",
      "--source-asset-id", "203",
      "--unsigned-finalized",
    ], { UPDATE_SIGNING_PUBLIC_KEY: signingPublicKey });
    assert.notEqual(rejectedPackageClaim.status, 0);
    assert.match(`${rejectedPackageClaim.stdout}\n${rejectedPackageClaim.stderr}`, /package metadata mismatch/i);

    await writeFile(manifestPath, manifestText.replace(repository, "attacker/forged-release"));
    const tampered = run(verifyScript, [
      "--config", fixture.config,
      "--project-root", fixture.project,
      "--bundle", unsigned,
      "--tag", "v1.2.3",
      "--commit", fixture.commit,
      "--repository", repository,
      "--release-id", "101",
      "--direct-asset-id", "201",
      "--static-asset-id", "202",
      "--source-asset-id", "203",
      "--unsigned-finalized",
    ], { UPDATE_SIGNING_PUBLIC_KEY: signingPublicKey });
    assert.notEqual(tampered.status, 0);
    assert.match(`${tampered.stdout}\n${tampered.stderr}`, /release identity mismatch/i);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("verification rejects a tampered release asset", async () => {
  const fixture = await createFixture();
  const output = path.join(fixture.parent, "release-tampered");
  try {
    const releaseArguments = [
      "--repository", "example-owner/example-repository",
      "--release-id", "101",
      "--direct-asset-id", "201",
      "--static-asset-id", "202",
      "--source-asset-id", "203",
    ];
    const created = run(createScript, createArguments(fixture, output, releaseArguments), signingEnvironment);
    assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
    const archivePath = path.join(output, "tarkov-helper-web-direct-v1.2.3.zip");
    const tampered = Buffer.from(await readFile(archivePath));
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    await writeFile(archivePath, tampered);

    const verification = run(verifyScript, [
      "--config", fixture.config,
      "--project-root", fixture.project,
      "--bundle", output,
      "--tag", "v1.2.3",
      "--commit", fixture.commit,
      "--repository", "example-owner/example-repository",
      "--release-id", "101",
      "--direct-asset-id", "201",
      "--static-asset-id", "202",
      "--source-asset-id", "203",
    ], { UPDATE_SIGNING_PUBLIC_KEY: signingPublicKey });
    assert.notEqual(verification.status, 0);
    assert.match(`${verification.stdout}\n${verification.stderr}`, /SHA-256 mismatch/i);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("release creation rejects an invalid branded launcher before publishing", async () => {
  const fixture = await createFixture();
  const output = path.join(fixture.parent, "release-invalid-launcher");
  try {
    await writeFile(path.join(fixture.direct, "Tarkov Helper.exe"), Buffer.alloc(128, 0x41));
    const directFiles = (await collect(fixture.direct)).filter((file) => file.path !== "SHA256SUMS.txt");
    await writeFile(path.join(fixture.direct, "SHA256SUMS.txt"), sums(directFiles), "utf8");
    const result = run(createScript, createArguments(fixture, output, ["--updater-disabled"]));
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /MZ header/i);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("a rewritten checksum file cannot bypass the pinned manifest signature", async () => {
  const fixture = await createFixture();
  const output = path.join(fixture.parent, "release-signature-tampered");
  const releaseArguments = [
    "--repository", "example-owner/example-repository",
    "--release-id", "101",
    "--direct-asset-id", "201",
    "--static-asset-id", "202",
    "--source-asset-id", "203",
  ];
  try {
    const created = run(createScript, createArguments(fixture, output, releaseArguments), signingEnvironment);
    assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
    const manifestPath = path.join(output, "update-manifest-v1.json");
    const manifest = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, manifest.replace('"channel": "stable"', '"channel": "forged"'));
    const outputFiles = (await collect(output)).filter((file) => file.path !== "SHA256SUMS.txt");
    await writeFile(path.join(output, "SHA256SUMS.txt"), sums(outputFiles));

    const verification = run(verifyScript, [
      "--config", fixture.config,
      "--project-root", fixture.project,
      "--bundle", output,
      "--tag", "v1.2.3",
      "--commit", fixture.commit,
      ...releaseArguments,
    ], { UPDATE_SIGNING_PUBLIC_KEY: signingPublicKey });
    assert.notEqual(verification.status, 0);
    assert.match(`${verification.stdout}\n${verification.stderr}`, /RSA-SHA256 signature is invalid/i);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("public release creation fails closed without release IDs or either signing key", async () => {
  const fixture = await createFixture();
  try {
    const noIds = run(createScript, createArguments(fixture, path.join(fixture.parent, "no-ids"), [
      "--repository", "example-owner/example-repository",
    ]), signingEnvironment);
    assert.notEqual(noIds.status, 0);
    assert.match(`${noIds.stdout}\n${noIds.stderr}`, /release-id/i);

    const noPrivateKey = run(createScript, createArguments(fixture, path.join(fixture.parent, "no-private"), [
      "--repository", "example-owner/example-repository",
      "--release-id", "101",
      "--direct-asset-id", "201",
      "--static-asset-id", "202",
      "--source-asset-id", "203",
    ]), { UPDATE_SIGNING_PUBLIC_KEY: signingPublicKey, UPDATE_SIGNING_PRIVATE_KEY: "" });
    assert.notEqual(noPrivateKey.status, 0);
    assert.match(`${noPrivateKey.stdout}\n${noPrivateKey.stderr}`, /UPDATE_SIGNING_PRIVATE_KEY/);

    const noPublicKey = run(createScript, createArguments(fixture, path.join(fixture.parent, "no-public"), [
      "--repository", "example-owner/example-repository",
      "--release-id", "101",
      "--direct-asset-id", "201",
      "--static-asset-id", "202",
      "--source-asset-id", "203",
    ]), { UPDATE_SIGNING_PRIVATE_KEY: signingPrivateKey, UPDATE_SIGNING_PUBLIC_KEY: "" });
    assert.notEqual(noPublicKey.status, 0);
    assert.match(`${noPublicKey.stdout}\n${noPublicKey.stderr}`, /UPDATE_SIGNING_PUBLIC_KEY/);

    const duplicateAssetIds = run(createScript, createArguments(fixture, path.join(fixture.parent, "duplicate-asset-ids"), [
      "--repository", "example-owner/example-repository",
      "--release-id", "101",
      "--direct-asset-id", "201",
      "--static-asset-id", "201",
      "--source-asset-id", "203",
    ]), signingEnvironment);
    assert.notEqual(duplicateAssetIds.status, 0);
    assert.match(`${duplicateAssetIds.stdout}\n${duplicateAssetIds.stderr}`, /asset IDs must be distinct/i);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("an existing output is never replaced or removed", async () => {
  const fixture = await createFixture();
  const output = path.join(fixture.parent, "existing-release");
  const sentinel = path.join(output, "keep-me.txt");
  try {
    await mkdir(output);
    await writeFile(sentinel, "preserve\n");
    const result = run(createScript, createArguments(fixture, output, ["--updater-disabled"]));
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /already exists/i);
    assert.equal(await readFile(sentinel, "utf8"), "preserve\n");
    assert.deepEqual(await readdir(output), ["keep-me.txt"]);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});
