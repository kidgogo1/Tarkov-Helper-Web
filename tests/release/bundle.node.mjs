import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readZipArchive } from "../../scripts/release-utils.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
const createScript = path.join(repositoryRoot, "scripts", "create-release-bundle.mjs");
const verifyScript = path.join(repositoryRoot, "scripts", "verify-release-bundle.mjs");
const signingKeys = generateKeyPairSync("rsa", { modulusLength: 3072 });
const signingPrivateKey = signingKeys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const signingPublicKey = signingKeys.publicKey.export({ format: "pem", type: "spki" }).toString();

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
  const project = path.join(parent, "project");
  const direct = path.join(parent, "direct");
  const staticDirectory = path.join(parent, "static");
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(path.join(project, "portable"), { recursive: true });
  await mkdir(path.join(direct, "app", "data"), { recursive: true });
  await mkdir(path.join(staticDirectory, "data"), { recursive: true });

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
  await writeFile(path.join(staticDirectory, "LICENSE"), "fixture license\n");
  await writeFile(path.join(staticDirectory, "THIRD_PARTY_NOTICES.md"), "fixture notices\n");
  await writeFile(path.join(direct, "app", "index.html"), "<!doctype html><title>fixture</title>\n");
  await writeFile(path.join(direct, "app", "data", "tarkov-data.json"), "{}\n");
  await writeFile(path.join(direct, "launcher.ps1"), "Write-Output 'fixture'\n");

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

  return { commit, direct, parent, project, staticDirectory };
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

function createArguments(fixture, output, extra = []) {
  return [
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
      "--project-root", fixture.project,
      "--bundle", prepared,
      "--tag", "v1.2.3",
      "--commit", fixture.commit,
      "--repository", repository,
      "--prepared-only",
    ], { UPDATE_SIGNING_PUBLIC_KEY: signingPublicKey });
    assert.equal(preparedVerification.status, 0, `${preparedVerification.stdout}\n${preparedVerification.stderr}`);

    const finalize = run(createScript, [
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
