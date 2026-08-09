import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checksumText, collectFiles, createZipFromDirectory, sha256 } from "../../scripts/release-utils.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");

async function text(relativePath) {
  return readFile(path.join(projectRoot, relativePath), "utf8");
}

function actionReferences(workflow) {
  return [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map((match) => match[1]);
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
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s+read\s*$/m);
  assert.doesNotMatch(workflow, /contents:\s+write/);
  assert.doesNotMatch(workflow, /--headed|headless:\s*false|Start-Process/i);
  assert.match(workflow, /pnpm test:e2e/);
  assert.match(workflow, /pnpm test:release/);
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
    await writeFile(path.join(input, "PACKAGE_INFO.txt"), "fixture\n");
    await writeFile(path.join(input, "UPDATE_CONFIG.json"), "{}\n");
    await writeFile(path.join(input, "app", "version.json"), "{}\n");
    await writeFile(path.join(input, "SHA256SUMS.txt"), checksumText(await collectFiles(input)));
    const expectedFiles = await collectFiles(input);
    const expectedAppFiles = expectedFiles
      .filter((file) => file.path.startsWith("app/"))
      .map((file) => ({ ...file, path: file.path.slice("app/".length) }));
    await createZipFromDirectory({ directory: input, filename: archive, rootDirectory });
    await writeFile(sourceFile, isolatedZipValidatorSource(workflow));
    await writeFile(harness, [
      "param([string]$Source, [string]$Archive, [string]$Root, [string]$Mode = 'direct')",
      "$ErrorActionPreference = 'Stop'",
      "try {",
      "  Add-Type -AssemblyName System.IO.Compression",
      "  $references = @([IO.Compression.ZipArchive].Assembly.Location)",
      "  Add-Type -Path $Source -ReferencedAssemblies $references",
      "  $strictDirect = [string]::Equals($Mode, 'direct', [StringComparison]::Ordinal)",
      "  $captures = if ($strictDirect) { [string[]]@('SHA256SUMS.txt', 'PACKAGE_INFO.txt', 'UPDATE_CONFIG.json', 'app/version.json') } else { [string[]]@() }",
      "  $report = [IsolatedZipValidator]::Validate($Archive, $Root, $captures, $strictDirect)",
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
    assert.equal(report.fileCount, 8);
    assert.equal(report.appFileCount, 2);
    assert.equal(report.bytes, expectedFiles.reduce((total, file) => total + file.size, 0));
    assert.equal(report.appBytes, expectedAppFiles.reduce((total, file) => total + file.size, 0));
    assert.equal(report.treeSha256, sha256(checksumText(expectedFiles)));
    assert.equal(report.appTreeSha256, sha256(checksumText(expectedAppFiles)));

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
