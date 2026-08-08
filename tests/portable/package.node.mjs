import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const packagingScript = path.join(projectRoot, "scripts", "create-direct-release.mjs");

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(absolutePath, relativePath));
    if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

async function sha256(filename) {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

test("direct release contains the built app, launchers, guide, and notices", async () => {
  const temporaryParent = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-package-"));
  const output = path.join(temporaryParent, "Tarkov Helper 바로 실행");

  try {
    const result = spawnSync(process.execPath, [packagingScript, "--output", output], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    assert.equal((await stat(path.join(output, "app", "index.html"))).isFile(), true);
    assert.equal((await stat(path.join(output, "app", "data", "tarkov-data.json"))).isFile(), true);
    assert.equal((await stat(path.join(output, "app", "LICENSE"))).isFile(), true);
    assert.equal((await stat(path.join(output, "app", "THIRD_PARTY_NOTICES.md"))).isFile(), true);
    assert.equal((await stat(path.join(output, "launcher.ps1"))).isFile(), true);
    assert.equal((await stat(path.join(output, "app-update-worker.ps1"))).isFile(), true);
    assert.equal((await stat(path.join(output, "app-update-broker.ps1"))).isFile(), true);
    assert.equal((await stat(path.join(output, "UPDATE_CONFIG.json"))).isFile(), true);
    assert.equal((await stat(path.join(output, "Tarkov Helper 실행.vbs"))).isFile(), true);
    assert.equal((await stat(path.join(output, "Tarkov Helper 종료.vbs"))).isFile(), true);
    assert.equal((await stat(path.join(output, "문제 해결용 실행.cmd"))).isFile(), true);
    assert.equal((await stat(path.join(output, "사용 안내.txt"))).isFile(), true);
    assert.equal((await stat(path.join(output, "LICENSE"))).isFile(), true);
    assert.equal((await stat(path.join(output, "README.md"))).isFile(), true);
    assert.equal((await stat(path.join(output, "THIRD_PARTY_NOTICES.md"))).isFile(), true);
    assert.equal((await stat(path.join(output, "PACKAGE_INFO.txt"))).isFile(), true);
    assert.equal((await stat(path.join(output, "SHA256SUMS.txt"))).isFile(), true);
    assert.deepEqual(JSON.parse(await readFile(path.join(output, "UPDATE_CONFIG.json"), "utf8")), {
      schemaVersion: 1,
      updaterEnabled: false,
      protocolVersion: 1,
    });
    const versionDocument = JSON.parse(await readFile(path.join(output, "app", "version.json"), "utf8"));
    assert.deepEqual(Object.keys(versionDocument).sort(), [
      "commit",
      "product",
      "schemaVersion",
      "updaterProtocolVersion",
      "version",
    ]);
    assert.equal(versionDocument.schemaVersion, 1);
    assert.equal(versionDocument.product, "tarkov-helper-web");
    assert.match(versionDocument.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
    assert.match(versionDocument.commit, /^[0-9a-f]{40}$/);
    assert.equal(versionDocument.updaterProtocolVersion, 1);
    const guide = await readFile(path.join(output, "사용 안내.txt"), "utf8");
    assert.match(guide, /실행\.vbs/);
    assert.match(guide, /종료\.vbs/);
    assert.match(guide, /백그라운드/);

    assert.equal(
      await readFile(path.join(output, "app", "index.html"), "utf8"),
      await readFile(path.join(projectRoot, "dist", "index.html"), "utf8"),
    );
    const outputAppFiles = await listFiles(path.join(output, "app"));
    const distFiles = await listFiles(path.join(projectRoot, "dist"));
    assert.deepEqual(outputAppFiles.filter((filename) => filename !== "version.json"), distFiles);
    for (const filename of distFiles) {
      assert.equal(
        await sha256(path.join(output, "app", filename)),
        await sha256(path.join(projectRoot, "dist", filename)),
      );
    }
    for (const filename of ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"]) {
      assert.equal(await sha256(path.join(output, filename)), await sha256(path.join(projectRoot, "dist", filename)));
    }

    const packageInfo = await readFile(path.join(output, "PACKAGE_INFO.txt"), "utf8");
    assert.match(packageInfo, new RegExp(`^Version: ${versionDocument.version}$`, "m"));
    assert.match(packageInfo, /^Updater protocol: 1$/m);
    assert.match(packageInfo, /Source commit: (?:[0-9a-f]{40}(?:-dirty)?|unavailable)/);
    const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" });
    const workingTree = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: projectRoot, encoding: "utf8" });
    if (revision.status === 0 && workingTree.status === 0) {
      const expectedSource = `${revision.stdout.trim()}${workingTree.stdout.trim() ? "-dirty" : ""}`;
      assert.match(packageInfo, new RegExp(`^Source commit: ${expectedSource}$`, "m"));
    }
    assert.match(packageInfo, /App files: \d+/);
    const appFiles = await listFiles(path.join(output, "app"));
    const appRecords = await Promise.all(appFiles.map(async (filename) => ({
      filename,
      hash: await sha256(path.join(output, "app", filename)),
      size: (await stat(path.join(output, "app", filename))).size,
    })));
    appRecords.sort((left, right) => left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0);
    const appManifest = appRecords.map((file) => `${file.hash}  ${file.size}  ${file.filename}`).join("\n") + "\n";
    const expectedTreeHash = createHash("sha256").update(appManifest, "utf8").digest("hex");
    assert.match(packageInfo, new RegExp(`App tree SHA-256: ${expectedTreeHash}`));

    const manifest = await readFile(path.join(output, "SHA256SUMS.txt"), "utf8");
    const packagedFiles = (await listFiles(output)).filter((filename) => filename !== "SHA256SUMS.txt");
    for (const filename of packagedFiles) {
      assert.match(manifest, new RegExp(`^[0-9a-f]{64}  \\d+  ${filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    }
    const manifestPaths = manifest.trimEnd().split("\n").map((line) => {
      const match = line.match(/^[0-9a-f]{64} {2}\d+ {2}(.+)$/);
      assert(match, `Malformed manifest line: ${line}`);
      return match[1];
    });
    assert.deepEqual(manifestPaths.sort(), packagedFiles.sort());

    const repeated = spawnSync(process.execPath, [packagingScript, "--output", output], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.notEqual(repeated.status, 0);
    assert.match(`${repeated.stdout}\n${repeated.stderr}`, /already exists/i);
  } finally {
    await rm(temporaryParent, { recursive: true, force: true });
  }
});
