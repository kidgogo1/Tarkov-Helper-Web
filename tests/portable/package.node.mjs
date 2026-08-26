import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const packagingScript = path.join(projectRoot, "scripts", "create-direct-release.mjs");
const launcherBuildScript = path.join(projectRoot, "scripts", "build-windows-launcher.mjs");
const launcherSourceDirectory = path.join(projectRoot, "portable", "windows-launcher");
const isolatedRecoveryCommand = path.join(projectRoot, "portable", "Tarkov Helper 격리 복구 실행.cmd");
const packageVersion = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")).version;

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

async function readIconSizes(filename) {
  const contents = await readFile(filename);
  assert.equal(contents.readUInt16LE(0), 0, "ICO reserved field");
  assert.equal(contents.readUInt16LE(2), 1, "ICO image type");
  const count = contents.readUInt16LE(4);
  assert.ok(count > 0, "ICO must contain at least one image");
  assert.ok(contents.length >= 6 + (count * 16), "ICO directory must be complete");

  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + (index * 16);
    const width = contents[offset] || 256;
    const height = contents[offset + 1] || 256;
    const imageBytes = contents.readUInt32LE(offset + 8);
    const imageOffset = contents.readUInt32LE(offset + 12);
    assert.equal(width, height, "ICO entries must be square");
    assert.ok(imageBytes > 0, "ICO entry must contain image data");
    assert.ok(imageOffset >= 6 + (count * 16), "ICO image offset must follow its directory");
    assert.ok(imageOffset + imageBytes <= contents.length, "ICO image data must stay inside the file");
    sizes.push(width);
  }
  return sizes.sort((left, right) => left - right);
}

function rvaToFileOffset(contents, sectionTableOffset, sectionCount, rva) {
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTableOffset + (index * 40);
    const virtualSize = contents.readUInt32LE(offset + 8);
    const virtualAddress = contents.readUInt32LE(offset + 12);
    const rawSize = contents.readUInt32LE(offset + 16);
    const rawOffset = contents.readUInt32LE(offset + 20);
    if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
      return rawOffset + (rva - virtualAddress);
    }
  }
  throw new Error(`PE RVA 0x${rva.toString(16)} is not mapped by a section`);
}

async function readLauncherPeMetadata(filename) {
  const contents = await readFile(filename);
  assert.equal(contents.subarray(0, 2).toString("ascii"), "MZ", "launcher must have a DOS PE header");
  const peOffset = contents.readUInt32LE(0x3c);
  assert.equal(contents.subarray(peOffset, peOffset + 4).toString("binary"), "PE\0\0", "launcher must be a PE image");

  const coffOffset = peOffset + 4;
  const sectionCount = contents.readUInt16LE(coffOffset + 2);
  const optionalHeaderSize = contents.readUInt16LE(coffOffset + 16);
  const characteristics = contents.readUInt16LE(coffOffset + 18);
  const optionalOffset = coffOffset + 20;
  assert.equal(contents.readUInt16LE(optionalOffset), 0x10b, "launcher must use the PE32 optional header");
  const subsystem = contents.readUInt16LE(optionalOffset + 68);
  const resourceRva = contents.readUInt32LE(optionalOffset + 96 + (2 * 8));
  const resourceSize = contents.readUInt32LE(optionalOffset + 96 + (2 * 8) + 4);
  assert.ok(resourceRva > 0 && resourceSize > 0, "launcher must have a resource directory");

  const sectionTableOffset = optionalOffset + optionalHeaderSize;
  const resourceOffset = rvaToFileOffset(contents, sectionTableOffset, sectionCount, resourceRva);
  const namedEntries = contents.readUInt16LE(resourceOffset + 12);
  const idEntries = contents.readUInt16LE(resourceOffset + 14);
  const resourceTypeIds = [];
  const resourceEntries = new Map();
  for (let index = 0; index < namedEntries + idEntries; index += 1) {
    const entryOffset = resourceOffset + 16 + (index * 8);
    const nameOrId = contents.readUInt32LE(entryOffset);
    if ((nameOrId & 0x80000000) === 0) {
      resourceTypeIds.push(nameOrId);
      resourceEntries.set(nameOrId, contents.readUInt32LE(entryOffset + 4));
    }
  }

  function firstResourceData(typeId) {
    let child = resourceEntries.get(typeId);
    assert.notEqual(child, undefined, `PE resource type ${typeId} must exist`);
    for (let depth = 0; depth < 2; depth += 1) {
      assert.notEqual(child & 0x80000000, 0, `PE resource type ${typeId} level ${depth} must be a directory`);
      const directoryOffset = resourceOffset + (child & 0x7fffffff);
      const count = contents.readUInt16LE(directoryOffset + 12) + contents.readUInt16LE(directoryOffset + 14);
      assert.ok(count > 0, `PE resource type ${typeId} level ${depth} must not be empty`);
      child = contents.readUInt32LE(directoryOffset + 16 + 4);
    }
    assert.equal(child & 0x80000000, 0, `PE resource type ${typeId} language must reference data`);
    const dataEntryOffset = resourceOffset + child;
    const dataRva = contents.readUInt32LE(dataEntryOffset);
    const dataSize = contents.readUInt32LE(dataEntryOffset + 4);
    const dataOffset = rvaToFileOffset(contents, sectionTableOffset, sectionCount, dataRva);
    return contents.subarray(dataOffset, dataOffset + dataSize);
  }

  const versionResource = firstResourceData(16);
  const fixedInfoSignature = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);
  const fixedInfoOffset = versionResource.indexOf(fixedInfoSignature);
  assert.ok(fixedInfoOffset >= 0, "RT_VERSION must contain VS_FIXEDFILEINFO");
  const dottedVersion = (mostSignificant, leastSignificant) => [
    mostSignificant >>> 16,
    mostSignificant & 0xffff,
    leastSignificant >>> 16,
    leastSignificant & 0xffff,
  ].join(".");
  const fileVersion = dottedVersion(
    versionResource.readUInt32LE(fixedInfoOffset + 8),
    versionResource.readUInt32LE(fixedInfoOffset + 12),
  );
  const productVersion = dottedVersion(
    versionResource.readUInt32LE(fixedInfoOffset + 16),
    versionResource.readUInt32LE(fixedInfoOffset + 20),
  );
  const manifest = firstResourceData(24).toString("utf8").replace(/^\uFEFF/, "");

  return { characteristics, fileVersion, manifest, productVersion, resourceTypeIds, subsystem };
}

async function waitForFile(filename, attempts = 200, delayMs = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await stat(filename);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT" || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function listenOnEphemeralPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return { port: address.port, server };
}

test("isolated recovery command starts and stops only its deterministic state and refuses an occupied port", {
  skip: process.platform !== "win32",
  timeout: 15_000,
}, async () => {
  const temporaryParent = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-isolated-recovery-"));
  const packageRoot = path.join(temporaryParent, "새 복구 패키지");
  const localAppData = path.join(temporaryParent, "Local App Data");
  const marker = path.join(temporaryParent, "launcher-invocation.txt");
  const command = path.join(packageRoot, "Tarkov Helper 격리 복구 실행.cmd");
  await mkdir(packageRoot, { recursive: true });

  try {
    const commandSource = await readFile(isolatedRecoveryCommand, "ascii");
    assert.match(commandSource, /set "TARKOV_HELPER_ISOLATED_PORT=41753"/);
    assert.doesNotMatch(commandSource, /TEST_(?:MODE|PORT)/);
    const freeProbe = await listenOnEphemeralPort();
    const freePort = freeProbe.port;
    await new Promise((resolve, reject) => freeProbe.server.close((error) => error ? reject(error) : resolve()));
    await writeFile(
      command,
      commandSource.replace(
        'set "TARKOV_HELPER_ISOLATED_PORT=41753"',
        `set "TARKOV_HELPER_ISOLATED_PORT=${freePort}"`,
      ),
      "ascii",
    );
    await writeFile(path.join(packageRoot, "launcher.ps1"), String.raw`param(
  [ValidateSet("Start", "Stop")][string]$Action,
  [string]$StateDirectory,
  [int]$Port,
  [switch]$DisablePackageUpdates
)
[IO.File]::WriteAllText(
  $env:TARKOV_HELPER_ISOLATED_RECOVERY_TEST_MARKER,
  ($Action + [Environment]::NewLine + $StateDirectory + [Environment]::NewLine + $Port + [Environment]::NewLine + $DisablePackageUpdates.IsPresent),
  [Text.UTF8Encoding]::new($false)
)
exit 0
`, "utf8");

    const environment = {
      ...process.env,
      LOCALAPPDATA: localAppData,
      TARKOV_HELPER_ISOLATED_RECOVERY_TEST_MARKER: marker,
    };

    const started = spawnSync("cmd.exe", ["/d", "/c", command], {
      cwd: packageRoot,
      encoding: "utf8",
      env: environment,
      windowsHide: true,
    });
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
    assert.deepEqual((await readFile(marker, "utf8")).trim().split(/\r?\n/), [
      "Start",
      path.join(localAppData, "TarkovHelperWeb-Isolated-Recovery"),
      String(freePort),
      "True",
    ]);

    const stopped = spawnSync("cmd.exe", ["/d", "/c", command, "stop"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: environment,
      windowsHide: true,
    });
    assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.deepEqual((await readFile(marker, "utf8")).trim().split(/\r?\n/), [
      "Stop",
      path.join(localAppData, "TarkovHelperWeb-Isolated-Recovery"),
      String(freePort),
      "True",
    ]);

    const occupied = await listenOnEphemeralPort();
    await writeFile(
      command,
      commandSource.replace(
        'set "TARKOV_HELPER_ISOLATED_PORT=41753"',
        `set "TARKOV_HELPER_ISOLATED_PORT=${occupied.port}"`,
      ),
      "ascii",
    );
    await rm(marker, { force: true });
    const refused = spawnSync("cmd.exe", ["/d", "/c", command, "start"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: environment,
      windowsHide: true,
    });
    await new Promise((resolve, reject) => occupied.server.close((error) => error ? reject(error) : resolve()));
    assert.equal(refused.status, 2, `${refused.stdout}\n${refused.stderr}`);
    assert.match(`${refused.stdout}\n${refused.stderr}`, /already in use|stop the existing/i);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    await rm(temporaryParent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

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
    assert.equal((await stat(path.join(output, "app", "data", "weapon-modding", "catalog.json"))).isFile(), true);
    assert.equal((await stat(path.join(output, "app", "LICENSE"))).isFile(), true);
    assert.equal((await stat(path.join(output, "app", "THIRD_PARTY_NOTICES.md"))).isFile(), true);
    assert.equal((await stat(path.join(output, "launcher.ps1"))).isFile(), true);
    assert.equal((await stat(path.join(output, "app-update-worker.ps1"))).isFile(), true);
    assert.equal((await stat(path.join(output, "app-update-broker.ps1"))).isFile(), true);
    assert.equal((await stat(path.join(output, "TarkovHelper.ico"))).isFile(), true);
    assert.deepEqual(await readIconSizes(path.join(output, "TarkovHelper.ico")), [16, 20, 24, 32, 40, 48, 64, 128, 256]);
    const launcherExe = path.join(output, "Tarkov Helper.exe");
    assert.equal((await stat(launcherExe)).isFile(), true);
    const launcherPe = await readLauncherPeMetadata(launcherExe);
    assert.notEqual(launcherPe.characteristics & 0x0002, 0, "launcher must be marked executable");
    assert.equal(launcherPe.subsystem, 2, "launcher must be a windowed app with no console");
    assert.ok(launcherPe.resourceTypeIds.includes(3), "launcher must embed RT_ICON resources");
    assert.ok(launcherPe.resourceTypeIds.includes(14), "launcher must embed an RT_GROUP_ICON resource");
    assert.ok(launcherPe.resourceTypeIds.includes(16), "launcher must embed RT_VERSION");
    assert.ok(launcherPe.resourceTypeIds.includes(24), "launcher must embed RT_MANIFEST");
    assert.equal(launcherPe.fileVersion, `${packageVersion}.0`);
    assert.equal(launcherPe.productVersion, `${packageVersion}.0`);
    assert.match(launcherPe.manifest, /requestedExecutionLevel\s+level="asInvoker"/);
    assert.match(launcherPe.manifest, /<ws2:longPathAware>true<\/ws2:longPathAware>/);
    assert.equal((await stat(path.join(output, "start-menu.ps1"))).isFile(), true);
    assert.equal((await stat(path.join(output, "Tarkov Helper 시작 메뉴 등록.vbs"))).isFile(), true);
    assert.equal((await stat(path.join(output, "Tarkov Helper 시작 메뉴 제거.vbs"))).isFile(), true);
    assert.equal((await stat(path.join(output, "UPDATE_CONFIG.json"))).isFile(), true);
    assert.equal((await stat(path.join(output, "Tarkov Helper 실행.vbs"))).isFile(), true);
    assert.equal((await stat(path.join(output, "Tarkov Helper 종료.vbs"))).isFile(), true);
    assert.equal((await stat(path.join(output, "문제 해결용 실행.cmd"))).isFile(), true);
    assert.equal((await stat(path.join(output, "Tarkov Helper 상태 복구.cmd"))).isFile(), true);
    assert.equal((await stat(path.join(output, "Tarkov Helper 격리 복구 실행.cmd"))).isFile(), true);
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
    const repairCommand = await readFile(path.join(output, "Tarkov Helper 상태 복구.cmd"), "utf8");
    const isolatedRecovery = await readFile(path.join(output, "Tarkov Helper 격리 복구 실행.cmd"), "utf8");
    assert.match(guide, /시작 메뉴/);
    assert.match(guide, /등록/);
    assert.match(guide, /제거/);
    assert.match(guide, /실행\.vbs/);
    assert.match(guide, /종료\.vbs/);
    assert.match(guide, /백그라운드/);
    assert.match(guide, /v1\.0\.3과 v1\.0\.4/);
    assert.match(guide, /v1\.0\.1과 v1\.0\.2/);
    assert.match(guide, /v1\.0\.20 이하.*회사 프록시/);
    assert.match(guide, /기존 폴더 위에 덮어쓰지/);
    assert.match(guide, /%USERPROFILE%\\TarkovHelper/);
    assert.match(guide, /Tarkov Helper 상태 복구\.cmd/);
    assert.match(guide, /Tarkov Helper 격리 복구 실행\.cmd/);
    assert.match(repairCommand, /-Action Repair/i);
    assert.match(isolatedRecovery, /TarkovHelperWeb-Isolated-Recovery/);
    assert.match(isolatedRecovery, /set "TARKOV_HELPER_ISOLATED_PORT=41753"/);
    assert.match(isolatedRecovery, /TcpListener/);
    assert.match(isolatedRecovery, /ExclusiveAddressUse\s*=\s*\$true/);
    assert.match(isolatedRecovery, /-Action %TARKOV_HELPER_ISOLATED_ACTION%/i);
    assert.match(isolatedRecovery, /-StateDirectory "%TARKOV_HELPER_ISOLATED_STATE%"/i);
    assert.match(isolatedRecovery, /-DisablePackageUpdates/i);
    assert.doesNotMatch(isolatedRecovery, /\b(?:del|erase|rd|rmdir)\b/i);

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

test("launcher source builds byte-for-byte identically from different build roots", {
  skip: process.platform !== "win32",
  timeout: 20_000,
}, async () => {
  const temporaryParent = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-launcher-builds-"));
  const roots = [
    path.join(temporaryParent, "빌드 루트 A"),
    path.join(temporaryParent, "different build root B"),
  ];
  try {
    for (const root of roots) {
      await mkdir(root, { recursive: true });
      await copyFile(path.join(launcherSourceDirectory, "TarkovHelperLauncher.cs"), path.join(root, "TarkovHelperLauncher.cs"));
      await copyFile(path.join(launcherSourceDirectory, "TarkovHelperLauncher.manifest"), path.join(root, "TarkovHelperLauncher.manifest"));
      await copyFile(path.join(projectRoot, "portable", "TarkovHelper.ico"), path.join(root, "TarkovHelper.ico"));
      const result = spawnSync(process.execPath, [
        launcherBuildScript,
        "--source", path.join(root, "TarkovHelperLauncher.cs"),
        "--manifest", path.join(root, "TarkovHelperLauncher.manifest"),
        "--icon", path.join(root, "TarkovHelper.ico"),
        "--output", path.join(root, "output", "Tarkov Helper.exe"),
        "--version", packageVersion,
      ], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }
    assert.equal(
      await sha256(path.join(roots[0], "output", "Tarkov Helper.exe")),
      await sha256(path.join(roots[1], "output", "Tarkov Helper.exe")),
      "launcher compilation must not copy a prebuilt binary or depend on its build root",
    );
  } finally {
    await rm(temporaryParent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("launcher source uses an exact parent identity gate and starts launcher.ps1 without Windows Script Host", async () => {
  const source = await readFile(path.join(launcherSourceDirectory, "TarkovHelperLauncher.cs"), "utf8");
  assert.match(source, /Process\.GetCurrentProcess\(\)/);
  assert.match(source, /StartTime\.ToUniversalTime\(\)\.Ticks/);
  assert.match(source, /GetProcessById/);
  assert.match(source, /parentStartUtcTicks/);
  assert.match(source, /WaitForExit\(30000\)/);
  assert.match(source, /Encoding\.Unicode\.GetBytes/);
  assert.match(source, /-EncodedCommand/);
  assert.match(source, /Encoding\.UTF8\.GetBytes/);
  assert.match(source, /FromBase64String/);
  assert.match(source, /UseShellExecute\s*=\s*false/);
  assert.match(source, /SpecialFolder\.LocalApplicationData/);
  assert.match(source, /WindowsPowerShell/);
  assert.match(source, /LauncherScriptName\s*=\s*"launcher\.ps1"/);
  assert.match(source, /-Action Start/);
  assert.match(source, /-Action Stop/);
  assert.match(source, /System\.Windows\.Forms\.MessageBox/);
  assert.match(source, /문제 해결용 실행\.cmd/);
  assert.match(source, /Launcher bootstrap failed with exit code/);
  assert.doesNotMatch(source, /AppendAllText\(\$bootstrapLog,\s*\$_/);
  assert.doesNotMatch(source, /wscript\.exe/i);
  assert.match(source, /launcher-bootstrap\.log/);
  assert.match(source, /MessageBoxW/);
  assert.match(source, /CharSet\.Unicode/);
  assert.match(source, /-ExecutionPolicy Bypass/);
  assert.doesNotMatch(source, /cmd\.exe/i);
  assert.doesNotMatch(source, /TARKOV_HELPER_PACKAGE_ROOT/);
});

test("the branded launcher starts launcher.ps1 without VBS from a literal Unicode path and releases the package root", {
  skip: process.platform !== "win32",
  timeout: 20_000,
}, async () => {
  const temporaryParent = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-launcher-exe-"));
  const packageRoot = path.join(temporaryParent, "한글 %TEMP% & (특수), O'Brien 패키지");
  const movedRoot = path.join(temporaryParent, "실행 중 교체 완료");
  const marker = path.join(temporaryParent, "launcher-started.marker");
  const exitMarker = path.join(temporaryParent, "launcher-finished.marker");
  const actionLog = path.join(temporaryParent, "launcher-actions.log");
  const firstStartState = path.join(temporaryParent, "first-start.state");

  try {
    const packaged = spawnSync(process.execPath, [packagingScript, "--output", packageRoot], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.equal(packaged.status, 0, `${packaged.stdout}\n${packaged.stderr}`);
    await rm(path.join(packageRoot, "Tarkov Helper 실행.vbs"));

    await writeFile(path.join(packageRoot, "launcher.ps1"), String.raw`param([ValidateSet("Start", "Stop")][string]$Action)
[IO.File]::AppendAllText($env:TARKOV_HELPER_TEST_ACTION_LOG, $Action + [Environment]::NewLine, [Text.Encoding]::UTF8)
if ($Action -eq "Start" -and -not [IO.File]::Exists($env:TARKOV_HELPER_TEST_FIRST_START)) {
  [IO.File]::WriteAllText($env:TARKOV_HELPER_TEST_FIRST_START, "failed once", [Text.Encoding]::UTF8)
  exit 23
}
if ($Action -eq "Stop") { exit 0 }
[IO.File]::WriteAllText($env:TARKOV_HELPER_TEST_MARKER, $PSScriptRoot, [Text.Encoding]::UTF8)
Start-Sleep -Seconds 4
[IO.File]::WriteAllText($env:TARKOV_HELPER_TEST_EXIT_MARKER, "finished", [Text.Encoding]::UTF8)
exit 0
`, "utf8");

    const launched = spawnSync(path.join(packageRoot, "Tarkov Helper.exe"), [], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        TARKOV_HELPER_TEST_MARKER: marker,
        TARKOV_HELPER_TEST_EXIT_MARKER: exitMarker,
        TARKOV_HELPER_TEST_ACTION_LOG: actionLog,
        TARKOV_HELPER_TEST_FIRST_START: firstStartState,
      },
      timeout: 3_000,
      windowsHide: true,
    });
    assert.equal(launched.status, 0, `${launched.stdout}\n${launched.stderr}\n${launched.error ?? ""}`);
    await waitForFile(marker);
    assert.deepEqual((await readFile(actionLog, "utf8")).replace(/^\uFEFF/, "").trim().split(/\r?\n/), [
      "Start",
      "Stop",
      "Start",
    ]);
    assert.equal(
      (await realpath((await readFile(marker, "utf8")).replace(/^\uFEFF/, ""))).toLowerCase(),
      (await realpath(packageRoot)).toLowerCase(),
    );

    await rename(packageRoot, movedRoot);
    await waitForFile(exitMarker);
    assert.equal((await readFile(exitMarker, "utf8")).replace(/^\uFEFF/, ""), "finished");
  } finally {
    await rm(temporaryParent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
