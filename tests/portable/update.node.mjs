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
const requiredPortableFiles = [
  "TarkovHelper.ico",
  "start-menu.ps1",
  "Tarkov Helper 실행.vbs",
  "Tarkov Helper 시작 메뉴 등록.vbs",
  "Tarkov Helper 시작 메뉴 제거.vbs",
  "Tarkov Helper 종료.vbs",
  "문제 해결용 실행.cmd",
  "Tarkov Helper 상태 복구.cmd",
  "Tarkov Helper 격리 복구 실행.cmd",
  "사용 안내.txt",
];
const powershell = "powershell.exe";
const repository = "example-owner/example-repository";
const oldCommit = "1".repeat(40);
const newCommit = "2".repeat(40);

test("the PowerShell updater is UTF-8 BOM encoded for Windows PowerShell", async () => {
  const bytes = await readFile(workerPath);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test("the staged-package contract requires every shipped recovery entry point", async () => {
  const worker = await readFile(workerPath, "utf8");
  const stagedContract = /function Assert-StagedPackage \{([\s\S]*?)\n\}/.exec(worker)?.[1] ?? "";
  for (const required of [
    "Tarkov Helper 종료.vbs",
    "문제 해결용 실행.cmd",
    "Tarkov Helper 상태 복구.cmd",
    "Tarkov Helper 격리 복구 실행.cmd",
    "사용 안내.txt",
  ]) {
    assert.match(stagedContract, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("worker and broker logs share the bounded redacted logging contract", async () => {
  for (const scriptPath of [workerPath, brokerPath]) {
    const source = await readFile(scriptPath, "utf8");
    assert.match(source, /function Protect-UpdateLogMessage/);
    assert.match(source, /function Rotate-UpdateLogFile/);
    assert.match(source, /protectedUpdateLogPaths = \[Collections\.Generic\.HashSet\[string\]\]/);
    assert.match(source, /if \(-not \$script:protectedUpdateLogPaths\.Contains\(\$candidateLogPath\)\)/);
    assert.match(source, /WaitOne\(200\)/);
    assert.match(source, /1048576/);
    assert.match(source, /\.previous/);
  }
  const launcher = await readFile(launcherPath, "utf8");
  const broker = await readFile(brokerPath, "utf8");
  for (const source of [launcher, broker]) {
    assert.doesNotMatch(source, /RedirectStandard(?:Output|Error)/);
    assert.doesNotMatch(source, /(?:server|worker|update-new|update-rollback)\.(?:stdout|stderr)\.log/);
  }
});

test("shared update transactions use one cross-session sibling file lock", async () => {
  const [launcher, worker, broker] = await Promise.all([
    readFile(launcherPath, "utf8"),
    readFile(workerPath, "utf8"),
    readFile(brokerPath, "utf8"),
  ]);
  for (const source of [launcher, worker, broker]) {
    assert.match(source, /function Enter-AppUpdateTransactionLock/);
    assert.match(source, /Join-Path \([^\r\n]+\) "app-update\.transaction\.lock"/);
    assert.match(source, /FileShare\]::None/);
  }
  const brokerAcquire = broker.indexOf("$transactionLock = Enter-AppUpdateTransactionLock");
  const brokerPlanRead = broker.indexOf("$plan = Read-BoundedJson -Path $PlanPath");
  assert.ok(brokerAcquire >= 0 && brokerAcquire < brokerPlanRead, "broker must lock before reading transaction state");
  const stageFunction = /function Invoke-Stage \{([\s\S]*?)\n\}/.exec(worker)?.[1] ?? "";
  assert.match(stageFunction, /SafeZip\]::Extract[\s\S]*Enter-AppUpdateTransactionLock[\s\S]*Write-AtomicJson -Path \(Get-PendingPath\)/);
  assert.doesNotMatch(stageFunction.slice(0, stageFunction.indexOf("SafeZip]::Extract")), /Enter-AppUpdateTransactionLock/);
});

test("terminal cleanup keeps candidate cleanup and failed trees inside the authenticated transaction boundary", async () => {
  const launcher = await readFile(launcherPath, "utf8");
  const terminalRecovery = /function Complete-PendingAppUpdateCommittedCleanupRecovery \{([\s\S]*?)\n\}/.exec(launcher)?.[1] ?? "";
  const staleArchive = /function Try-ArchiveStalePendingAppUpdate \{([\s\S]*?)\n\}/.exec(launcher)?.[1] ?? "";
  const repair = /function Repair-PortableState \{([\s\S]*?)\n\}/.exec(launcher)?.[1] ?? "";

  assert.match(terminalRecovery, /\.update-cleanup-.*candidateId/);
  assert.match(terminalRecovery, /10000/);
  assert.match(terminalRecovery, /1073741824/);
  assert.match(terminalRecovery, /Remove-LegacyAppUpdateTreeNoReparse/);
  assert.match(terminalRecovery, /for \(\$attempt = 0; \$attempt -lt 8;/);
  assert.match(terminalRecovery, /Test-LegacyAppUpdateTreeBoundedNoReparse/);
  for (const scope of [staleArchive, repair]) {
    assert.match(scope, /\.update-cleanup-.*candidateId/);
    assert.match(scope, /\.update-failed-.*candidateId/);
  }
});

test("offline COMMITTED recovery accepts an explicit no-child proof and retires a live exact child only after bounded exit", async () => {
  const launcher = await readFile(launcherPath, "utf8");
  const terminalRecovery = /function Complete-PendingAppUpdateCommittedCleanupRecovery \{([\s\S]*?)\n\}/.exec(launcher)?.[1] ?? "";

  assert.match(terminalRecovery, /serverPid[^\r\n]+-eq 0[^\r\n]+serverProcessStartTimeUtc[^\r\n]+Length[^\r\n]+-eq 0/);
  assert.match(terminalRecovery, /GetProcessById/);
  assert.match(terminalRecovery, /\.Kill\(\)/);
  assert.match(terminalRecovery, /WaitForExit\(5000\)/);
  assert.match(terminalRecovery, /return \$false/);
});

test("the runtime sanitizer removes short named secrets and multiline injection", { skip: process.platform !== "win32" }, () => {
  const canaries = [
    "apiKey=short-api", "claimId=short-claim", "overlayId=short-overlay",
    "candidateId=short-candidate", "healthNonce=short-health", "updateNonce=short-update",
    "controlToken=short-control", "leaseToken=short-lease",
  ];
  const opaqueCredential = `--${"A".repeat(39)}--`;
  const longOpaqueCredential = `--${"C".repeat(100)}--`;
  const boundaryCredential = `--${"B".repeat(39)}--`;
  const boundaryQuotedSecret = "\u0085".repeat(16_184) + `password="FIRSTPART ${"S".repeat(500)}"`;
  for (const [scriptPath, functionName] of [
    [launcherPath, "Protect-PortableLogMessage"],
    [workerPath, "Protect-UpdateLogMessage"],
    [brokerPath, "Protect-UpdateLogMessage"],
  ]) {
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", [
      "$tokens = $null; $errors = $null",
      "$ast = [Management.Automation.Language.Parser]::ParseFile($env:TARKOV_HELPER_LOG_SCRIPT, [ref]$tokens, [ref]$errors)",
      "if ($errors.Count -ne 0) { exit 2 }",
      "$function = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $env:TARKOV_HELPER_LOG_FUNCTION }, $true) | Select-Object -First 1",
      "if ($null -eq $function) { exit 3 }",
      "Invoke-Expression $function.Extent.Text",
      "$caseNames = @('API_KEY','CLAIM_ID','OVERLAY_ID','CANDIDATE_ID','HEALTH_NONCE','UPDATE_NONCE','CONTROL_TOKEN','LEASE_TOKEN','QUOTED','URL','FILE_URI','PATH','APOSTROPHE_PATH','COOKIE','HEADER','JSON_PASSWORD','JSON_API_KEY','OPAQUE','LONG_OPAQUE','BOUNDARY_OPAQUE','UNTERMINATED','BOUNDARY_QUOTED','CONTROLS')",
      "foreach ($caseName in $caseNames) { & $env:TARKOV_HELPER_LOG_FUNCTION ([Environment]::GetEnvironmentVariable(('TARKOV_HELPER_LOG_CASE_' + $caseName))) }",
    ].join("; ")], {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        TARKOV_HELPER_LOG_SCRIPT: scriptPath,
        TARKOV_HELPER_LOG_FUNCTION: functionName,
        TARKOV_HELPER_LOG_CASE_API_KEY: canaries[0],
        TARKOV_HELPER_LOG_CASE_CLAIM_ID: canaries[1],
        TARKOV_HELPER_LOG_CASE_OVERLAY_ID: canaries[2],
        TARKOV_HELPER_LOG_CASE_CANDIDATE_ID: canaries[3],
        TARKOV_HELPER_LOG_CASE_HEALTH_NONCE: canaries[4],
        TARKOV_HELPER_LOG_CASE_UPDATE_NONCE: canaries[5],
        TARKOV_HELPER_LOG_CASE_CONTROL_TOKEN: canaries[6],
        TARKOV_HELPER_LOG_CASE_LEASE_TOKEN: canaries[7],
        TARKOV_HELPER_LOG_CASE_QUOTED: 'token="quoted secret canary"',
        TARKOV_HELPER_LOG_CASE_URL: "https://canary-user:canary-pass@example.test/path?apiKey=query-canary#fragment-canary",
        TARKOV_HELPER_LOG_CASE_FILE_URI: "file:///C:/Users/file-uri-canary/OneDrive - Company/file.ps1",
        TARKOV_HELPER_LOG_CASE_PATH: "C:/Users/path-canary/OneDrive - Company/file.ps1",
        TARKOV_HELPER_LOG_CASE_APOSTROPHE_PATH: "C:/Users/O'Brien/apostrophe-path-canary/file.ps1",
        TARKOV_HELPER_LOG_CASE_COOKIE: "Cookie: sid=cookie-one; refresh=cookie-two",
        TARKOV_HELPER_LOG_CASE_HEADER: "Authorization: Bearer abc; refreshCredential=LEAKME Proxy-Authorization: Basic xyz, signature=LEAK2 X-Tarkov-Update: tok; extra=LEAK3",
        TARKOV_HELPER_LOG_CASE_JSON_PASSWORD: '{"password":"hunter2"}',
        TARKOV_HELPER_LOG_CASE_JSON_API_KEY: '{"apiKey":"abc123"}',
        TARKOV_HELPER_LOG_CASE_OPAQUE: opaqueCredential,
        TARKOV_HELPER_LOG_CASE_LONG_OPAQUE: longOpaqueCredential,
        TARKOV_HELPER_LOG_CASE_BOUNDARY_OPAQUE: "\u0085".repeat(16_370) + boundaryCredential,
        TARKOV_HELPER_LOG_CASE_UNTERMINATED: 'password="hunter2 secret-suffix',
        TARKOV_HELPER_LOG_CASE_BOUNDARY_QUOTED: boundaryQuotedSecret,
        TARKOV_HELPER_LOG_CASE_CONTROLS: "safe\r\nforged-event\u0085forged-nel-event\u2028forged-line-event\u2029forged-paragraph-event",
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    for (const canary of canaries) assert.doesNotMatch(result.stdout, new RegExp(canary.split("=")[1], "i"));
    assert.doesNotMatch(result.stdout, /canary-user|canary-pass|query-canary|fragment-canary|cookie-one|cookie-two|secret canary|file-uri-canary|path-canary|apostrophe-path-canary|LEAKME|LEAK2|LEAK3|hunter2|secret-suffix|abc123|AAAAAAAA|BBBBBBBB|CCCCCCCC|FIRSTPART|SSSSSSSSSS/i);
    assert.doesNotMatch(result.stdout, /file:\/*/i);
    assert.doesNotMatch(result.stdout, /[\r\n]forged-event/);
    assert.doesNotMatch(result.stdout, /\u0085/);
    assert.doesNotMatch(result.stdout, /[\u2028\u2029]/);
    assert.match(result.stdout, /\[REDACTED\]/);
    assert.match(result.stdout, /\[TRUNCATED\]/);
  }
});

test("worker diagnostics sanitize legacy current and previous logs before appending", { skip: process.platform !== "win32", timeout: 30_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-worker-log-"));
  const stateDirectory = path.join(temporaryRoot, "state");
  const updateDirectory = path.join(stateDirectory, "app-update");
  const opaque = "A".repeat(100);
  const missingPackage = path.join(temporaryRoot, `Authorization=Bearer ${opaque}`);
  await mkdir(updateDirectory, { recursive: true });
  const legacyCanary = `Authorization: Bearer ${opaque}; legacy-current-canary C:/Users/O'Brien/private/file.ps1`;
  const legacyPreviousCanary = `token=${"B".repeat(100)} legacy-previous-canary`;
  await writeFile(path.join(updateDirectory, "worker.log"), Buffer.concat([
    Buffer.alloc(1_100_000, 0x78), Buffer.from(`\n${legacyCanary}`, "utf8"),
  ]));
  await writeFile(path.join(updateDirectory, "worker.previous.log"), legacyPreviousCanary, "utf8");
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const result = runPowerShell(workerPath, [
    "-Action", "Check", "-PackageRoot", missingPackage, "-StateDirectory", stateDirectory, "-Port", "41753",
  ]);
  assert.equal(result.status, 8, `${result.stdout}\n${result.stderr}`);
  const previous = await readFile(path.join(updateDirectory, "worker.previous.log"), "utf8");
  const current = await readFile(path.join(updateDirectory, "worker.log"), "utf8");
  assert.ok(Buffer.byteLength(current, "utf8") <= 1_048_576);
  assert.ok(Buffer.byteLength(previous, "utf8") <= 1_048_576);
  assert.doesNotMatch(`${current}\n${previous}`, /legacy-current-canary|legacy-previous-canary|O'Brien|A{20}|B{20}/i);
  assert.match(current, /\[REDACTED\]/);
});

test("a logging failure does not replace the worker's terminal status or exit code", { skip: process.platform !== "win32", timeout: 30_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-worker-log-failure-"));
  const stateDirectory = path.join(temporaryRoot, "state");
  const updateDirectory = path.join(stateDirectory, "app-update");
  await mkdir(path.join(updateDirectory, "worker.log"), { recursive: true });
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const result = runPowerShell(workerPath, [
    "-Action", "Check", "-PackageRoot", path.join(temporaryRoot, "missing"), "-StateDirectory", stateDirectory, "-Port", "41753",
  ]);
  assert.equal(result.status, 8, `${result.stdout}\n${result.stderr}`);
  const status = JSON.parse(await readFile(path.join(updateDirectory, "status.json"), "utf8"));
  assert.deepEqual({ state: status.state, operation: status.operation, code: status.code }, {
    state: "ERROR", operation: "CHECK", code: "INVALID_RELEASE",
  });
});

test("broker terminal failure sanitizes legacy current and previous logs", { skip: process.platform !== "win32", timeout: 30_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-broker-log-"));
  const stateDirectory = path.join(temporaryRoot, "state");
  const updateDirectory = path.join(stateDirectory, "app-update");
  const planPath = path.join(updateDirectory, "pending.json");
  await mkdir(updateDirectory, { recursive: true });
  await writeFile(planPath, "{}", "utf8");
  await writeFile(path.join(updateDirectory, "broker.log"), `Authorization: Bearer ${"C".repeat(100)} legacy-broker-current`, "utf8");
  await writeFile(path.join(updateDirectory, "broker.previous.log"), "C:/Users/O'Brien/legacy-broker-previous/file.ps1", "utf8");
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const result = runPowerShell(brokerPath, [
    "-PlanPath", planPath, "-ExpectedPackageRoot", path.join(temporaryRoot, "package"),
    "-StateDirectory", stateDirectory, "-Port", "41753", "-SkipRunOnce",
  ]);
  assert.equal(result.status, 20, `${result.stdout}\n${result.stderr}`);
  const previous = await readFile(path.join(updateDirectory, "broker.previous.log"), "utf8");
  const current = await readFile(path.join(updateDirectory, "broker.log"), "utf8");
  assert.ok(Buffer.byteLength(current, "utf8") <= 1_048_576);
  assert.doesNotMatch(`${current}\n${previous}`, /legacy-broker-current|legacy-broker-previous|O'Brien|C{20}/i);
  assert.match(current, /Apply failed/);
});

test("broker Add-Type initialization failure is logged before update state functions load", { skip: process.platform !== "win32", timeout: 30_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-broker-init-log-"));
  const stateDirectory = path.join(temporaryRoot, "state");
  const injectedBroker = path.join(temporaryRoot, "app-update-broker.ps1");
  const source = await readFile(brokerPath, "utf8");
  const injected = source.replace(
    "try { Add-Type -TypeDefinition $treeVerifierSource -Language CSharp }",
    'try { throw [InvalidOperationException]::new("injected Add-Type failure") }',
  );
  assert.notEqual(injected, source, "the broker Add-Type site must remain covered by the injected failure test");
  await writeFile(injectedBroker, injected, "utf8");
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const result = runPowerShell(injectedBroker, [
    "-PlanPath", path.join(stateDirectory, "app-update", "pending.json"),
    "-ExpectedPackageRoot", path.join(temporaryRoot, "package"),
    "-StateDirectory", stateDirectory,
  ]);
  assert.equal(result.status, 20, `${result.stdout}\n${result.stderr}`);
  assert.match(await readFile(path.join(stateDirectory, "app-update", "broker.log"), "utf8"), /Broker initialization failed: InvalidOperationException: injected Add-Type failure/);
});

function digest(contents) {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function readTaggedUpdaterFile(tag, relativePath) {
  const result = spawnSync("git", ["show", `${tag}:${relativePath}`], {
    cwd: projectRoot,
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `Unable to load ${relativePath} from ${tag}. CI must check out tags with fetch-depth: 0.\n${result.stderr?.toString("utf8") ?? ""}`,
  );
  return Buffer.from(result.stdout);
}

async function previousUpdaterTag() {
  const currentVersion = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")).version;
  const current = currentVersion.split(".").map(Number);
  assert.equal(current.length, 3);
  assert.ok(current.every(Number.isSafeInteger), `Invalid package version: ${currentVersion}`);
  const result = spawnSync("git", ["tag", "--list", "v*"], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const candidates = result.stdout.split(/\r?\n/).flatMap((tag) => {
    const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
    if (!match) return [];
    const parts = match.slice(1).map(Number);
    return parts.every(Number.isSafeInteger) ? [{ tag, parts }] : [];
  }).filter(({ parts }) => {
    for (let index = 0; index < 3; index += 1) {
      if (parts[index] !== current[index]) return parts[index] < current[index];
    }
    return false;
  }).sort((left, right) => {
    for (let index = 0; index < 3; index += 1) {
      if (left.parts[index] !== right.parts[index]) return right.parts[index] - left.parts[index];
    }
    return 0;
  });
  return candidates.length > 0 ? candidates[0].tag : null;
}

async function requirePreviousUpdaterTag(t) {
  const previousTag = await previousUpdaterTag();
  if (!previousTag) {
    t.skip(`No previous updater tag exists before v${JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")).version}`);
  }
  return previousTag;
}

async function installTaggedUpdaterCode(packageRoot, tag) {
  const files = {
    launcher: readTaggedUpdaterFile(tag, "portable/launcher.ps1"),
    worker: readTaggedUpdaterFile(tag, "portable/app-update-worker.ps1"),
    broker: readTaggedUpdaterFile(tag, "portable/app-update-broker.ps1"),
  };
  await Promise.all([
    writeFile(path.join(packageRoot, "launcher.ps1"), files.launcher),
    writeFile(path.join(packageRoot, "app-update-worker.ps1"), files.worker),
    writeFile(path.join(packageRoot, "app-update-broker.ps1"), files.broker),
  ]);
  const checksumPath = path.join(packageRoot, "SHA256SUMS.txt");
  await rm(checksumPath);
  await writeFile(checksumPath, checksumText(await collectFiles(packageRoot)), "utf8");
  return files;
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

function readWindowsFileAttributes(filename) {
  const result = spawnSync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "[int][IO.File]::GetAttributes($env:TARKOV_HELPER_UPDATE_TEST_ATTRIBUTE_PATH)",
  ], {
    encoding: "utf8",
    env: { ...process.env, TARKOV_HELPER_UPDATE_TEST_ATTRIBUTE_PATH: filename },
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return Number.parseInt(result.stdout.trim(), 10);
}

function isRecordedProcessRunning(record) {
  const result = spawnSync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    [
      "$process = Get-Process -Id ([int]$env:TARKOV_HELPER_UPDATE_TEST_PID) -ErrorAction SilentlyContinue",
      "if ($null -eq $process) { exit 1 }",
      "$expected = [DateTime]::Parse($env:TARKOV_HELPER_UPDATE_TEST_PROCESS_START, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()",
      "if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $expected).TotalMilliseconds) -lt 1000) { exit 0 }",
      "exit 2",
    ].join("; "),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      TARKOV_HELPER_UPDATE_TEST_PID: String(record.serverPid),
      TARKOV_HELPER_UPDATE_TEST_PROCESS_START: record.serverProcessStartTimeUtc,
    },
    windowsHide: true,
  });
  return result.status === 0;
}

function stopRecordedProcessForTest(record) {
  return spawnSync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    [
      "$process = Get-Process -Id ([int]$env:TARKOV_HELPER_UPDATE_TEST_PID) -ErrorAction SilentlyContinue",
      "if ($null -eq $process) { exit 0 }",
      "$expected = [DateTime]::Parse($env:TARKOV_HELPER_UPDATE_TEST_PROCESS_START, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()",
      "if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $expected).TotalMilliseconds) -ge 1000) { exit 2 }",
      "$process.Kill()",
      "if (-not $process.WaitForExit(5000)) { exit 3 }",
    ].join("; "),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      TARKOV_HELPER_UPDATE_TEST_PID: String(record.serverPid),
      TARKOV_HELPER_UPDATE_TEST_PROCESS_START: record.serverProcessStartTimeUtc,
    },
    windowsHide: true,
  });
}

async function startRecordedSleeperForTest() {
  const child = spawn(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 120",
  ], { stdio: "ignore", windowsHide: true });
  const record = await waitFor(async () => {
    const result = spawnSync(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$process = Get-Process -Id ([int]$env:TARKOV_HELPER_UPDATE_TEST_PID) -ErrorAction Stop; $process.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)",
    ], {
      encoding: "utf8",
      env: { ...process.env, TARKOV_HELPER_UPDATE_TEST_PID: String(child.pid) },
      windowsHide: true,
    });
    return result.status === 0 ? {
      serverPid: child.pid,
      serverProcessStartTimeUtc: result.stdout.trim(),
    } : null;
  }, (value) => value?.serverProcessStartTimeUtc, 5_000);
  return { child, record };
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

async function pathExists(filename) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
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
  const state = {
    assets: new Map(),
    delayedAssetIds: new Map(),
    release: null,
    releaseBody: null,
    releaseHeaders: {},
    releaseStatus: 200,
    releaseStatusSequence: null,
    requests: [],
  };
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
      const body = state.releaseBody ?? `${JSON.stringify(state.release)}\n`;
      const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const releaseStatus = Array.isArray(state.releaseStatusSequence) && state.releaseStatusSequence.length > 0
        ? state.releaseStatusSequence.shift()
        : state.releaseStatus;
      response.writeHead(releaseStatus, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": payload.length,
        Connection: "close",
        ...state.releaseHeaders,
      });
      response.end(payload);
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

async function writeDirectPackage(root, {
  version,
  commit,
  updateConfig,
  appSource,
  extraFiles = [],
  omitLauncherExecutable = false,
}) {
  await mkdir(path.join(root, "app"), { recursive: true });
  if (appSource) await cp(appSource, path.join(root, "app"), { recursive: true });
  await Promise.all([
    copyFile(launcherPath, path.join(root, "launcher.ps1")),
    copyFile(workerPath, path.join(root, "app-update-worker.ps1")),
    copyFile(brokerPath, path.join(root, "app-update-broker.ps1")),
    ...requiredPortableFiles.map((filename) => copyFile(path.join(projectRoot, "portable", filename), path.join(root, filename))),
  ]);
  await writeFile(path.join(root, "UPDATE_CONFIG.json"), `${JSON.stringify(updateConfig, null, 2)}\n`, "utf8");
  if (!omitLauncherExecutable) {
    await writeFile(path.join(root, "Tarkov Helper.exe"), Buffer.from("MZ\0Tarkov Helper test launcher\0", "binary"));
  }
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
  candidateAppSource,
  currentVersion = "1.0.0",
  candidateVersion = "1.1.0",
  tamperSignature = false,
  extraFiles = [],
  mutateArchive,
  mutateManifest,
  mutateRelease,
  omitLauncherExecutable = false,
  releaseBody = null,
  releaseHeaders = {},
  releaseStatus = 200,
} = {}) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tarkov-public-update-"));
  const packageRoot = path.join(temporaryRoot, "Tarkov Helper Direct");
  const newPackageRoot = path.join(temporaryRoot, "new-package");
  const stateDirectory = path.join(temporaryRoot, "state");
  const archivePath = path.join(temporaryRoot, `tarkov-helper-web-direct-v${candidateVersion}.zip`);
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

  await writeDirectPackage(packageRoot, { version: currentVersion, commit: oldCommit, updateConfig });
  const packageRecord = await writeDirectPackage(newPackageRoot, {
    version: candidateVersion,
    commit: newCommit,
    updateConfig,
    appSource: candidateAppSource,
    extraFiles,
    omitLauncherExecutable,
  });
  const archiveRoot = `Tarkov Helper Direct v${candidateVersion}`;
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
    version: candidateVersion,
    tag: `v${candidateVersion}`,
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
          version: candidateVersion,
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
    tag_name: `v${candidateVersion}`,
    html_url: `https://github.com/${repository}/releases/tag/v${candidateVersion}`,
    published_at: "2026-08-09T00:00:00Z",
    assets: [
      asset(201, "update-manifest-v1.json", manifestBytes),
      asset(202, "update-manifest-v1.sig", signature),
      asset(203, path.basename(archivePath), archive),
    ],
  };
  state.releaseBody = releaseBody;
  state.releaseHeaders = releaseHeaders;
  state.releaseStatus = releaseStatus;
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

async function prepareStagedFixture(fixture, port = 41753, options = {}) {
  const checkTimeout = options.checkTimeout ?? 90_000;
  const stageTimeout = options.stageTimeout ?? 60_000;
  const common = [
    "-PackageRoot", fixture.packageRoot,
    "-StateDirectory", fixture.stateDirectory,
    "-Port", String(port),
    "-AllowTestHttpLoopback",
  ];
  const checked = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), ["-Action", "Check", ...common], {
    timeout: checkTimeout,
  });
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const available = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8"));
  assert.equal(available.state, "AVAILABLE", JSON.stringify(available));
  const staged = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), [
    "-Action", "Stage", ...common, "-CandidateId", available.candidateId,
  ], { timeout: stageTimeout });
  assert.equal(staged.status, 0, `${staged.stdout}\n${staged.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const ready = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8"));
  assert.equal(ready.state, "READY_TO_RESTART", JSON.stringify(ready));
  return { available, ready };
}

async function runExternalBroker(fixture, port, options = {}) {
  const { brokerArguments = [], ...processOptions } = options;
  const pendingPath = path.join(fixture.stateDirectory, "app-update", "pending.json");
  const pending = JSON.parse(await readFile(pendingPath, "utf8"));
  const trustedBroker = path.join(fixture.stateDirectory, "app-update", `broker-${pending.brokerSha256}.ps1`);
  return runPowerShellAsync(trustedBroker, [
    "-PlanPath", pendingPath,
    "-ExpectedPackageRoot", fixture.packageRoot,
    "-StateDirectory", fixture.stateDirectory,
    "-Port", String(port),
    "-SkipRunOnce",
    ...brokerArguments,
  ], processOptions);
}

test("Repair quarantines only a corrupt journal for a strict staged update and preserves pending recovery", { skip: process.platform !== "win32", timeout: 120_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = 42371;
  const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const { ready } = await prepareStagedFixture(fixture, port);
  const updateDirectory = path.join(fixture.stateDirectory, "app-update");
  const pendingPath = path.join(updateDirectory, "pending.json");
  const journalPath = path.join(updateDirectory, "apply-journal.json");
  const pendingBefore = await readFile(pendingPath, "utf8");
  const corruptJournal = "{not a valid apply journal";
  await writeFile(journalPath, corruptJournal, "utf8");

  const repaired = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Repair", "-Port", String(port), "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 15_000 });
  assert.equal(repaired.status, 0, `${repaired.stdout}\n${repaired.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.match(`${repaired.stdout}\n${repaired.stderr}`, /journal|staged update|recovery|quarantined/i);
  assert.equal(await readFile(pendingPath, "utf8"), pendingBefore);
  await assert.rejects(readFile(journalPath, "utf8"), { code: "ENOENT" });
  const quarantined = (await readdir(fixture.stateDirectory)).filter((name) => /^app-update\.apply-journal-corrupt-[0-9]{8}T[0-9]{6}-[0-9a-f]{32}\.json$/.test(name));
  assert.equal(quarantined.length, 1);
  assert.equal(await readFile(path.join(fixture.stateDirectory, quarantined[0]), "utf8"), corruptJournal);
  assert.equal(JSON.parse(pendingBefore).candidateId, ready.candidateId);

  const restarted = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port),
    "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { cwd: fixture.stateDirectory, env, timeout: 60_000 });
  assert.equal(restarted.status, 0, `${restarted.stdout}\n${restarted.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
  await assert.rejects(readFile(pendingPath, "utf8"), { code: "ENOENT" });
});

test("Repair abandons an authenticated PREPARED transaction when its installed broker becomes untrusted", { skip: process.platform !== "win32", timeout: 120_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
  const updateDirectory = path.join(fixture.stateDirectory, "app-update");
  const pendingPath = path.join(updateDirectory, "pending.json");
  const journalPath = path.join(updateDirectory, "apply-journal.json");
  const backupRoot = path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-backup`);
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  await prepareStagedFixture(fixture, port);
  const stagedPending = JSON.parse(await readFile(pendingPath, "utf8"));
  await copyFile(
    path.join(fixture.packageRoot, "app-update-broker.ps1"),
    path.join(updateDirectory, `broker-${stagedPending.brokerSha256}.ps1`),
  );
  const crashed = await runExternalBroker(fixture, port, {
    brokerArguments: ["-TestCrashAfterPhase", "PREPARED"],
    env,
    timeout: 40_000,
  });
  assert.equal(crashed.status, 97, `${crashed.stdout}\n${crashed.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const pendingBefore = await readFile(pendingPath, "utf8");
  const pending = JSON.parse(pendingBefore);
  const journalBefore = await readFile(journalPath, "utf8");
  assert.equal(JSON.parse(journalBefore).phase, "PREPARED");
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.0.0");
  assert.equal((await stat(pending.stageRoot)).isDirectory(), true);
  await assert.rejects(stat(backupRoot), { code: "ENOENT" });
  await assert.rejects(stat(path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-failed-${pending.candidateId}`)), { code: "ENOENT" });

  await appendFile(path.join(fixture.packageRoot, "app-update-broker.ps1"), "\n# damaged after durable PREPARED\n", "utf8");
  const interruptedRepair = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Repair", "-Port", String(port), "-StateDirectory", fixture.stateDirectory,
  ], { env: { ...env, TARKOV_HELPER_UPDATE_TEST_FAIL_REPAIR_PENDING_MOVE: "1" }, timeout: 15_000 });
  assert.equal(interruptedRepair.status, 2, `${interruptedRepair.stdout}\n${interruptedRepair.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(await readFile(pendingPath, "utf8"), pendingBefore, "a failed pending move must preserve the update trigger");
  assert.equal(await readFile(journalPath, "utf8"), journalBefore, "a failed pending move must restore the paired journal");
  assert.deepEqual((await readdir(fixture.stateDirectory)).filter((name) => name.includes("abandoned-prepared")), []);

  const repaired = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Repair", "-Port", String(port), "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 15_000 });
  assert.equal(repaired.status, 0, `${repaired.stdout}\n${repaired.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.match(`${repaired.stdout}\n${repaired.stderr}`, /PREPARED|pre-swap|unrecoverable|quarantined/i);
  await assert.rejects(readFile(pendingPath, "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(journalPath, "utf8"), { code: "ENOENT" });
  assert.equal((await stat(pending.stageRoot)).isDirectory(), true, "the verified stage remains as recovery evidence");
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.0.0");
  const quarantined = await readdir(fixture.stateDirectory);
  const pendingQuarantine = quarantined.filter((name) => /^app-update\.pending-abandoned-prepared-[0-9]{8}T[0-9]{6}-[0-9a-f]{32}\.json$/.test(name));
  const journalQuarantine = quarantined.filter((name) => /^app-update\.apply-journal-abandoned-prepared-[0-9]{8}T[0-9]{6}-[0-9a-f]{32}\.json$/.test(name));
  assert.equal(pendingQuarantine.length, 1);
  assert.equal(journalQuarantine.length, 1);
  assert.equal(await readFile(path.join(fixture.stateDirectory, pendingQuarantine[0]), "utf8"), pendingBefore);
  assert.equal(await readFile(path.join(fixture.stateDirectory, journalQuarantine[0]), "utf8"), journalBefore);

  const restarted = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port),
    "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { cwd: fixture.stateDirectory, env, timeout: 40_000 });
  assert.equal(restarted.status, 0, `${restarted.stdout}\n${restarted.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.0.0");
  assert.equal((await stat(path.join(fixture.stateDirectory, "instance.json"))).isFile(), true);
});

test("Repair preserves a strict post-PREPARED journal even when pre-swap topology appears safe", { skip: process.platform !== "win32", timeout: 120_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
  const updateDirectory = path.join(fixture.stateDirectory, "app-update");
  const pendingPath = path.join(updateDirectory, "pending.json");
  const journalPath = path.join(updateDirectory, "apply-journal.json");
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  await prepareStagedFixture(fixture, port);
  const stagedPending = JSON.parse(await readFile(pendingPath, "utf8"));
  await copyFile(
    path.join(fixture.packageRoot, "app-update-broker.ps1"),
    path.join(updateDirectory, `broker-${stagedPending.brokerSha256}.ps1`),
  );
  const crashed = await runExternalBroker(fixture, port, {
    brokerArguments: ["-TestCrashAfterPhase", "PREPARED"],
    env,
    timeout: 40_000,
  });
  assert.equal(crashed.status, 97, `${crashed.stdout}\n${crashed.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const pendingBefore = await readFile(pendingPath, "utf8");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.phase = "OLD_MOVED";
  await writeFile(journalPath, `${JSON.stringify(journal)}\n`, "utf8");
  const journalBefore = await readFile(journalPath, "utf8");
  await appendFile(path.join(fixture.packageRoot, "app-update-broker.ps1"), "\n# damaged after durable phase\n", "utf8");

  const refused = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Repair", "-Port", String(port), "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 15_000 });
  assert.equal(refused.status, 2, `${refused.stdout}\n${refused.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /journal|mid-swap|preserved|recoverable/i);
  assert.equal(await readFile(pendingPath, "utf8"), pendingBefore);
  assert.equal(await readFile(journalPath, "utf8"), journalBefore);
  assert.deepEqual((await readdir(fixture.stateDirectory)).filter((name) => name.includes("abandoned-prepared")), []);
});

test("Repair abandons strict pending state only when its stage or installed trusted broker is unrecoverable", { skip: process.platform !== "win32", timeout: 120_000 }, async (t) => {
  const fixtures = [];
  t.after(async () => {
    for (const { fixture, env } of fixtures) {
      runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
      await closeServer(fixture.releaseServer);
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  for (const [index, damage] of ["missing-stage", "broker-hash-mismatch"].entries()) {
    const fixture = await createUpdateFixture();
    const port = 42381 + index;
    const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
    fixtures.push({ fixture, env });
    await prepareStagedFixture(fixture, port);
    const updateDirectory = path.join(fixture.stateDirectory, "app-update");
    const pendingPath = path.join(updateDirectory, "pending.json");
    const pending = JSON.parse(await readFile(pendingPath, "utf8"));
    if (damage === "missing-stage") {
      await rm(pending.stageRoot, { recursive: true });
    } else {
      await appendFile(path.join(fixture.packageRoot, "app-update-broker.ps1"), "\n# damaged after staging\n", "utf8");
    }

    const repaired = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), [
      "-Action", "Repair", "-Port", String(port), "-StateDirectory", fixture.stateDirectory,
    ], { env, timeout: 15_000 });
    assert.equal(repaired.status, 0, `${damage}\n${repaired.stdout}\n${repaired.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
    await assert.rejects(readFile(pendingPath, "utf8"), { code: "ENOENT" });
    const quarantined = (await readdir(fixture.stateDirectory)).filter((name) => name.startsWith("app-update.pending-corrupt-"));
    assert.equal(quarantined.length, 1, damage);
    assert.equal(JSON.parse(await readFile(path.join(fixture.stateDirectory, quarantined[0]), "utf8")).candidateId, pending.candidateId);
  }
});

test("Repair treats decimal pending counts as strict-invalid like the pinned broker", { skip: process.platform !== "win32", timeout: 120_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = 42391;
  const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  await prepareStagedFixture(fixture, port);
  const updateDirectory = path.join(fixture.stateDirectory, "app-update");
  const pendingPath = path.join(updateDirectory, "pending.json");
  const source = await readFile(pendingPath, "utf8");
  const decimal = source.replace(/"fileCount":(?<count>\d+)/, '"fileCount":$<count>.0');
  assert.notEqual(decimal, source);
  await writeFile(pendingPath, decimal, "utf8");

  const repaired = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Repair", "-Port", String(port), "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 15_000 });
  assert.equal(repaired.status, 0, `${repaired.stdout}\n${repaired.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  await assert.rejects(readFile(pendingPath, "utf8"), { code: "ENOENT" });
  const quarantined = (await readdir(fixture.stateDirectory)).filter((name) => name.startsWith("app-update.pending-corrupt-"));
  assert.equal(quarantined.length, 1);
  assert.match(await readFile(path.join(fixture.stateDirectory, quarantined[0]), "utf8"), /"fileCount":\d+\.0/);
});

async function prepareJournalFreeCommittedGap(fixture, port, env) {
  await prepareStagedFixture(fixture, port);
  const interrupted = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env: { ...env, TARKOV_HELPER_UPDATE_TEST_CRASH_PHASE: "COMMITTED" }, timeout: 40_000 });
  assert.equal(interrupted.status, 2, `${interrupted.stdout}\n${interrupted.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const stopped = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Stop", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 10_000 });
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
  const updateDirectory = path.join(fixture.stateDirectory, "app-update");
  const pending = JSON.parse(await readFile(path.join(updateDirectory, "pending.json"), "utf8"));
  const packageParent = path.dirname(fixture.packageRoot);
  const packageLeaf = path.basename(fixture.packageRoot);
  const backupRoot = path.join(packageParent, `.${packageLeaf}.update-backup`);
  const failedRoot = path.join(packageParent, `.${packageLeaf}.update-failed-${pending.candidateId}`);
  await rm(backupRoot, { recursive: true });
  await rm(path.join(updateDirectory, "apply-journal.json"));
  assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "status.json"), "utf8")).state, "UPDATED");
  return { backupRoot, failedRoot, pending, updateDirectory };
}

async function prepareOfflineCommittedProof(fixture, port, env) {
  await prepareStagedFixture(fixture, port);
  const interrupted = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env: { ...env, TARKOV_HELPER_UPDATE_TEST_CRASH_PHASE: "COMMITTED" }, timeout: 40_000 });
  assert.equal(interrupted.status, 2, `${interrupted.stdout}\n${interrupted.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const stopped = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Stop", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 10_000 });
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
  const updateDirectory = path.join(fixture.stateDirectory, "app-update");
  const pending = JSON.parse(await readFile(path.join(updateDirectory, "pending.json"), "utf8"));
  const backupRoot = path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-backup`);
  await rm(backupRoot, { recursive: true });
  assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "apply-journal.json"), "utf8")).phase, "COMMITTED");
  return { pending, updateDirectory };
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
  assert.match(worker, /DefaultWebProxy/);
  assert.match(launcher, /"-StartedAt", \$now/);
  assert.match(worker, /\[string\]\$StartedAt/);
  assert.match(worker, /\$startedAt = \$StartedAt/);
  assert.match(launcher, /\$brokerTimeoutSeconds\s*=\s*Get-AppUpdateApplyTimeoutSeconds -Pending \$pending/);
  assert.match(launcher, /AddSeconds\(\$brokerTimeoutSeconds\)/);
  assert.doesNotMatch(launcher, /broker exceeded its 60 second safety timeout/i);
  assert.match(broker, /\[int\]\$Seconds = 30/);
  assert.match(broker, /ROLLING_BACK/);
  assert.match(broker, /READY_TO_RESTART/);
  assert.match(broker, /Move-UpdateDirectory/);
});

test("authenticated API verifies, stages, and applies an immutable signed public release", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const env = {
    TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
    TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
    TARKOV_HELPER_UPDATE_TEST_MOVE_FAILURES: "2",
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
  const cleanupRoot = path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-cleanup-${available.candidateId}`);
  await waitFor(async () => ({
    backup: await pathExists(backupRoot),
    cleanup: await pathExists(cleanupRoot),
  }), (value) => !value.backup && !value.cleanup, 10_000);
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

test("relaunching an old running server preserves a staged update that has not been applied", { skip: process.platform !== "win32", timeout: 60_000 }, async (t) => {
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
  const updateDirectory = path.join(fixture.stateDirectory, "app-update");
  const originalInstance = JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8"));
  await assert.rejects(stat(path.join(updateDirectory, "apply-journal.json")), { code: "ENOENT" });

  const relaunched = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 15_000 });
  assert.equal(relaunched.status, 0, `${relaunched.stdout}\n${relaunched.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const currentInstance = JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8"));
  assert.equal(currentInstance.pid, originalInstance.pid);
  assert.equal(currentInstance.processStartTimeUtc, originalInstance.processStartTimeUtc);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.0.0");
  assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "status.json"), "utf8")).state, "READY_TO_RESTART");
  assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "pending.json"), "utf8")).candidateId, ready.candidateId);
  await assert.rejects(stat(path.join(updateDirectory, "apply-journal.json")), { code: "ENOENT" });
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

test("stage rejects a signed direct package missing the branded launcher executable", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const fixture = await createUpdateFixture({ omitLauncherExecutable: true });
  try {
    const checked = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), [
      "-Action", "Check", "-PackageRoot", fixture.packageRoot, "-StateDirectory", fixture.stateDirectory,
      "-Port", "41753", "-AllowTestHttpLoopback",
    ]);
    assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
    const available = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8"));
    const staged = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), [
      "-Action", "Stage", "-PackageRoot", fixture.packageRoot, "-StateDirectory", fixture.stateDirectory,
      "-Port", "41753", "-CandidateId", available.candidateId, "-AllowTestHttpLoopback",
    ], { timeout: 30_000 });
    assert.equal(staged.status, 8, `${staged.stdout}\n${staged.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
    const status = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8"));
    assert.equal(status.code, "INVALID_PACKAGE", JSON.stringify(status));
    await assert.rejects(stat(path.join(fixture.stateDirectory, "app-update", "pending.json")), { code: "ENOENT" });
    assert.deepEqual((await readdir(fixture.temporaryRoot)).filter((name) => name.includes(".update-stage-")), []);
  } finally {
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
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

test("a pre-swap directory lock preserves the verified staged update for a later retry", { skip: process.platform !== "win32", timeout: 120_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const baseEnv = {
    TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
    TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
  };
  const updateDirectory = path.join(fixture.stateDirectory, "app-update");
  const backupRoot = path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-backup`);
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env: baseEnv, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const { ready } = await prepareStagedFixture(fixture, port);
  const pendingPath = path.join(updateDirectory, "pending.json");
  const pending = JSON.parse(await readFile(pendingPath, "utf8"));
  const stagedRoot = pending.stageRoot;
  const deferred = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env: { ...baseEnv, TARKOV_HELPER_UPDATE_TEST_MOVE_FAILURES: "8" }, timeout: 40_000 });
  assert.equal(deferred.status, 2, `${deferred.stdout}\n${deferred.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.0.0");
  assert.deepEqual(JSON.parse(await readFile(path.join(updateDirectory, "status.json"), "utf8")), {
    state: "READY_TO_RESTART",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    candidateId: ready.candidateId,
    stagedAt: pending.stagedAt,
  });
  assert.equal(JSON.parse(await readFile(pendingPath, "utf8")).candidateId, ready.candidateId);
  assert.equal((await stat(stagedRoot)).isDirectory(), true);
  assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "apply-journal.json"), "utf8")).phase, "PREPARED");
  await assert.rejects(stat(backupRoot), { code: "ENOENT" });

  const stopped = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env: baseEnv, timeout: 10_000 });
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
  const retried = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env: baseEnv, timeout: 40_000 });
  assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
});

test("a slow pre-swap verification is not killed by the former fixed one-minute launcher timeout", { skip: process.platform !== "win32", timeout: 150_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = {
    TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
    TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
    TARKOV_HELPER_UPDATE_TEST_APPLY_VERIFY_DELAY_MS: "61000",
  };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  await prepareStagedFixture(fixture, port);
  const applied = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 120_000 });

  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
});

test("the previous stable updater code performs the first hop with its own pinned broker", { skip: process.platform !== "win32", timeout: 120_000 }, async (t) => {
  const previousTag = await requirePreviousUpdaterTag(t);
  if (!previousTag) return;
  const currentReleaseVersion = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")).version;
  const fixture = await createUpdateFixture({
    candidateAppSource: path.join(projectRoot, "public"),
    currentVersion: previousTag.slice(1),
    candidateVersion: currentReleaseVersion,
  });
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

  const candidateManifest = JSON.parse(fixture.state.assets.get(201).toString("utf8"));
  assert.ok(candidateManifest.artifacts.direct.package.appFiles >= 500, "the first-hop gate must use a release-sized app tree");
  assert.ok(candidateManifest.artifacts.direct.package.appBytes >= 10 * 1024 * 1024, "the first-hop gate must not use a tiny app fixture");

  const previous = await installTaggedUpdaterCode(fixture.packageRoot, previousTag);
  if (previousTag === "v1.0.31") {
    assert.match(previous.launcher.toString("utf8"), /AddSeconds\(60\)/, "the v1.0.31 first hop must retain its published fixed timeout");
  }

  await prepareStagedFixture(fixture, port, { checkTimeout: 120_000, stageTimeout: 90_000 });
  const updateDirectory = path.join(fixture.stateDirectory, "app-update");
  const pending = JSON.parse(await readFile(path.join(updateDirectory, "pending.json"), "utf8"));
  const previousBrokerSha256 = sha256(previous.broker);
  assert.equal(pending.brokerSha256, previousBrokerSha256, `${previousTag}'s broker, not current source, must own the first swap`);
  assert.equal(
    sha256(await readFile(path.join(fixture.packageRoot, "app-update-broker.ps1"))),
    previousBrokerSha256,
  );

  const applied = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { cwd: fixture.packageRoot, env, timeout: 75_000 });
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, currentReleaseVersion);
  const session = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/app-update/session`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
    }).catch(() => null);
    return response?.ok ? response.json() : null;
  }, (value) => value?.status?.state === "UPDATED" && value?.status?.currentVersion === currentReleaseVersion, 30_000);
  assert.equal(session.status.state, "UPDATED");
});

test("the current launcher resumes a previous stable broker after a first-hop NEW_MOVED crash", { skip: process.platform !== "win32", timeout: 120_000 }, async (t) => {
  const previousTag = await requirePreviousUpdaterTag(t);
  if (!previousTag) return;
  const currentReleaseVersion = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")).version;
  const fixture = await createUpdateFixture({ currentVersion: previousTag.slice(1), candidateVersion: currentReleaseVersion });
  const port = await getFreePort();
  const env = {
    TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
    TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
  };
  const backupRoot = path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-backup`);
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const previous = await installTaggedUpdaterCode(fixture.packageRoot, previousTag);
  await prepareStagedFixture(fixture, port);
  const interrupted = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { cwd: fixture.packageRoot, env: { ...env, TARKOV_HELPER_UPDATE_TEST_CRASH_PHASE: "NEW_MOVED" }, timeout: 30_000 });
  assert.equal(interrupted.status, 2, `${interrupted.stdout}\n${interrupted.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, currentReleaseVersion);
  const backupBrokerPath = path.join(backupRoot, "app-update-broker.ps1");
  assert.equal(sha256(await readFile(backupBrokerPath)), sha256(previous.broker));
  assert.equal(JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "apply-journal.json"), "utf8")).phase, "NEW_MOVED");

  await appendFile(backupBrokerPath, "\n# tampered recovery source\n", "utf8");
  const refused = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { cwd: fixture.packageRoot, env, timeout: 20_000 });
  assert.equal(refused.status, 2, `${refused.stdout}\n${refused.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "apply-journal.json"), "utf8")).phase, "NEW_MOVED");
  await writeFile(backupBrokerPath, previous.broker);

  const recovered = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { cwd: fixture.packageRoot, env, timeout: 60_000 });
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, currentReleaseVersion);
  assert.equal(JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8")).state, "UPDATED");
  await assert.rejects(stat(backupRoot), { code: "ENOENT" });
});

test("isolated read-only recovery preserves a normal first-hop NEW_MOVED transaction", { skip: process.platform !== "win32", timeout: 150_000 }, async (t) => {
  const previousTag = await requirePreviousUpdaterTag(t);
  if (!previousTag) return;
  const currentReleaseVersion = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")).version;
  const fixture = await createUpdateFixture({ currentVersion: previousTag.slice(1), candidateVersion: currentReleaseVersion });
  const port = await getFreePort();
  const isolatedStateDirectory = path.join(fixture.temporaryRoot, "isolated-recovery-state");
  const env = {
    TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
    TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
  };
  const updateDirectory = path.join(fixture.stateDirectory, "app-update");
  const backupRoot = path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-backup`);
  t.after(async () => {
    for (const stateDirectory of [isolatedStateDirectory, fixture.stateDirectory]) {
      runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), [
        "-Action", "Stop", "-StateDirectory", stateDirectory, "-DisablePackageUpdates",
      ], { env, timeout: 10_000 });
    }
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const previous = await installTaggedUpdaterCode(fixture.packageRoot, previousTag);
  await prepareStagedFixture(fixture, port);
  const interrupted = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { cwd: fixture.packageRoot, env: { ...env, TARKOV_HELPER_UPDATE_TEST_CRASH_PHASE: "NEW_MOVED" }, timeout: 30_000 });
  assert.equal(interrupted.status, 2, `${interrupted.stdout}\n${interrupted.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "apply-journal.json"), "utf8")).phase, "NEW_MOVED");
  assert.equal(sha256(await readFile(path.join(backupRoot, "app-update-broker.ps1"))), sha256(previous.broker));

  const normalUpdateSnapshot = checksumText(await collectFiles(updateDirectory));
  const installedTreeSnapshot = checksumText(await collectFiles(fixture.packageRoot));
  const rollbackTreeSnapshot = checksumText(await collectFiles(backupRoot));
  const packageParentEvidence = (await readdir(path.dirname(fixture.packageRoot)))
    .filter((name) => name.startsWith(`.${path.basename(fixture.packageRoot)}.update-`))
    .sort();
  const releaseRequestCount = fixture.state.requests.length;

  const isolated = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser",
    "-StateDirectory", isolatedStateDirectory, "-DisablePackageUpdates",
  ], { cwd: fixture.packageRoot, env, timeout: 30_000 });
  assert.equal(isolated.status, 0, `${isolated.stdout}\n${isolated.stderr}`);

  const base = `http://127.0.0.1:${port}`;
  const sessionResponse = await fetch(`${base}/api/v1/app-update/session`, {
    headers: { "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.repository, null);
  assert.deepEqual(session.status, {
    state: "DISABLED",
    currentVersion: currentReleaseVersion,
    reason: "NOT_CONFIGURED",
  });
  for (const [endpoint, body] of [
    ["check", {}],
    ["stage", { candidateId: "A".repeat(40) }],
    ["apply", { candidateId: "A".repeat(40) }],
  ]) {
    const mutation = await fetch(`${base}/api/v1/app-update/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: base,
        "Sec-Fetch-Site": "same-origin",
        "X-Tarkov-Update": session.token,
      },
      body: JSON.stringify(body),
    });
    assert.equal(mutation.status, 409, endpoint);
    assert.equal((await mutation.json()).error.code, "NOT_CONFIGURED", endpoint);
  }
  assert.equal(fixture.state.requests.length, releaseRequestCount, "read-only recovery must not contact the release API");
  await assert.rejects(stat(path.join(isolatedStateDirectory, "app-update")), { code: "ENOENT" });
  assert.equal(checksumText(await collectFiles(updateDirectory)), normalUpdateSnapshot);
  assert.equal(checksumText(await collectFiles(fixture.packageRoot)), installedTreeSnapshot);
  assert.equal(checksumText(await collectFiles(backupRoot)), rollbackTreeSnapshot);
  assert.deepEqual(
    (await readdir(path.dirname(fixture.packageRoot)))
      .filter((name) => name.startsWith(`.${path.basename(fixture.packageRoot)}.update-`))
      .sort(),
    packageParentEvidence,
  );

  const stopped = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Stop", "-StateDirectory", isolatedStateDirectory, "-DisablePackageUpdates",
  ], { env, timeout: 10_000 });
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
  const recovered = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { cwd: fixture.packageRoot, env, timeout: 60_000 });
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "status.json"), "utf8")).state, "UPDATED");
  await assert.rejects(stat(path.join(updateDirectory, "pending.json")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(updateDirectory, "apply-journal.json")), { code: "ENOENT" });
  await assert.rejects(stat(backupRoot), { code: "ENOENT" });
});

test("the current launcher retires previous-version terminal state after post-COMMITTED cleanup crashes", { skip: process.platform !== "win32", timeout: 360_000 }, async (t) => {
  const previousTag = await requirePreviousUpdaterTag(t);
  if (!previousTag) return;
  const currentReleaseVersion = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")).version;

  for (const boundary of ["BACKUP", "JOURNAL", "RUNONCE"]) {
    await t.test(boundary, async () => {
      const fixture = await createUpdateFixture({
        candidateAppSource: path.join(projectRoot, "public"),
        currentVersion: previousTag.slice(1),
        candidateVersion: currentReleaseVersion,
        extraFiles: [
          ["a0.txt", "root sibling sorts after slash-normalized nested path\n"],
          ["a/file.txt", "nested sibling sorts before a0.txt in the signed tree\n"],
        ],
      });
      const port = await getFreePort();
      const env = {
        TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
        TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
      };
      const updateDirectory = path.join(fixture.stateDirectory, "app-update");
      const pendingPath = path.join(updateDirectory, "pending.json");
      const journalPath = path.join(updateDirectory, "apply-journal.json");
      const candidatePath = path.join(updateDirectory, "candidate.json");
      const backupRoot = path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-backup`);
      let interruptedInstance;
      t.after(async () => {
        if (interruptedInstance) {
          const interruptedProcess = {
            serverPid: interruptedInstance.pid,
            serverProcessStartTimeUtc: interruptedInstance.processStartTimeUtc,
          };
          if (isRecordedProcessRunning(interruptedProcess)) stopRecordedProcessForTest(interruptedProcess);
        }
        runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
        await closeServer(fixture.releaseServer);
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      });

      const previous = await installTaggedUpdaterCode(fixture.packageRoot, previousTag);
      await prepareStagedFixture(fixture, port, { stageTimeout: 120_000 });
      const pending = JSON.parse(await readFile(pendingPath, "utf8"));
      assert.equal(pending.brokerSha256, sha256(previous.broker));
      const failedRoot = path.join(
        path.dirname(fixture.packageRoot),
        `.${path.basename(fixture.packageRoot)}.update-failed-${pending.candidateId}`,
      );
      const cleanupRoot = path.join(
        path.dirname(fixture.packageRoot),
        `.${path.basename(fixture.packageRoot)}.update-cleanup-${pending.candidateId}`,
      );

      const interrupted = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
        "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port),
        "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
      ], {
        cwd: fixture.packageRoot,
        env: { ...env, TARKOV_HELPER_UPDATE_TEST_COMMIT_CLEANUP_CRASH: boundary },
        timeout: 75_000,
      });
      assert.equal(interrupted.status, 2, `${boundary}\n${interrupted.stdout}\n${interrupted.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
      assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, currentReleaseVersion);
      await assert.rejects(stat(pending.stageRoot), { code: "ENOENT" });
      await assert.rejects(stat(backupRoot), { code: "ENOENT" });
      await assert.rejects(stat(failedRoot), { code: "ENOENT" });
      interruptedInstance = JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8"));
      const interruptedProcess = {
        serverPid: interruptedInstance.pid,
        serverProcessStartTimeUtc: interruptedInstance.processStartTimeUtc,
      };
      assert.equal(isRecordedProcessRunning(interruptedProcess), true, "the exact authenticated replacement server must remain alive");
      if (boundary === "BACKUP") {
        assert.equal(JSON.parse(await readFile(journalPath, "utf8")).phase, "COMMITTED");
        await mkdir(path.join(cleanupRoot, "nested"), { recursive: true });
        await writeFile(path.join(cleanupRoot, "nested", "old-package-residue.txt"), "bounded historical cleanup residue\n", "utf8");
        await appendFile(
          path.join(updateDirectory, `broker-${pending.brokerSha256}.ps1`),
          "\n# state-only historical broker must never execute during terminal cleanup\n",
          "utf8",
        );
      } else {
        await assert.rejects(stat(journalPath), { code: "ENOENT" });
      }
      if (boundary === "JOURNAL") {
        const stopped = stopRecordedProcessForTest(interruptedProcess);
        assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
        assert.equal(isRecordedProcessRunning(interruptedProcess), false);
        assert.equal((await stat(path.join(fixture.stateDirectory, "instance.json"))).isFile(), true, "Start must clean the stale instance before reserving the port");
      }

      const recovered = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
        "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port),
        "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
      ], { cwd: fixture.packageRoot, env, timeout: 75_000 });
      assert.equal(recovered.status, 0, `${boundary}\n${recovered.stdout}\n${recovered.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
      const recoveredInstance = JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8"));
      if (boundary === "JOURNAL") {
        assert.notEqual(recoveredInstance.pid, interruptedInstance.pid, "offline terminal recovery must start a fresh current server");
      } else {
        assert.equal(recoveredInstance.pid, interruptedInstance.pid, "live terminal recovery must retain the authenticated replacement server");
        assert.equal(recoveredInstance.processStartTimeUtc, interruptedInstance.processStartTimeUtc);
      }
      await assert.rejects(stat(candidatePath), { code: "ENOENT" });
      await assert.rejects(stat(journalPath), { code: "ENOENT" });
      await assert.rejects(stat(pendingPath), { code: "ENOENT" });
      await assert.rejects(stat(backupRoot), { code: "ENOENT" });
      await assert.rejects(stat(failedRoot), { code: "ENOENT" });
      await assert.rejects(stat(cleanupRoot), { code: "ENOENT" });
    });
  }
});

test("historical terminal cleanup recovery preserves state unless the installed tree and COMMITTED proof are exact", { skip: process.platform !== "win32", timeout: 180_000 }, async (t) => {
  const previousTag = await requirePreviousUpdaterTag(t);
  if (!previousTag) return;
  const currentReleaseVersion = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")).version;

  for (const damage of ["tampered-tree", "non-committed-journal", "unsafe-cleanup-root"]) {
    await t.test(damage, async () => {
      const fixture = await createUpdateFixture({
        currentVersion: previousTag.slice(1),
        candidateVersion: currentReleaseVersion,
      });
      const port = await getFreePort();
      const env = {
        TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
        TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
      };
      const updateDirectory = path.join(fixture.stateDirectory, "app-update");
      const pendingPath = path.join(updateDirectory, "pending.json");
      const journalPath = path.join(updateDirectory, "apply-journal.json");
      let interruptedInstance;
      t.after(async () => {
        runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
        if (interruptedInstance) {
          const interruptedProcess = {
            serverPid: interruptedInstance.pid,
            serverProcessStartTimeUtc: interruptedInstance.processStartTimeUtc,
          };
          if (isRecordedProcessRunning(interruptedProcess)) stopRecordedProcessForTest(interruptedProcess);
        }
        await closeServer(fixture.releaseServer);
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      });

      await installTaggedUpdaterCode(fixture.packageRoot, previousTag);
      await prepareStagedFixture(fixture, port);
      const interrupted = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
        "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port),
        "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
      ], {
        cwd: fixture.packageRoot,
        env: { ...env, TARKOV_HELPER_UPDATE_TEST_COMMIT_CLEANUP_CRASH: "BACKUP" },
        timeout: 60_000,
      });
      assert.equal(interrupted.status, 2, `${damage}\n${interrupted.stdout}\n${interrupted.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
      interruptedInstance = JSON.parse(await readFile(path.join(fixture.stateDirectory, "instance.json"), "utf8"));

      if (damage === "tampered-tree") {
        await appendFile(path.join(fixture.packageRoot, "app", "index.html"), "\n<!-- changed after authenticated commit -->\n", "utf8");
      } else if (damage === "non-committed-journal") {
        const journal = JSON.parse(await readFile(journalPath, "utf8"));
        journal.phase = "HEALTHY";
        await writeFile(journalPath, `${JSON.stringify(journal)}\n`, "utf8");
      } else {
        const pending = JSON.parse(await readFile(pendingPath, "utf8"));
        const cleanupRoot = path.join(
          path.dirname(fixture.packageRoot),
          `.${path.basename(fixture.packageRoot)}.update-cleanup-${pending.candidateId}`,
        );
        await writeFile(cleanupRoot, "a non-directory cleanup path must be preserved\n", "utf8");
      }
      const pendingBefore = await readFile(pendingPath, "utf8");
      const journalBefore = await readFile(journalPath, "utf8");

      const refused = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
        "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port),
        "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
      ], { cwd: fixture.packageRoot, env, timeout: 45_000 });
      assert.equal(refused.status, 2, `${damage}\n${refused.stdout}\n${refused.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
      assert.equal(await readFile(pendingPath, "utf8"), pendingBefore);
      assert.equal(await readFile(journalPath, "utf8"), journalBefore);
      assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, currentReleaseVersion);
    });
  }
});

test("offline terminal cleanup accepts a COMMITTED journal with an explicit no-child identity", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const { updateDirectory } = await prepareOfflineCommittedProof(fixture, port, env);
  const journalPath = path.join(updateDirectory, "apply-journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.serverPid = 0;
  journal.serverProcessStartTimeUtc = "";
  await writeFile(journalPath, `${JSON.stringify(journal)}\n`, "utf8");

  const recovered = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port),
    "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 45_000 });
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  await assert.rejects(stat(path.join(updateDirectory, "pending.json")), { code: "ENOENT" });
  await assert.rejects(stat(journalPath), { code: "ENOENT" });
});

test("offline terminal cleanup stops only an exact journaled child and preserves metadata on inspection or stop failure", { skip: process.platform !== "win32", timeout: 210_000 }, async (t) => {
  for (const scenario of ["success", "inspection-failure", "stop-failure"]) {
    await t.test(scenario, async (t) => {
      const fixture = await createUpdateFixture();
      const port = await getFreePort();
      const baseEnv = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
      const { child, record } = await startRecordedSleeperForTest();
      t.after(async () => {
        if (isRecordedProcessRunning(record)) stopRecordedProcessForTest(record);
        runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env: baseEnv, timeout: 10_000 });
        await closeServer(fixture.releaseServer);
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
        child.unref();
      });

      const { pending, updateDirectory } = await prepareOfflineCommittedProof(fixture, port, baseEnv);
      const pendingPath = path.join(updateDirectory, "pending.json");
      const journalPath = path.join(updateDirectory, "apply-journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      journal.serverPid = record.serverPid;
      journal.serverProcessStartTimeUtc = record.serverProcessStartTimeUtc;
      await writeFile(journalPath, `${JSON.stringify(journal)}\n`, "utf8");
      const pendingBefore = await readFile(pendingPath, "utf8");
      const journalBefore = await readFile(journalPath, "utf8");
      const env = { ...baseEnv };
      if (scenario !== "success") {
        env[scenario === "inspection-failure"
          ? "TARKOV_HELPER_UPDATE_TEST_TERMINAL_CHILD_INSPECTION_FAILURE"
          : "TARKOV_HELPER_UPDATE_TEST_TERMINAL_CHILD_STOP_FAILURE"] = "1";
        const pinnedBroker = path.join(updateDirectory, `broker-${pending.brokerSha256}.ps1`);
        await rm(pinnedBroker, { recursive: true, force: true });
        await mkdir(pinnedBroker);
      }

      const recovered = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
        "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port),
        "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
      ], { env, timeout: 45_000 });
      if (scenario === "success") {
        assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
        assert.equal(isRecordedProcessRunning(record), false, "the exact journaled child must exit before metadata retirement");
        await assert.rejects(stat(pendingPath), { code: "ENOENT" });
        await assert.rejects(stat(journalPath), { code: "ENOENT" });
      } else {
        assert.equal(recovered.status, 2, `${scenario}\n${recovered.stdout}\n${recovered.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
        assert.equal(isRecordedProcessRunning(record), true, "a failed inspection or stop must not assume exact child exit");
        assert.equal(await readFile(pendingPath, "utf8"), pendingBefore);
        assert.equal(await readFile(journalPath, "utf8"), journalBefore);
      }
    });
  }
});

test("offline terminal cleanup stops a bound Serve child after instance loss before reserving its port", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
  let journaledChild;
  t.after(async () => {
    if (journaledChild && isRecordedProcessRunning(journaledChild)) stopRecordedProcessForTest(journaledChild);
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const { pending, updateDirectory } = await prepareOfflineCommittedProof(fixture, port, env);
  const serve = spawn(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(fixture.packageRoot, "launcher.ps1"),
    "-Action", "Serve", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port),
    "-NoBrowser", "-StateDirectory", fixture.stateDirectory, "-UpdateNonce", pending.healthNonce,
  ], { stdio: "ignore", windowsHide: true, env: { ...process.env, ...env } });
  const instancePath = path.join(fixture.stateDirectory, "instance.json");
  const instance = await waitFor(
    async () => JSON.parse(await readFile(instancePath, "utf8")),
    (value) => value?.pid === serve.pid && value?.updateNonce === pending.healthNonce,
    15_000,
  );
  journaledChild = {
    serverPid: instance.pid,
    serverProcessStartTimeUtc: instance.processStartTimeUtc,
  };
  const journalPath = path.join(updateDirectory, "apply-journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.serverPid = journaledChild.serverPid;
  journal.serverProcessStartTimeUtc = journaledChild.serverProcessStartTimeUtc;
  await writeFile(journalPath, `${JSON.stringify(journal)}\n`, "utf8");
  await rm(instancePath);
  assert.equal(isRecordedProcessRunning(journaledChild), true);

  const pinnedBroker = path.join(updateDirectory, `broker-${pending.brokerSha256}.ps1`);
  await rm(pinnedBroker, { recursive: true, force: true });
  await mkdir(pinnedBroker);
  const recovered = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port),
    "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 45_000 });
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(isRecordedProcessRunning(journaledChild), false, "the exact child must exit before its port can be reserved");
  const replacement = JSON.parse(await readFile(instancePath, "utf8"));
  assert.notEqual(replacement.pid, journaledChild.serverPid);
  await assert.rejects(stat(path.join(updateDirectory, "pending.json")), { code: "ENOENT" });
  await assert.rejects(stat(journalPath), { code: "ENOENT" });
});

test("offline terminal cleanup retries a bounded candidate cleanup tree seven times and preserves proof after exhaustion", { skip: process.platform !== "win32", timeout: 150_000 }, async (t) => {
  for (const injectedFailures of [7, 8]) {
    await t.test(`${injectedFailures} failures`, async (t) => {
      const fixture = await createUpdateFixture();
      const port = await getFreePort();
      const baseEnv = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
      t.after(async () => {
        runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env: baseEnv, timeout: 10_000 });
        await closeServer(fixture.releaseServer);
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      });

      const { pending, updateDirectory } = await prepareOfflineCommittedProof(fixture, port, baseEnv);
      const pendingPath = path.join(updateDirectory, "pending.json");
      const journalPath = path.join(updateDirectory, "apply-journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      journal.serverPid = 0;
      journal.serverProcessStartTimeUtc = "";
      await writeFile(journalPath, `${JSON.stringify(journal)}\n`, "utf8");
      const cleanupRoot = path.join(
        path.dirname(fixture.packageRoot),
        `.${path.basename(fixture.packageRoot)}.update-cleanup-${pending.candidateId}`,
      );
      await mkdir(path.join(cleanupRoot, "nested"), { recursive: true });
      await writeFile(path.join(cleanupRoot, "nested", "locked-on-prior-attempts.txt"), "retry-safe residue\n", "utf8");
      const pinnedBroker = path.join(updateDirectory, `broker-${pending.brokerSha256}.ps1`);
      await rm(pinnedBroker, { recursive: true, force: true });
      await mkdir(pinnedBroker);
      const pendingBefore = await readFile(pendingPath, "utf8");
      const journalBefore = await readFile(journalPath, "utf8");

      const recovered = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
        "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port),
        "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
      ], {
        env: { ...baseEnv, TARKOV_HELPER_UPDATE_TEST_TERMINAL_CLEANUP_DELETE_FAILURES: String(injectedFailures) },
        timeout: 45_000,
      });
      if (injectedFailures === 7) {
        assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
        await assert.rejects(stat(cleanupRoot), { code: "ENOENT" });
        await assert.rejects(stat(pendingPath), { code: "ENOENT" });
        await assert.rejects(stat(journalPath), { code: "ENOENT" });
      } else {
        assert.equal(recovered.status, 2, `${recovered.stdout}\n${recovered.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
        assert.equal((await stat(cleanupRoot)).isDirectory(), true);
        assert.equal(await readFile(pendingPath, "utf8"), pendingBefore);
        assert.equal(await readFile(journalPath, "utf8"), journalBefore);
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
  await assert.rejects(stat(backupRoot), { code: "ENOENT" });
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

test("distinguishes GitHub API rate limits from other 403 responses", { skip: process.platform !== "win32", timeout: 60_000 }, async (t) => {
  for (const scenario of [
    {
      name: "rate limit",
      releaseHeaders: { "X-RateLimit-Remaining": "0" },
      releaseBody: `${JSON.stringify({ message: "API rate limit exceeded" })}\n`,
      expectedCode: "GITHUB_RATE_LIMIT",
    },
    {
      name: "forbidden",
      releaseHeaders: { "X-RateLimit-Remaining": "12" },
      releaseBody: `${JSON.stringify({ message: "Forbidden" })}\n`,
      expectedCode: "GITHUB_FORBIDDEN",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = await createUpdateFixture({
        releaseBody: scenario.releaseBody,
        releaseHeaders: scenario.releaseHeaders,
        releaseStatus: 403,
      });
      const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1" };
      try {
        const checked = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), [
          "-Action", "Check",
          "-PackageRoot", fixture.packageRoot,
          "-StateDirectory", fixture.stateDirectory,
          "-Port", "41753",
          "-AllowTestHttpLoopback",
        ], { env, timeout: 20_000 });
        assert.equal(checked.status, 5, `${checked.stdout}\n${checked.stderr}`);
        const status = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8"));
        assert.equal(status.code, scenario.expectedCode);
        assert.match(status.message, /GitHub|403|API/);
      } finally {
        await closeServer(fixture.releaseServer);
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      }
    });
  }
});

test("retries a transient GitHub release response before reporting an update failure", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const fixture = await createUpdateFixture();
  fixture.state.releaseStatusSequence = [503, 200];
  const env = {
    TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
    TARKOV_HELPER_UPDATE_TEST_RETRY_DELAY_MS: "10",
  };
  try {
    const result = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), [
      "-Action", "Check",
      "-PackageRoot", fixture.packageRoot,
      "-StateDirectory", fixture.stateDirectory,
      "-Port", "41753",
      "-AllowTestHttpLoopback",
    ], { env, timeout: 20_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const status = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8"));
    assert.equal(status.state, "AVAILABLE", JSON.stringify(status));
    assert.equal(fixture.state.requests.filter(({ url }) => url === `/repos/${repository}/releases/latest`).length, 2);
  } finally {
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("a committed update defers a locked backup cleanup without rolling back and removes it on replay", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
  const backupRoot = path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-backup`);
  const updateDirectory = path.join(fixture.stateDirectory, "app-update");
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  await prepareStagedFixture(fixture, port);
  const deferred = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], {
    env: {
      ...env,
      TARKOV_HELPER_UPDATE_TEST_BACKUP_DELETE_FAILURES: "100",
      TARKOV_HELPER_UPDATE_TEST_BACKUP_DELETE_RETRY_DELAY_MS: "1",
    },
    timeout: 40_000,
  });
  assert.equal(deferred.status, 0, `${deferred.stdout}\n${deferred.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const pending = JSON.parse(await readFile(path.join(updateDirectory, "pending.json"), "utf8"));
  const candidateCleanupRoot = path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-cleanup-${pending.candidateId}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
  await assert.rejects(stat(backupRoot), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(path.join(candidateCleanupRoot, "app", "version.json"), "utf8")).version, "1.0.0");
  assert.notEqual(readWindowsFileAttributes(candidateCleanupRoot) & 0x2, 0, "a deferred cleanup tree must be hidden from normal Explorer views");
  assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "status.json"), "utf8")).state, "UPDATED");
  assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "apply-journal.json"), "utf8")).phase, "COMMITTED");
  assert.equal((await stat(path.join(updateDirectory, "pending.json"))).isFile(), true);

  const stopped = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Stop", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 10_000 });
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
  const replayed = await runExternalBroker(fixture, port, { env, timeout: 40_000 });
  assert.equal(replayed.status, 0, `${replayed.stdout}\n${replayed.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  await assert.rejects(stat(backupRoot), { code: "ENOENT" });
  await assert.rejects(stat(candidateCleanupRoot), { code: "ENOENT" });
  await assert.rejects(stat(path.join(updateDirectory, "pending.json")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(updateDirectory, "apply-journal.json")), { code: "ENOENT" });
});

test("a journal-free committed cleanup recovery restores COMMITTED before PREPARED can erase its evidence", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
  const updateDirectory = path.join(fixture.stateDirectory, "app-update");
  const backupRoot = path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-backup`);
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  await prepareStagedFixture(fixture, port);
  const committed = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env: { ...env, TARKOV_HELPER_UPDATE_TEST_CRASH_PHASE: "COMMITTED" }, timeout: 40_000 });
  assert.equal(committed.status, 2, `${committed.stdout}\n${committed.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const stopped = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Stop", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 10_000 });
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
  await rm(backupRoot, { recursive: true });
  await rm(path.join(updateDirectory, "apply-journal.json"));
  assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "status.json"), "utf8")).state, "UPDATED");

  const recovered = await runExternalBroker(fixture, port, {
    brokerArguments: ["-TestCrashAfterPhase", "PREPARED"],
    timeout: 40_000,
  });
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
  await assert.rejects(stat(path.join(updateDirectory, "pending.json")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(updateDirectory, "apply-journal.json")), { code: "ENOENT" });
});

test("a post-write COMMITTED journal error cannot downgrade the durable terminal transaction", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
  const updateDirectory = path.join(fixture.stateDirectory, "app-update");
  const backupRoot = path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-backup`);
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const brokerFile = path.join(fixture.packageRoot, "app-update-broker.ps1");
  const broker = await readFile(brokerFile, "utf8");
  const boundary = "    if ($TestCrashAfterPhase -ceq $Phase) {";
  assert.equal(broker.includes(boundary), true, "the fixture broker must expose the durable journal boundary");
  await writeFile(brokerFile, broker.replace(boundary, [
    "    if ($Phase -ceq \"COMMITTED\") { throw [IO.IOException]::new(\"Injected error after durable COMMITTED write.\") }",
    boundary,
  ].join("\r\n")), "utf8");

  await prepareStagedFixture(fixture, port);
  const applied = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 40_000 });
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
  assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "status.json"), "utf8")).state, "UPDATED");
  await assert.rejects(stat(backupRoot), { code: "ENOENT" });
  await assert.rejects(stat(path.join(updateDirectory, "pending.json")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(updateDirectory, "apply-journal.json")), { code: "ENOENT" });
});

test("an ambiguous COMMITTED replace plus journal reread denial fails forward without rollback", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
  const updateDirectory = path.join(fixture.stateDirectory, "app-update");
  const backupRoot = path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-backup`);
  const injectedMarker = path.join(updateDirectory, "commit-reread-denied.once");
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  const brokerFile = path.join(fixture.packageRoot, "app-update-broker.ps1");
  let broker = await readFile(brokerFile, "utf8");
  const writeBoundary = "    if ($TestCrashAfterPhase -ceq $Phase) {";
  const readBoundary = "    $path = Get-JournalPath";
  assert.equal(broker.includes(writeBoundary), true, "the fixture broker must expose the durable journal boundary");
  assert.equal(broker.includes(readBoundary), true, "the fixture broker must expose the journal read boundary");
  broker = broker.replace(writeBoundary, [
    "    $denyMarker = Join-Path (Get-UpdateDirectory) \"commit-reread-denied.once\"",
    "    if ($Phase -ceq \"COMMITTED\" -and -not [IO.File]::Exists($denyMarker)) {",
    "        [IO.File]::WriteAllText($denyMarker, \"deny\")",
    "        $script:testDenyCommittedJournalRead = $true",
    "        throw [IO.IOException]::new(\"Injected error after durable COMMITTED replacement.\")",
    "    }",
    writeBoundary,
  ].join("\r\n"));
  broker = broker.replace(readBoundary, [
    readBoundary,
    "    if ((Get-Variable -Name testDenyCommittedJournalRead -Scope Script -ErrorAction SilentlyContinue) -and $script:testDenyCommittedJournalRead) {",
    "        throw [IO.IOException]::new(\"Injected denial while rereading COMMITTED journal.\")",
    "    }",
  ].join("\r\n"));
  await writeFile(brokerFile, broker, "utf8");

  await prepareStagedFixture(fixture, port);
  const pending = JSON.parse(await readFile(path.join(updateDirectory, "pending.json"), "utf8"));
  await copyFile(brokerFile, path.join(updateDirectory, `broker-${pending.brokerSha256}.ps1`));
  const deferred = await runExternalBroker(fixture, port, { env, timeout: 40_000 });
  assert.equal(deferred.status, 20, `${deferred.stdout}\n${deferred.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(await pathExists(injectedMarker), true);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
  assert.equal(JSON.parse(await readFile(path.join(backupRoot, "app", "version.json"), "utf8")).version, "1.0.0");
  assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "apply-journal.json"), "utf8")).phase, "COMMITTED");
  assert.equal((await stat(path.join(updateDirectory, "pending.json"))).isFile(), true);

  const recovered = await runExternalBroker(fixture, port, { env, timeout: 40_000 });
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
  await assert.rejects(stat(backupRoot), { code: "ENOENT" });
  await assert.rejects(stat(path.join(updateDirectory, "pending.json")), { code: "ENOENT" });
});

test("COMMITTED recovery without an instance never downgrades or rolls back when health bootstrap fails", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });
  const { failedRoot, updateDirectory } = await prepareJournalFreeCommittedGap(fixture, port, env);

  const deferred = await runExternalBroker(fixture, port, {
    brokerArguments: ["-TestFailHealth"],
    timeout: 40_000,
  });
  assert.equal(deferred.status, 20, `${deferred.stdout}\n${deferred.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
  assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "apply-journal.json"), "utf8")).phase, "COMMITTED");
  await assert.rejects(stat(failedRoot), { code: "ENOENT" });
  assert.equal((await stat(path.join(updateDirectory, "pending.json"))).isFile(), true);

  const recovered = await runExternalBroker(fixture, port, { timeout: 40_000 });
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
  await assert.rejects(stat(failedRoot), { code: "ENOENT" });
  await assert.rejects(stat(path.join(updateDirectory, "pending.json")), { code: "ENOENT" });
});

test("COMMITTED recovery without an instance survives a hard crash immediately after server start", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
  t.after(async () => {
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });
  const { failedRoot, updateDirectory } = await prepareJournalFreeCommittedGap(fixture, port, env);

  const interrupted = await runExternalBroker(fixture, port, {
    env: { ...env, TARKOV_HELPER_UPDATE_TEST_COMMITTED_RECOVERY_CRASH_AFTER_START: "1" },
    timeout: 40_000,
  });
  assert.equal(interrupted.status, 95, `${interrupted.stdout}\n${interrupted.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
  assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "apply-journal.json"), "utf8")).phase, "COMMITTED");
  await assert.rejects(stat(failedRoot), { code: "ENOENT" });
  assert.equal((await stat(path.join(updateDirectory, "pending.json"))).isFile(), true);

  const recovered = await runExternalBroker(fixture, port, { timeout: 40_000 });
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
  await assert.rejects(stat(failedRoot), { code: "ENOENT" });
  await assert.rejects(stat(path.join(updateDirectory, "pending.json")), { code: "ENOENT" });
});

test("COMMITTED recovery stops only its exact hung children before deferring for retry", { skip: process.platform !== "win32", timeout: 150_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const baseEnv = {
    TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1",
    TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1",
  };
  const env = {
    ...baseEnv,
    TARKOV_HELPER_UPDATE_TEST_SERVER_NEVER_PUBLISHES_INSTANCE: "1",
  };
  const records = [];
  t.after(async () => {
    for (const record of records) stopRecordedProcessForTest(record);
    runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });
  const { failedRoot, updateDirectory } = await prepareJournalFreeCommittedGap(fixture, port, baseEnv);

  const interrupted = await runExternalBroker(fixture, port, {
    env: { ...env, TARKOV_HELPER_UPDATE_TEST_COMMITTED_RECOVERY_CRASH_AFTER_START: "1" },
    timeout: 40_000,
  });
  assert.equal(interrupted.status, 95, `${interrupted.stdout}\n${interrupted.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const interruptedJournal = JSON.parse(await readFile(path.join(updateDirectory, "apply-journal.json"), "utf8"));
  records.push(interruptedJournal);
  assert.equal(isRecordedProcessRunning(interruptedJournal), true, "the fixture must leave the exact journaled child hung before replay");

  const deferred = await runExternalBroker(fixture, port, {
    env,
    brokerArguments: ["-TestFailHealth"],
    timeout: 40_000,
  });
  assert.equal(deferred.status, 20, `${deferred.stdout}\n${deferred.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  const deferredJournal = JSON.parse(await readFile(path.join(updateDirectory, "apply-journal.json"), "utf8"));
  records.push(deferredJournal);
  assert.notEqual(deferredJournal.serverPid, interruptedJournal.serverPid, "replay must advance past the stale hung child");
  await waitFor(async () => isRecordedProcessRunning(interruptedJournal), (running) => running === false, 10_000);
  await waitFor(async () => isRecordedProcessRunning(deferredJournal), (running) => running === false, 10_000);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
  assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "apply-journal.json"), "utf8")).phase, "COMMITTED");
  assert.equal((await stat(path.join(updateDirectory, "pending.json"))).isFile(), true);
  await assert.rejects(stat(failedRoot), { code: "ENOENT" });

  const recovered = await runExternalBroker(fixture, port, { timeout: 40_000 });
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
  await assert.rejects(stat(failedRoot), { code: "ENOENT" });
  await assert.rejects(stat(path.join(updateDirectory, "pending.json")), { code: "ENOENT" });
});

test("post-COMMITTED metadata cleanup errors defer safely and replay without rollback", { skip: process.platform !== "win32", timeout: 240_000 }, async (t) => {
  for (const boundary of ["CANDIDATE", "JOURNAL", "RUNONCE", "PENDING"]) {
    await t.test(boundary, async () => {
      const fixture = await createUpdateFixture();
      const port = await getFreePort();
      const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
      const updateDirectory = path.join(fixture.stateDirectory, "app-update");
      const backupRoot = path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-backup`);
      let cleanedByAliveRelaunch = false;
      try {
        await prepareStagedFixture(fixture, port);
        const deferred = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
          "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
        ], {
          env: { ...env, TARKOV_HELPER_UPDATE_TEST_COMMIT_CLEANUP_ERROR: boundary },
          timeout: 40_000,
        });
        assert.equal(deferred.status, 0, `${boundary}\n${deferred.stdout}\n${deferred.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
        assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
        assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "status.json"), "utf8")).state, "UPDATED");
        await assert.rejects(stat(backupRoot), { code: "ENOENT" });
        assert.equal((await stat(path.join(updateDirectory, "pending.json"))).isFile(), true);

        if (boundary === "PENDING") {
          const base = `http://127.0.0.1:${port}/`;
          const sessionResponse = await fetch(new URL("api/v1/app-update/session", base), {
            headers: { "Sec-Fetch-Site": "same-origin" },
          });
          assert.equal(sessionResponse.status, 200);
          const session = await sessionResponse.json();
          const busyCheck = await fetch(new URL("api/v1/app-update/check", base), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: base.slice(0, -1),
              "Sec-Fetch-Site": "same-origin",
              "X-Tarkov-Update": session.token,
            },
            body: "{}",
          });
          assert.equal(busyCheck.status, 409, await busyCheck.clone().text());
          assert.equal((await busyCheck.json()).error.code, "UPDATE_BUSY");
          assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "status.json"), "utf8")).state, "UPDATED");

          const checked = await runPowerShellAsync(path.join(fixture.packageRoot, "app-update-worker.ps1"), [
            "-Action", "Check", "-PackageRoot", fixture.packageRoot, "-StateDirectory", fixture.stateDirectory,
            "-Port", String(port), "-AllowTestHttpLoopback",
          ], { env, timeout: 20_000 });
          assert.notEqual(checked.status, 0, `${checked.stdout}\n${checked.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
          assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "status.json"), "utf8")).state, "UPDATED");
          assert.equal((await stat(path.join(updateDirectory, "pending.json"))).isFile(), true);

          const pending = JSON.parse(await readFile(path.join(updateDirectory, "pending.json"), "utf8"));
          const failedRoot = path.join(
            path.dirname(fixture.packageRoot),
            `.${path.basename(fixture.packageRoot)}.update-failed-${pending.candidateId}`,
          );
          await assert.rejects(stat(path.join(updateDirectory, "apply-journal.json")), { code: "ENOENT" });
          const relaunched = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
            "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
          ], { env, timeout: 40_000 });
          assert.equal(relaunched.status, 0, `${relaunched.stdout}\n${relaunched.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
          assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
          await assert.rejects(stat(failedRoot), { code: "ENOENT" });
          await assert.rejects(stat(path.join(updateDirectory, "pending.json")), { code: "ENOENT" });
          await assert.rejects(stat(path.join(updateDirectory, "apply-journal.json")), { code: "ENOENT" });
          cleanedByAliveRelaunch = true;
        }

        const stopped = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), [
          "-Action", "Stop", "-StateDirectory", fixture.stateDirectory,
        ], { env, timeout: 10_000 });
        assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
        if (!cleanedByAliveRelaunch) {
          const replayed = await runExternalBroker(fixture, port, { env, timeout: 40_000 });
          assert.equal(replayed.status, 0, `${boundary}\n${replayed.stdout}\n${replayed.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
        }
        assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
        await assert.rejects(stat(path.join(updateDirectory, "pending.json")), { code: "ENOENT" });
        await assert.rejects(stat(path.join(updateDirectory, "apply-journal.json")), { code: "ENOENT" });
      } finally {
        runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
        await closeServer(fixture.releaseServer);
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      }
    });
  }
});

test("post-COMMITTED hard crashes at cleanup boundaries never make the installed tree rollbackable", { skip: process.platform !== "win32", timeout: 300_000 }, async (t) => {
  for (const boundary of ["BACKUP", "CANDIDATE", "JOURNAL", "RUNONCE", "PENDING"]) {
    await t.test(boundary, async () => {
      const fixture = await createUpdateFixture();
      const port = await getFreePort();
      const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
      const updateDirectory = path.join(fixture.stateDirectory, "app-update");
      const backupRoot = path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-backup`);
      try {
        await prepareStagedFixture(fixture, port);
        const interrupted = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
          "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
        ], {
          env: { ...env, TARKOV_HELPER_UPDATE_TEST_COMMIT_CLEANUP_CRASH: boundary },
          timeout: 40_000,
        });
        assert.equal(interrupted.status, 2, `${boundary}\n${interrupted.stdout}\n${interrupted.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
        assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
        assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "status.json"), "utf8")).state, "UPDATED");
        await assert.rejects(stat(backupRoot), { code: "ENOENT" });

        const stopped = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), [
          "-Action", "Stop", "-StateDirectory", fixture.stateDirectory,
        ], { env, timeout: 10_000 });
        assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
        if (boundary === "PENDING") {
          await assert.rejects(stat(path.join(updateDirectory, "pending.json")), { code: "ENOENT" });
          await assert.rejects(stat(path.join(updateDirectory, "apply-journal.json")), { code: "ENOENT" });
        } else {
          assert.equal((await stat(path.join(updateDirectory, "pending.json"))).isFile(), true);
          const replayed = await runExternalBroker(fixture, port, { env, timeout: 40_000 });
          assert.equal(replayed.status, 0, `${boundary}\n${replayed.stdout}\n${replayed.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
          assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
          await assert.rejects(stat(path.join(updateDirectory, "pending.json")), { code: "ENOENT" });
          await assert.rejects(stat(path.join(updateDirectory, "apply-journal.json")), { code: "ENOENT" });
        }
      } finally {
        runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
        await closeServer(fixture.releaseServer);
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      }
    });
  }
});

test("external broker recovers every durable apply phase idempotently", { skip: process.platform !== "win32", timeout: 180_000 }, async (t) => {
  const phases = ["PREPARED", "OLD_MOVED", "NEW_MOVED", "NEW_STARTED", "HEALTHY", "COMMITTED"];
  for (const phase of phases) {
    await t.test(phase, async () => {
      const fixture = await createUpdateFixture();
      const port = await getFreePort();
      const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
      const backupRoot = path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-backup`);
      try {
        await prepareStagedFixture(fixture, port);
        const interrupted = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
          "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
        ], { env: { ...env, TARKOV_HELPER_UPDATE_TEST_CRASH_PHASE: phase }, timeout: 30_000 });
        assert.equal(interrupted.status, 2, `${phase}\n${interrupted.stdout}\n${interrupted.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
        const journal = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "apply-journal.json"), "utf8"));
        assert.equal(journal.phase, phase);
        if (phase === "COMMITTED") {
          // Model a full power loss after the committed rollback tree and
          // terminal journal were removed, but before pending.json was deleted
          // last. Recovery must re-authenticate a newly started server rather
          // than relying on the process that originally passed health.
          const stopped = runPowerShell(path.join(fixture.packageRoot, "launcher.ps1"), [
            "-Action", "Stop", "-StateDirectory", fixture.stateDirectory,
          ], { env, timeout: 10_000 });
          assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
          await rm(backupRoot, { recursive: true });
          await rm(path.join(fixture.stateDirectory, "app-update", "apply-journal.json"));
        }

        const recovered = await runExternalBroker(fixture, port, { timeout: 40_000 });
        assert.equal(recovered.status, 0, `${phase}\n${recovered.stdout}\n${recovered.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
        assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
        const status = JSON.parse(await readFile(path.join(fixture.stateDirectory, "app-update", "status.json"), "utf8"));
        assert.equal(status.state, "UPDATED");
        await assert.rejects(stat(backupRoot), { code: "ENOENT" });
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

test("a newer side-by-side install never archives another install's interrupted OLD_MOVED transaction", { skip: process.platform !== "win32", timeout: 90_000 }, async (t) => {
  const fixture = await createUpdateFixture();
  const port = await getFreePort();
  const env = { TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP: "1", TARKOV_HELPER_UPDATE_TEST_SKIP_RUNONCE: "1" };
  const updateDirectory = path.join(fixture.stateDirectory, "app-update");
  const backupRoot = path.join(path.dirname(fixture.packageRoot), `.${path.basename(fixture.packageRoot)}.update-backup`);
  const newerRoot = path.join(fixture.temporaryRoot, "side-by-side-current");
  t.after(async () => {
    for (const root of [fixture.packageRoot, newerRoot]) {
      runPowerShell(path.join(root, "launcher.ps1"), ["-Action", "Stop", "-StateDirectory", fixture.stateDirectory], { env, timeout: 10_000 });
    }
    await closeServer(fixture.releaseServer);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  });

  await prepareStagedFixture(fixture, port);
  const interrupted = await runPowerShellAsync(path.join(fixture.packageRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(fixture.packageRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env: { ...env, TARKOV_HELPER_UPDATE_TEST_CRASH_PHASE: "OLD_MOVED" }, timeout: 30_000 });
  assert.equal(interrupted.status, 2, `${interrupted.stdout}\n${interrupted.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "apply-journal.json"), "utf8")).phase, "OLD_MOVED");
  await assert.rejects(stat(fixture.packageRoot), { code: "ENOENT" });
  assert.equal((await stat(backupRoot)).isDirectory(), true);

  await writeDirectPackage(newerRoot, {
    version: "1.1.0",
    commit: newCommit,
    updateConfig: JSON.parse(await readFile(path.join(backupRoot, "UPDATE_CONFIG.json"), "utf8")),
  });
  const refused = await runPowerShellAsync(path.join(newerRoot, "launcher.ps1"), [
    "-Action", "Start", "-Root", path.join(newerRoot, "app"), "-Port", String(port), "-NoBrowser", "-StateDirectory", fixture.stateDirectory,
  ], { env, timeout: 15_000 });
  assert.equal(refused.status, 2, `${refused.stdout}\n${refused.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(updateDirectory, "apply-journal.json"), "utf8")).phase, "OLD_MOVED");
  assert.equal((await stat(path.join(updateDirectory, "pending.json"))).isFile(), true);
  assert.equal((await stat(backupRoot)).isDirectory(), true);
  assert.deepEqual((await readdir(fixture.stateDirectory)).filter((name) => name.startsWith("app-update-stale-backup-")), []);

  const recovered = await runExternalBroker(fixture, port, { env, timeout: 40_000 });
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}\n${await updateDiagnostics(fixture.stateDirectory)}`);
  assert.equal(JSON.parse(await readFile(path.join(fixture.packageRoot, "app", "version.json"), "utf8")).version, "1.1.0");
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
