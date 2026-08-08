import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const script = path.join(projectRoot, "scripts", "assert-release-version.mjs");

async function createRepository(version = "1.2.3") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tarkov-release-version-"));
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify({ name: "fixture", version }, null, 2)}\n`);
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Release Test"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "release-test@example.invalid"], { cwd: directory });
  execFileSync("git", ["add", "package.json"], { cwd: directory });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: directory });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
  if (/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    execFileSync("git", ["tag", `v${version}`], { cwd: directory });
  }
  return { directory, commit };
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

test("accepts the package version as the only version source", async () => {
  const fixture = await createRepository();
  try {
    const result = run([
      "--project-root", fixture.directory,
      "--tag", "v1.2.3",
      "--commit", fixture.commit,
      "--repository", "example-owner/example-repository",
      "--require-repository",
    ]);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), {
      commit: fixture.commit,
      repository: "example-owner/example-repository",
      tag: "v1.2.3",
      version: "1.2.3",
    });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects a tag that does not exactly match package.json", async () => {
  const fixture = await createRepository();
  try {
    const result = run([
      "--project-root", fixture.directory,
      "--tag", "v1.2.4",
      "--commit", fixture.commit,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /must exactly match package\.json version/i);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("requires an injected owner/repository only for a public release", async () => {
  const fixture = await createRepository();
  try {
    const local = run([
      "--project-root", fixture.directory,
      "--tag", "v1.2.3",
      "--commit", fixture.commit,
    ]);
    assert.equal(local.status, 0, `${local.stdout}\n${local.stderr}`);

    const publicRelease = run([
      "--project-root", fixture.directory,
      "--tag", "v1.2.3",
      "--commit", fixture.commit,
      "--require-repository",
    ]);
    assert.notEqual(publicRelease.status, 0);
    assert.match(`${publicRelease.stdout}\n${publicRelease.stderr}`, /repository is required/i);

    const malformed = run([
      "--project-root", fixture.directory,
      "--tag", "v1.2.3",
      "--commit", fixture.commit,
      "--repository", "https://github.com/example/repository",
    ]);
    assert.notEqual(malformed.status, 0);
    assert.match(`${malformed.stdout}\n${malformed.stderr}`, /owner\/repository/i);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("public releases require the exact tag to resolve to HEAD", async () => {
  const fixture = await createRepository();
  try {
    execFileSync("git", ["tag", "-d", "v1.2.3"], { cwd: fixture.directory, stdio: "ignore" });
    const missing = run([
      "--project-root", fixture.directory,
      "--tag", "v1.2.3",
      "--commit", fixture.commit,
      "--repository", "example-owner/example-repository",
      "--require-repository",
    ]);
    assert.notEqual(missing.status, 0);
    assert.match(`${missing.stdout}\n${missing.stderr}`, /does not resolve to a commit/i);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects a dirty tree and a commit other than HEAD", async () => {
  const fixture = await createRepository();
  try {
    const wrongCommit = run([
      "--project-root", fixture.directory,
      "--tag", "v1.2.3",
      "--commit", "0".repeat(40),
    ]);
    assert.notEqual(wrongCommit.status, 0);
    assert.match(`${wrongCommit.stdout}\n${wrongCommit.stderr}`, /does not match HEAD/i);

    await writeFile(path.join(fixture.directory, "untracked.txt"), "dirty\n");
    const dirty = run([
      "--project-root", fixture.directory,
      "--tag", "v1.2.3",
      "--commit", fixture.commit,
    ]);
    assert.notEqual(dirty.status, 0);
    assert.match(`${dirty.stdout}\n${dirty.stderr}`, /working tree must be clean/i);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("stable releases reject prerelease and build-metadata versions", async () => {
  for (const version of ["1.2.3-beta.1", "1.2.3+build.4", "01.2.3"]) {
    const fixture = await createRepository(version);
    try {
      const result = run([
        "--project-root", fixture.directory,
        "--tag", `v${version}`,
        "--commit", fixture.commit,
      ]);
      assert.notEqual(result.status, 0, version);
      assert.match(`${result.stdout}\n${result.stderr}`, /stable semantic version/i);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});
