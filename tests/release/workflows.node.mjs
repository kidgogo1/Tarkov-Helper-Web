import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildWindowsLauncher } from "../../scripts/build-windows-launcher.mjs";
import { checksumText, collectFiles, createZipFromDirectory, sha256 } from "../../scripts/release-utils.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");

async function text(relativePath) {
  return readFile(path.join(projectRoot, relativePath), "utf8");
}

function actionReferences(workflow) {
  return [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map((match) => match[1]);
}

function workflowJob(workflow, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\n  ${escapedName}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:\\n|$)`)
    .exec(`\n${workflow.replace(/\r\n?/g, "\n")}`)?.[1] ?? "";
}

function isolatedZipValidatorSource(workflow) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes("$zipValidatorSource = @'"));
  const end = lines.findIndex((line, index) => index > start && line.trim() === "'@");
  assert(start >= 0 && end > start, "isolated ZIP validator source must be embedded in the signing job");
  return `${lines.slice(start + 1, end).map((line) => line.slice(Math.min(10, line.length))).join("\n")}\n`;
}

test("all third-party workflow actions are pinned to a full commit SHA", async () => {
  for (const filename of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    const workflow = await text(filename);
    const references = actionReferences(workflow);
    assert(references.length > 0, `${filename} must use at least one action`);
    for (const reference of references) {
      assert.match(reference, /^[^@]+@[0-9a-f]{40}$/, `${filename}: ${reference}`);
    }
  }
});

test("CI is read-only and every browser test remains headless", async () => {
  const workflow = await text(".github/workflows/ci.yml");
  const releaseWorkflow = await text(".github/workflows/release.yml");
  const qualityJob = workflowJob(workflow, "quality");
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s+read\s*$/m);
  assert.doesNotMatch(workflow, /contents:\s+write/);
  assert.doesNotMatch(workflow, /--headed|headless:\s*false|Start-Process/i);
  assert.match(workflow, /pnpm test:e2e/);
  assert.match(workflow, /pnpm test:data/);
  assert.match(workflow, /pnpm test:release/);
  assert.match(workflowJob(releaseWorkflow, "quality"), /pnpm test:data/);
  assert.match(qualityJob, /actions\/checkout@[0-9a-f]{40}[\s\S]*fetch-depth:\s*0/,
    "portable historical first-hop tests require the previous release tags");
});

test("CI exercises an extracted final Direct ZIP on Windows Server 2022", async () => {
  const workflow = await text(".github/workflows/ci.yml");
  const compatibilityJob = workflowJob(workflow, "windows-2022-compatibility");
  assert.notEqual(compatibilityJob, "", "CI must define a Windows Server 2022 compatibility job");
  assert.match(compatibilityJob, /runs-on:\s+windows-2022/);
  assert.match(compatibilityJob, /pnpm install --frozen-lockfile/);
  assert.match(compatibilityJob, /dotnet-version:\s+10\.0\.301/);
  assert.match(compatibilityJob, /node scripts\/create-direct-release\.mjs/);
  assert.match(compatibilityJob, /create-release-bundle\.mjs[\s\S]*--updater-disabled/);
  assert.match(compatibilityJob, /verify-release-bundle\.mjs[\s\S]*--updater-disabled/);
  assert.match(compatibilityJob, /ZipFile\]::ExtractToDirectory/);
  assert.match(compatibilityJob, /TARKOV_HELPER_DIRECT_ROOT/);
  assert.match(compatibilityJob, /TcpListener/);
  assert.match(compatibilityJob, /LocalEndpoint\)\.Port/);
  assert.match(compatibilityJob, /netstat\.exe[\s\S]*LISTENING/);
  assert.match(compatibilityJob, /pnpm test:e2e:direct/);
  assert.doesNotMatch(compatibilityJob, /TARKOV_HELPER_E2E_PORT\s*[:=]\s*["']?41753/);

  const verified = compatibilityJob.indexOf("verify-release-bundle.mjs");
  const extracted = compatibilityJob.indexOf("ExtractToDirectory");
  const directRoot = compatibilityJob.indexOf("TARKOV_HELPER_DIRECT_ROOT");
  const browserE2e = compatibilityJob.indexOf("pnpm test:e2e:direct", directRoot);
  assert(verified >= 0 && verified < extracted && extracted < directRoot && directRoot < browserE2e,
    "the final ZIP must be verified, extracted, and selected before its browser E2E runs");
});

test("release packaging launches the exact verified prepared Direct ZIP", async () => {
  const workflow = await text(".github/workflows/release.yml");
  const packageJob = workflowJob(workflow, "package");
  assert.equal([...packageJob.matchAll(/pnpm test:e2e:direct/g)].length, 1,
    "the release package job should run only the post-ZIP Direct E2E");
  assert.match(packageJob, /verify-release-bundle\.mjs[\s\S]*--prepared-only/);
  assert.match(packageJob, /ZipFile\]::ExtractToDirectory/);
  assert.match(packageJob, /TARKOV_HELPER_DIRECT_ROOT/);
  assert.match(packageJob, /TcpListener/);
  assert.match(packageJob, /LocalEndpoint\)\.Port/);
  assert.match(packageJob, /netstat\.exe[\s\S]*LISTENING/);

  const verified = packageJob.indexOf("verify-release-bundle.mjs");
  const extracted = packageJob.indexOf("ExtractToDirectory", verified);
  const directRoot = packageJob.indexOf("TARKOV_HELPER_DIRECT_ROOT", extracted);
  const browserE2e = packageJob.indexOf("pnpm test:e2e:direct", directRoot);
  assert(verified >= 0 && verified < extracted && extracted < directRoot && directRoot < browserE2e,
    "release E2E must consume the prepared ZIP after release-bundle verification");
});

test("generated release notes prepend a fixed legacy-update recovery path", async () => {
  const workflow = await text(".github/workflows/release.yml");
  const finalizeJob = workflowJob(workflow, "finalize");
  assert.match(finalizeJob, /v1\.0\.2 이하/);
  assert.doesNotMatch(finalizeJob, /v1\.0\.4 이하/);
  assert.match(finalizeJob, /업데이트가 반복해서 실패/);
  assert.match(finalizeJob, /기존 Tarkov Helper를 먼저 종료/);
  assert.match(finalizeJob, /기존 폴더에 덮어쓰지/);
  assert.match(finalizeJob, /최신 Direct ZIP/);
  assert.match(finalizeJob, /새 짧은 폴더/);
  assert.match(finalizeJob, /Tarkov Helper 격리 복구 실행\.cmd/);
  assert.match(finalizeJob, /일반 상태는 보존/);
  assert.match(finalizeJob, /gh release create[\s\S]*--generate-notes[\s\S]*--notes \$recoveryNotes/);
});

test("every launcher build job installs the exact pinned .NET SDK", async () => {
  const ci = (await text(".github/workflows/ci.yml")).replace(/\r\n?/g, "\n");
  const release = (await text(".github/workflows/release.yml")).replace(/\r\n?/g, "\n");
  const helper = await text("scripts/build-windows-launcher.mjs");
  const setupDotnet = "actions/setup-dotnet@26b0ec14cb23fa6904739307f278c14f94c95bf1";
  const setupContract = new RegExp(
    `uses: ${setupDotnet} # v5\\.4\\.0[\\s\\S]*?with:\\s*\\n\\s+dotnet-version: 10\\.0\\.301`,
  );
  const compatibilityJob = workflowJob(ci, "windows-2022-compatibility");
  assert.equal(actionReferences(ci).filter((reference) => reference === setupDotnet).length, 2);
  assert.match(ci, setupContract);
  assert.match(compatibilityJob, setupContract);

  const qualityJob = /\n\x20{2}quality:\n([\s\S]*?)\n\x20{2}package:\n/.exec(release)?.[1] ?? "";
  const packageJob = /\n\x20{2}package:\n([\s\S]*?)\n\x20{2}finalize:\n/.exec(release)?.[1] ?? "";
  assert.equal(actionReferences(release).filter((reference) => reference === setupDotnet).length, 2);
  assert.match(qualityJob, setupContract);
  assert.match(packageJob, setupContract);
  assert.match(helper, /const PINNED_DOTNET_SDK = "10\.0\.301";/);
  assert.match(helper, /sdk\.version === PINNED_DOTNET_SDK/);
  assert.doesNotMatch(helper, /sdks\.at\(-1\)|sort\(compareSdkVersions\)/);
});

test("the Direct E2E allows a bounded cold Windows launcher startup", async () => {
  const script = await text("e2e/direct-run.mjs");
  assert.match(script, /const serverStartupTimeoutMs = 30_000;/);
  assert.match(script, /}, serverStartupTimeoutMs\);/);
});

test("release identity comes from GitHub context and signing is isolated from tagged code", async () => {
  const workflow = (await text(".github/workflows/release.yml")).replace(/\r\n?/g, "\n");
  const packageJob = /\n\x20{2}package:\n([\s\S]*?)\n\x20{2}finalize:\n/.exec(workflow)?.[1] ?? "";
  const finalizeJob = /\n\x20{2}finalize:\n([\s\S]*?)\n\x20{2}sign:\n/.exec(workflow)?.[1] ?? "";
  const signJob = /\n\x20{2}sign:\n([\s\S]*?)\n\x20{2}publish:\n/.exec(workflow)?.[1] ?? "";
  const publishJob = /\n\x20{2}publish:\n([\s\S]*)$/.exec(workflow)?.[1] ?? "";
  assert.match(workflow, /\$\{\{\s*github\.repository\s*\}\}/);
  assert.match(workflow, /\$\{\{\s*github\.sha\s*\}\}/);
  assert.match(workflow, /\$\{\{\s*github\.ref_name\s*\}\}/);
  assert.doesNotMatch(workflow, /example-owner|Zeliper|SIGDrone/i);
  assert.match(workflow, /publish:[\s\S]*?permissions:\s*\n\s+contents:\s+write\s*\n\s+id-token:\s+write\s*\n\s+attestations:\s+write\s*\n\s+artifact-metadata:\s+write/);
  assert.doesNotMatch(workflow, /--headed|headless:\s*false|Start-Process/i);
  assert.match(workflow, /--verify-tag/);
  assert.match(workflow, /digest/i);
  assert.match(workflow, /immutable-releases/i);
  assert.match(workflow, /UPDATE_SIGNING_PRIVATE_KEY/);
  assert.match(workflow, /UPDATE_SIGNING_PUBLIC_KEY/);
  assert.match(workflow, /reuse the verified draft/i);
  assert.match(workflow, /commits\/\$env:RELEASE_TAG/);
  assert.doesNotMatch(workflow, /--clobber/);
  assert.match(workflow, /package:[\s\S]*?--prepare-only/);
  assert.match(packageJob, /upload-artifact@[0-9a-f]{40}[\s\S]*overwrite:\s+true/);
  assert.match(finalizeJob, /--prepared[\s\S]*--finalize-unsigned/);
  assert.match(finalizeJob, /upload-artifact@[0-9a-f]{40}[\s\S]*release-unsigned-/);
  assert.match(finalizeJob, /releases\?per_page=100/);
  assert.match(finalizeJob, /gh release upload/);
  assert.match(finalizeJob, /releases\/\$releaseId/);
  assert.match(finalizeJob, /for \(\$attempt = 1; \$attempt -le 6; \$attempt \+= 1\)[\s\S]*?\$release = Find-Draft[\s\S]*?Start-Sleep -Seconds 2/);
  assert.match(finalizeJob, /Created draft release was not visible within the bounded wait/);
  assert.match(signJob, /environment:\s+github-release/);
  assert.match(signJob, /needs:\s+finalize/);
  assert.match(signJob, /permissions:\s*\n\s+contents:\s+read/);
  assert.doesNotMatch(signJob, /GITHUB_TOKEN:/);
  assert.doesNotMatch(signJob, /function Invoke-GitHub|Invoke-GitHub "/);
  assert.match(signJob, /download-artifact@[0-9a-f]{40}[\s\S]*release-unsigned-/);
  assert.match(signJob, /upload-artifact@[0-9a-f]{40}[\s\S]*release-signed-/);
  assert.doesNotMatch(signJob, /actions\/checkout|actions\/setup-node|pnpm|\bnode\b|scripts\/|\bgh\s+api/i);
  assert.doesNotMatch(signJob, /Invoke-Expression|Start-Process|(?:^|\s)&\s*[^\r\n]*\.ps1\b|(?:powershell|pwsh)[^\r\n]*-File|\bshell:\s*(?:cmd|bash)/im);
  assert.deepEqual(actionReferences(signJob), [
    "actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  ]);
  assert.match(signJob, /Invoke-RestMethod/);
  assert.match(signJob, /immutable-releases/);
  assert.match(signJob, /ImportFromPem/);
  assert.match(signJob, /Assert-RsaKeyPolicy/);
  assert.match(signJob, /KeySize -gt 16384/);
  assert.match(signJob, /exponentValue -lt 65537/);
  assert.match(signJob, /exponentValue -band 1/);
  assert.match(signJob, /RSASignaturePadding\]::Pkcs1/);
  assert.match(signJob, /JsonDocument/);
  assert.match(signJob, /IsolatedZipValidator/);
  assert.match(signJob, /ValidateLauncher\(\$directReport\.Captured\["Tarkov Helper\.exe"\], \$version\)/);
  assert.match(signJob, /Add-Type -TypeDefinition \$zipValidatorSource -Language CSharp\s*$/m);
  assert.doesNotMatch(signJob, /Add-Type -TypeDefinition \$zipValidatorSource[^\r\n]*-ReferencedAssemblies/);
  assert.match(signJob, /ValidateLocalLayout/);
  assert.match(signJob, /ValidateCollisions/);
  assert.match(signJob, /MaxCompressionRatio/);
  assert.match(signJob, /ValidateInternalChecksums/);
  assert.match(signJob, /AppTreeSha256/);
  assert.match(signJob, /strictDirect/);
  assert.match(signJob, /flags != 0x0800/);
  assert.match(signJob, /externalAttributes != 0x81a40000U/);
  assert.match(signJob, /Explicit directory entries are not allowed/);
  assert.match(signJob, /Required Direct ZIP entry is missing/);
  assert.match(signJob, /TarkovHelper\.ico/);
  assert.match(signJob, /Tarkov Helper\.exe/);
  assert.match(signJob, /start-menu\.ps1/);
  assert.match(signJob, /Tarkov Helper 실행\.vbs/);
  assert.match(signJob, /Tarkov Helper 시작 메뉴 등록\.vbs/);
  assert.match(signJob, /Tarkov Helper 시작 메뉴 제거\.vbs/);
  assert.match(signJob, /Tarkov Helper 종료\.vbs/);
  assert.match(signJob, /문제 해결용 실행\.cmd/);
  assert.match(signJob, /Tarkov Helper 상태 복구\.cmd/);
  assert.match(signJob, /Tarkov Helper 격리 복구 실행\.cmd/);
  assert.match(signJob, /사용 안내\.txt/);
  assert.match(signJob, /ZIP report exceeds client unpacked bounds/);
  assert.match(signJob, /UPDATE_CONFIG\.json/);
  assert.match(publishJob, /releases\/\$releaseId/);
  assert.match(publishJob, /commits\/\$env:RELEASE_TAG/);
  assert.match(signJob, /SHA256SUMS\.txt/);
  assert.match(publishJob, /download-artifact@[0-9a-f]{40}[\s\S]*release-signed-/);
  assert.doesNotMatch(publishJob, /UPDATE_SIGNING_PRIVATE_KEY|SIGNING_KEY_PEM/);
  assert.doesNotMatch(workflow, /--hostname\s+uploads\.github\.com/);
  assert.match(finalizeJob, /gh release upload \$env:RELEASE_TAG \$file\.FullName --repo \$env:RELEASE_REPOSITORY/);
  assert.match(publishJob, /gh release upload \$env:RELEASE_TAG \$file\.FullName --repo \$env:RELEASE_REPOSITORY/);
  assert.match(workflow, /concurrency:\s*\n\s+group:\s+stable-release/);
  assert.doesNotMatch(packageJob, /UPDATE_SIGNING_PRIVATE_KEY|SIGNING_KEY_PEM/);
  assert.doesNotMatch(finalizeJob, /UPDATE_SIGNING_PRIVATE_KEY|SIGNING_KEY_PEM/);
  assert.doesNotMatch(publishJob, /pnpm install|pnpm build|create-direct-release\.mjs/);
  assert.match(publishJob, /verify-release-bundle\.mjs[\s\S]*--release-id[\s\S]*--direct-asset-id[\s\S]*--static-asset-id[\s\S]*--source-asset-id/);
  assert.match(publishJob, /releases\/\$releaseId/);
  assert.doesNotMatch(workflow, /releases\/tags\/\$env:RELEASE_TAG/);
  assert.match(publishJob, /StringComparison\]::Ordinal/);
  assert.match(publishJob, /Assert-ExactAssetSet \$release "Pre-publication draft"/);
  assert.match(publishJob, /\$expectedReleaseId = \[int64\]\$manifest\.releaseId/);
  assert.match(publishJob, /Assert-ExactAssetSet \$published "Published immutable release"/);
  assert.match(publishJob, /\$published\.prerelease/);
  assert.match(publishJob, /\$published\.tag_name/);
  assert.match(publishJob, /\$expectedAssetNames\.Count/);
  assert.match(publishJob, /equal or newer version already exists/);
  assert.match(publishJob, /-f make_latest=legacy/);
  assert.match(publishJob, /for \(\$latestAttempt = 1; \$latestAttempt -le 6; \$latestAttempt \+= 1\)/);
  assert.match(publishJob, /Latest stable release did not become readable within the bounded wait/);
  assert.match(publishJob, /Start-Sleep -Seconds 2/);
  assert.doesNotMatch(publishJob, /-f make_latest=true/);
  assert.doesNotMatch(publishJob, /gh release edit/);
  const privateKeyReferences = [...workflow.matchAll(/UPDATE_SIGNING_PRIVATE_KEY/g)];
  assert.equal(privateKeyReferences.length, 1, "the private key must be exposed only to the fresh isolated signing step");
});

test("isolated signer ZIP validator recomputes trees and rejects unsafe or internally stale archives", {
  skip: process.platform !== "win32",
}, async () => {
  const workflow = await text(".github/workflows/release.yml");
  const parent = await mkdtemp(path.join(os.tmpdir(), "tarkov-isolated-zip-"));
  const input = path.join(parent, "input");
  const archive = path.join(parent, "direct.zip");
  const sourceFile = path.join(parent, "validator.cs");
  const harness = path.join(parent, "validate.ps1");
  const rootDirectory = "Tarkov Helper Direct v1.2.3";
  try {
    await mkdir(path.join(input, "app"), { recursive: true });
    await writeFile(path.join(input, "app", "index.html"), "fixture\n");
    await writeFile(path.join(input, "launcher.ps1"), "fixture\n");
    await writeFile(path.join(input, "app-update-worker.ps1"), "fixture\n");
    await writeFile(path.join(input, "app-update-broker.ps1"), "fixture\n");
    await writeFile(path.join(input, "TarkovHelper.ico"), "fixture\n");
    await buildWindowsLauncher({ output: path.join(input, "Tarkov Helper.exe"), version: "1.2.3" });
    await writeFile(path.join(input, "start-menu.ps1"), "fixture\n");
    await writeFile(path.join(input, "Tarkov Helper 실행.vbs"), "fixture\n");
    await writeFile(path.join(input, "Tarkov Helper 시작 메뉴 등록.vbs"), "fixture\n");
    await writeFile(path.join(input, "Tarkov Helper 시작 메뉴 제거.vbs"), "fixture\n");
    await writeFile(path.join(input, "Tarkov Helper 종료.vbs"), "fixture\n");
    await writeFile(path.join(input, "문제 해결용 실행.cmd"), "fixture\n");
    await writeFile(path.join(input, "Tarkov Helper 상태 복구.cmd"), "fixture\n");
    await writeFile(path.join(input, "Tarkov Helper 격리 복구 실행.cmd"), "fixture\n");
    await writeFile(path.join(input, "사용 안내.txt"), "fixture\n");
    await writeFile(path.join(input, "PACKAGE_INFO.txt"), "fixture\n");
    await writeFile(path.join(input, "UPDATE_CONFIG.json"), "{}\n");
    await writeFile(path.join(input, "app", "version.json"), "{}\n");
    const writeInputArchive = async () => {
      const files = (await collectFiles(input)).filter((file) => file.path !== "SHA256SUMS.txt");
      await writeFile(path.join(input, "SHA256SUMS.txt"), checksumText(files));
      await createZipFromDirectory({ directory: input, filename: archive, rootDirectory });
    };
    await writeInputArchive();
    const expectedFiles = await collectFiles(input);
    const expectedAppFiles = expectedFiles
      .filter((file) => file.path.startsWith("app/"))
      .map((file) => ({ ...file, path: file.path.slice("app/".length) }));
    await writeFile(sourceFile, isolatedZipValidatorSource(workflow));
    await writeFile(harness, [
      "param([string]$Source, [string]$Archive, [string]$Root, [string]$Mode = 'direct')",
      "$ErrorActionPreference = 'Stop'",
      "try {",
      "  Add-Type -AssemblyName System.IO.Compression",
      "  $references = @([IO.Compression.ZipArchive].Assembly.Location)",
      "  Add-Type -Path $Source -ReferencedAssemblies $references",
      "  $strictDirect = [string]::Equals($Mode, 'direct', [StringComparison]::Ordinal)",
      "  $captures = if ($strictDirect) { [string[]]@('SHA256SUMS.txt', 'PACKAGE_INFO.txt', 'UPDATE_CONFIG.json', 'app/version.json', 'Tarkov Helper.exe') } else { [string[]]@() }",
      "  $report = [IsolatedZipValidator]::Validate($Archive, $Root, $captures, $strictDirect)",
      "  if ($strictDirect) { [IsolatedZipValidator]::ValidateLauncher($report.Captured['Tarkov Helper.exe'], '1.2.3') }",
      "  [pscustomobject]@{ fileCount = $report.FileCount; bytes = $report.Bytes; treeSha256 = $report.TreeSha256; appFileCount = $report.AppFileCount; appBytes = $report.AppBytes; appTreeSha256 = $report.AppTreeSha256 } | ConvertTo-Json -Compress",
      "} catch {",
      "  [Console]::Error.WriteLine($_.Exception.Message)",
      "  exit 1",
      "}",
      "",
    ].join("\n"));

    const validate = ({ archivePath = archive, mode = "direct", root = rootDirectory } = {}) => spawnSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", harness, "-Source", sourceFile, "-Archive", archivePath, "-Root", root, "-Mode", mode,
    ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });

    const valid = validate();
    assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
    const report = JSON.parse(valid.stdout);
    assert.equal(report.fileCount, expectedFiles.length);
    assert.equal(report.appFileCount, 2);
    assert.equal(report.bytes, expectedFiles.reduce((total, file) => total + file.size, 0));
    assert.equal(report.appBytes, expectedAppFiles.reduce((total, file) => total + file.size, 0));
    assert.equal(report.treeSha256, sha256(checksumText(expectedFiles)));
    assert.equal(report.appTreeSha256, sha256(checksumText(expectedAppFiles)));

    const launcherPath = path.join(input, "Tarkov Helper.exe");
    const validLauncher = await readFile(launcherPath);
    await writeFile(launcherPath, Buffer.alloc(128, 0x41));
    await writeInputArchive();
    const rejectedInvalidLauncher = validate();
    assert.notEqual(rejectedInvalidLauncher.status, 0);
    assert.match(rejectedInvalidLauncher.stderr, /launcher.*MZ header/i);

    await writeFile(launcherPath, validLauncher);
    const wrongVersionLauncher = path.join(parent, "wrong-version-launcher.exe");
    await buildWindowsLauncher({ output: wrongVersionLauncher, version: "9.8.7" });
    await copyFile(wrongVersionLauncher, launcherPath);
    await writeInputArchive();
    const rejectedWrongVersion = validate();
    assert.notEqual(rejectedWrongVersion.status, 0);
    assert.match(rejectedWrongVersion.stderr, /launcher version mismatch/i);

    const invalidManifest = Buffer.from(validLauncher);
    const asInvoker = invalidManifest.indexOf(Buffer.from("asInvoker", "utf8"));
    assert.notEqual(asInvoker, -1);
    Buffer.from("highestAv", "utf8").copy(invalidManifest, asInvoker);
    await writeFile(launcherPath, invalidManifest);
    await writeInputArchive();
    const rejectedManifest = validate();
    assert.notEqual(rejectedManifest.status, 0);
    assert.match(rejectedManifest.stderr, /asInvoker.*uiAccess/i);

    await writeFile(launcherPath, validLauncher);
    await writeInputArchive();

    const unsafe = Buffer.from(await readFile(archive));
    const central = unsafe.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.notEqual(central, -1);
    unsafe.writeUInt32LE((0o010644 << 16) >>> 0, central + 38);
    await writeFile(archive, unsafe);
    const rejectedUnsafe = validate();
    assert.notEqual(rejectedUnsafe.status, 0);
    assert.match(rejectedUnsafe.stderr, /external attributes|non-regular ZIP entry/i);

    await createZipFromDirectory({ directory: input, filename: archive, rootDirectory });
    const badFlags = Buffer.from(await readFile(archive));
    const flagsCentral = badFlags.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const flagsLocal = badFlags.readUInt32LE(flagsCentral + 42);
    badFlags.writeUInt16LE(0, flagsCentral + 8);
    badFlags.writeUInt16LE(0, flagsLocal + 6);
    await writeFile(archive, badFlags);
    const rejectedFlags = validate();
    assert.notEqual(rejectedFlags.status, 0);
    assert.match(rejectedFlags.stderr, /Direct ZIP flags/i);

    await createZipFromDirectory({ directory: input, filename: archive, rootDirectory });
    const explicitDirectory = Buffer.from(await readFile(archive));
    const directoryCentral = explicitDirectory.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const directoryLocal = explicitDirectory.readUInt32LE(directoryCentral + 42);
    const directoryNameLength = explicitDirectory.readUInt16LE(directoryCentral + 28);
    explicitDirectory[directoryCentral + 46 + directoryNameLength - 1] = 0x2f;
    explicitDirectory[directoryLocal + 30 + directoryNameLength - 1] = 0x2f;
    await writeFile(archive, explicitDirectory);
    const rejectedDirectory = validate();
    assert.notEqual(rejectedDirectory.status, 0);
    assert.match(rejectedDirectory.stderr, /Explicit directory entries/i);

    await createZipFromDirectory({ directory: input, filename: archive, rootDirectory });
    const contiguous = Buffer.from(await readFile(archive));
    const centralOffset = contiguous.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const withGap = Buffer.concat([
      contiguous.subarray(0, centralOffset),
      Buffer.from([0]),
      contiguous.subarray(centralOffset),
    ]);
    const endOffset = withGap.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    withGap.writeUInt32LE(centralOffset + 1, endOffset + 16);
    await writeFile(archive, withGap);
    const rejectedGap = validate();
    assert.notEqual(rejectedGap.status, 0);
    assert.match(rejectedGap.stderr, /not contiguous/i);

    await writeFile(path.join(input, "app", "index.html"), "changed without refreshing internal sums\n");
    await createZipFromDirectory({ directory: input, filename: archive, rootDirectory });
    const rejectedStaleSums = validate();
    assert.notEqual(rejectedStaleSums.status, 0);
    assert.match(rejectedStaleSums.stderr, /internal checksum mismatch/i);

    await writeFile(path.join(input, "app", "index.html"), "fixture\n");
    await rm(path.join(input, "launcher.ps1"));
    await rm(path.join(input, "SHA256SUMS.txt"));
    await writeFile(path.join(input, "SHA256SUMS.txt"), checksumText(await collectFiles(input)));
    await createZipFromDirectory({ directory: input, filename: archive, rootDirectory });
    const rejectedMissingRequired = validate();
    assert.notEqual(rejectedMissingRequired.status, 0);
    assert.match(rejectedMissingRequired.stderr, /Required Direct ZIP entry is missing: launcher\.ps1/i);

    const emptyArchive = path.join(parent, "empty.zip");
    const emptyEnd = Buffer.alloc(22);
    emptyEnd.writeUInt32LE(0x06054b50, 0);
    await writeFile(emptyArchive, emptyEnd);
    const rejectedEmpty = validate({
      archivePath: emptyArchive,
      mode: "static",
      root: "tarkov-helper-web-static-v1.2.3",
    });
    assert.notEqual(rejectedEmpty.status, 0);
    assert.match(rejectedEmpty.stderr, /client unpacked bounds/i);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("package scripts expose release tests, local updater-disabled bundles, and verification", async () => {
  const packageJson = JSON.parse(await text("package.json"));
  assert.equal(
    packageJson.scripts["test:release"],
    "node --test tests/release/assert-release-version.node.mjs tests/release/archive-security.node.mjs tests/release/bundle.node.mjs tests/release/workflows.node.mjs",
  );
  assert.match(packageJson.scripts["release:bundle:local"], /create-release-bundle\.mjs/);
  assert.match(packageJson.scripts["release:bundle:local"], /--updater-disabled/);
  assert.match(packageJson.scripts["release:verify"], /verify-release-bundle\.mjs/);
});
