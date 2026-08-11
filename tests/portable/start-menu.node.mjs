import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const portableRoot = path.join(projectRoot, "portable");
const startMenuScript = path.join(portableRoot, "start-menu.ps1");
const iconPath = path.join(portableRoot, "TarkovHelper.ico");
const launcherName = "Tarkov Helper 실행.vbs";
const shortcutName = "Tarkov Helper.lnk";
const ownershipMarker = "TarkovHelperWeb.StartMenu.v1";

function runPowerShell(script, args = [], options = {}) {
  return spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    ...args,
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    windowsHide: true,
  });
}

function runStartMenu(action, packageRoot, programsDirectory) {
  return runPowerShell(startMenuScript, [
    "-Action",
    action,
    "-PackageRoot",
    packageRoot,
    "-ProgramsDirectory",
    programsDirectory,
  ]);
}

async function makePackage(parent, leaf) {
  const packageRoot = path.join(parent, leaf);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, launcherName), "' test launcher\r\n", "utf8");
  await copyFile(iconPath, path.join(packageRoot, "TarkovHelper.ico"));
  return packageRoot;
}

async function makeShortcutTools(parent) {
  const foreignWriter = path.join(parent, "write-foreign-shortcut.ps1");
  await writeFile(foreignWriter, String.raw`param([Parameter(Mandatory=$true)][string]$Path)
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($Path)
$shortcut.TargetPath = Join-Path $env:SystemRoot "System32\notepad.exe"
$shortcut.WorkingDirectory = $env:SystemRoot
$shortcut.Description = "Foreign.Application"
$shortcut.Save()
`, "utf8");
  return { foreignWriter };
}

function outputOf(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

async function assertSamePath(actual, expected) {
  assert.equal((await realpath(actual)).toLowerCase(), (await realpath(expected)).toLowerCase());
}

async function assertLauncherArguments(actual, expectedLauncherPath) {
  const match = /^\/\/Nologo "([^"]+)"$/.exec(actual);
  assert.ok(match, `Unexpected shortcut arguments: ${actual}`);
  await assertSamePath(match[1], expectedLauncherPath);
}

async function assertIconLocation(actual, expectedIconPath) {
  const match = /^(.*),0$/.exec(actual);
  assert.ok(match, `Unexpected shortcut icon location: ${actual}`);
  await assertSamePath(match[1], expectedIconPath);
}

async function assertNoStartMenuTemporaryFiles(programsDirectory) {
  assert.deepEqual(
    (await readdir(programsDirectory)).filter((name) => name.startsWith("TarkovHelperWeb.StartMenu.")),
    [],
  );
}

async function assertUnicodeShellLink(shortcutPath) {
  const contents = await readFile(shortcutPath);
  assert.ok(contents.length >= 0x4c, "Shell Link header is truncated");
  assert.equal(contents.readUInt32LE(0), 0x4c, "Shell Link header size must be 0x4c");
  assert.notEqual(contents.readUInt32LE(0x14) & 0x80, 0, "Shell Link must set the IsUnicode flag");
}

async function shortcutProperties(shortcutPath) {
  const result = runPowerShell(startMenuScript, ["-Action", "Inspect", "-ShortcutPath", shortcutPath]);
  assert.equal(result.status, 0, outputOf(result));
  return JSON.parse(result.stdout.trim());
}

test("registers, verifies, retargets, and removes an owned per-user Start shortcut", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-start-menu-"));
  const programsDirectory = path.join(temporaryRoot, "Programs 임시 % 폴더");
  const packageA = await makePackage(temporaryRoot, "패키지 A %TEMP%, 테스트");
  const packageB = await makePackage(temporaryRoot, "패키지 B (새 위치)");
  const shortcutPath = path.join(programsDirectory, shortcutName);

  try {
    const first = runStartMenu("Register", packageA, programsDirectory);
    assert.equal(first.status, 0, outputOf(first));
    await assertNoStartMenuTemporaryFiles(programsDirectory);
    await assertUnicodeShellLink(shortcutPath);
    assert.equal((await stat(shortcutPath)).isFile(), true);

    const expectedTarget = path.join(process.env.SystemRoot, "System32", "wscript.exe");
    const firstProperties = await shortcutProperties(shortcutPath);
    await assertSamePath(firstProperties.TargetPath, expectedTarget);
    await assertLauncherArguments(firstProperties.Arguments, path.join(packageA, launcherName));
    await assertSamePath(firstProperties.WorkingDirectory, process.env.LOCALAPPDATA);
    await assertIconLocation(firstProperties.IconLocation, path.join(packageA, "TarkovHelper.ico"));
    assert.equal(firstProperties.Description, ownershipMarker);

    const repeated = runStartMenu("Register", packageA, programsDirectory);
    assert.equal(repeated.status, 0, outputOf(repeated));
    await assertNoStartMenuTemporaryFiles(programsDirectory);
    await assertSamePath((await shortcutProperties(shortcutPath)).TargetPath, expectedTarget);

    const retargeted = runStartMenu("Register", packageB, programsDirectory);
    assert.equal(retargeted.status, 0, outputOf(retargeted));
    await assertNoStartMenuTemporaryFiles(programsDirectory);
    const movedProperties = await shortcutProperties(shortcutPath);
    await assertLauncherArguments(movedProperties.Arguments, path.join(packageB, launcherName));
    await assertSamePath(movedProperties.WorkingDirectory, process.env.LOCALAPPDATA);
    await assertIconLocation(movedProperties.IconLocation, path.join(packageB, "TarkovHelper.ico"));

    const removed = runStartMenu("Unregister", packageB, programsDirectory);
    assert.equal(removed.status, 0, outputOf(removed));
    await assert.rejects(stat(shortcutPath), { code: "ENOENT" });

    const repeatedRemoval = runStartMenu("Unregister", packageB, programsDirectory);
    assert.equal(repeatedRemoval.status, 0, outputOf(repeatedRemoval));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("refuses to overwrite or remove a foreign shortcut with the same name", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-start-menu-foreign-"));
  const programsDirectory = path.join(temporaryRoot, "Programs");
  const packageRoot = await makePackage(temporaryRoot, "Package");
  const shortcutPath = path.join(programsDirectory, shortcutName);
  const unrelatedPath = path.join(programsDirectory, "Keep me.txt");
  const { foreignWriter } = await makeShortcutTools(temporaryRoot);

  try {
    await mkdir(programsDirectory, { recursive: true });
    await writeFile(unrelatedPath, "keep", "utf8");
    const foreign = runPowerShell(foreignWriter, ["-Path", shortcutPath]);
    assert.equal(foreign.status, 0, outputOf(foreign));
    const before = await shortcutProperties(shortcutPath);
    const beforeBytes = await readFile(shortcutPath);

    const registration = runStartMenu("Register", packageRoot, programsDirectory);
    assert.notEqual(registration.status, 0);
    assert.match(outputOf(registration), /belongs to another application/i);
    assert.deepEqual(await shortcutProperties(shortcutPath), before);
    assert.deepEqual(await readFile(shortcutPath), beforeBytes);

    const removal = runStartMenu("Unregister", packageRoot, programsDirectory);
    assert.notEqual(removal.status, 0);
    assert.match(outputOf(removal), /belongs to another application/i);
    assert.deepEqual(await shortcutProperties(shortcutPath), before);
    assert.deepEqual(await readFile(shortcutPath), beforeBytes);
    assert.equal(await readFile(unrelatedPath, "utf8"), "keep");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("fails before mutation when launcher or icon is missing", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-start-menu-missing-"));
  const programsDirectory = path.join(temporaryRoot, "Programs");
  const packageRoot = path.join(temporaryRoot, "Incomplete package");
  const shortcutPath = path.join(programsDirectory, shortcutName);

  try {
    await mkdir(packageRoot, { recursive: true });
    const withoutLauncher = runStartMenu("Register", packageRoot, programsDirectory);
    assert.notEqual(withoutLauncher.status, 0);
    await assert.rejects(stat(shortcutPath), { code: "ENOENT" });

    await writeFile(path.join(packageRoot, launcherName), "' test launcher\r\n", "utf8");
    const withoutIcon = runStartMenu("Register", packageRoot, programsDirectory);
    assert.notEqual(withoutIcon.status, 0);
    await assert.rejects(stat(shortcutPath), { code: "ENOENT" });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("all VBS entry points use system PowerShell without expanding package paths", async () => {
  for (const [filename, scriptName, action] of [
    ["Tarkov Helper 실행.vbs", "launcher.ps1", "Start"],
    ["Tarkov Helper 종료.vbs", "launcher.ps1", "Stop"],
    ["Tarkov Helper 시작 메뉴 등록.vbs", "start-menu.ps1", "Register"],
    ["Tarkov Helper 시작 메뉴 제거.vbs", "start-menu.ps1", "Unregister"],
  ]) {
    const contents = await readFile(path.join(portableRoot, filename), "utf8");
    assert.match(contents, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/i);
    assert.match(contents, /shell\.CurrentDirectory\s*=\s*runtimeRoot/i);
    assert.match(contents, /TARKOV_HELPER_PACKAGE_ROOT/);
    assert.match(contents, /-Command/);
    assert.match(contents, new RegExp(`powerShellCommand[\\s\\S]*${scriptName.replace(".", "\\.")}`));
    assert.match(contents, new RegExp(`-Action ${action}`));
    assert.match(contents, /shell\.Run\(command(?:Line)?, 0, True\)/i);
    assert.doesNotMatch(contents, /cmd\.exe/i);
  }
});

test("creates and inspects shortcuts through the native Unicode Shell Link interfaces", async () => {
  const contents = await readFile(startMenuScript, "utf8");
  assert.match(contents, /IShellLinkW/);
  assert.match(contents, /IPersistFile/);
  assert.match(contents, /UnmanagedType\.LPWStr/);
  assert.doesNotMatch(contents, /New-Object\s+-ComObject\s+WScript\.Shell/i);
});

test("launch and stop wrappers preserve a literal environment-variable folder name", {
  skip: process.platform !== "win32",
}, async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-wrapper-"));
  const packageRoot = path.join(temporaryRoot, "게임 %TEMP% 문자 그대로");
  try {
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, "launcher.ps1"), String.raw`param([ValidateSet("Start", "Stop")][string]$Action)
[IO.File]::WriteAllText((Join-Path $PSScriptRoot ($Action + ".marker")), $PSScriptRoot, [Text.Encoding]::UTF8)
exit 0
`, "utf8");
    for (const [filename, action] of [
      ["Tarkov Helper 실행.vbs", "Start"],
      ["Tarkov Helper 종료.vbs", "Stop"],
    ]) {
      const wrapperPath = path.join(packageRoot, filename);
      await copyFile(path.join(portableRoot, filename), wrapperPath);
      const result = spawnSync("cscript.exe", ["//Nologo", wrapperPath], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      });
      assert.equal(result.status, 0, outputOf(result));
      const recordedRoot = (await readFile(path.join(packageRoot, `${action}.marker`), "utf8")).replace(/^\uFEFF/, "");
      await assertSamePath(recordedRoot, packageRoot);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("the waiting launch wrapper does not hold the package directory open during an update swap", {
  skip: process.platform !== "win32",
  timeout: 15_000,
}, async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-wrapper-swap-"));
  const packageRoot = path.join(temporaryRoot, "배포 %TEMP% 폴더");
  const movedRoot = path.join(temporaryRoot, "배포 교체됨");
  const markerPath = path.join(temporaryRoot, "wrapper-ready.txt");
  let child;
  try {
    await mkdir(packageRoot, { recursive: true });
    await copyFile(path.join(portableRoot, "Tarkov Helper 실행.vbs"), path.join(packageRoot, "Tarkov Helper 실행.vbs"));
    await writeFile(path.join(packageRoot, "launcher.ps1"), String.raw`param([ValidateSet("Start", "Stop")][string]$Action)
[IO.File]::WriteAllText($env:TARKOV_HELPER_TEST_MARKER, [Environment]::CurrentDirectory, [Text.Encoding]::UTF8)
Start-Sleep -Seconds 5
exit 0
`, "utf8");
    child = spawn("cscript.exe", ["//Nologo", path.join(packageRoot, "Tarkov Helper 실행.vbs")], {
      env: { ...process.env, TARKOV_HELPER_TEST_MARKER: markerPath },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await stat(markerPath);
        break;
      } catch (error) {
        if (error?.code !== "ENOENT" || attempt === 99) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    await rename(packageRoot, movedRoot);
    assert.notEqual((await readFile(markerPath, "utf8")).replace(/^\uFEFF/, ""), packageRoot);
  } finally {
    if (child?.exitCode === null) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
