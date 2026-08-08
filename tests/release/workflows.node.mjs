import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");

async function text(relativePath) {
  return readFile(path.join(projectRoot, relativePath), "utf8");
}

function actionReferences(workflow) {
  return [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map((match) => match[1]);
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

test("release identity comes from GitHub context and publish has only required permissions", async () => {
  const workflow = await text(".github/workflows/release.yml");
  const packageJob = /\n\x20{2}package:\n([\s\S]*?)\n\x20{2}publish:\n/.exec(workflow)?.[1] ?? "";
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
  assert.match(workflow, /publish:[\s\S]*?environment:\s+github-release/);
  assert.match(workflow, /publish:[\s\S]*?--prepared/);
  assert.match(workflow, /concurrency:\s*\n\s+group:\s+stable-release/);
  assert.doesNotMatch(packageJob, /UPDATE_SIGNING_PRIVATE_KEY|SIGNING_KEY_PEM/);
  assert.doesNotMatch(publishJob, /pnpm install|pnpm build|create-direct-release\.mjs/);
  assert.match(publishJob, /verify-release-bundle\.mjs[\s\S]*--release-id[\s\S]*--direct-asset-id[\s\S]*--static-asset-id[\s\S]*--source-asset-id/);
  assert.match(publishJob, /releases\/\$releaseId/);
  assert.match(publishJob, /StringComparison\]::Ordinal/);
  assert.match(publishJob, /equal or newer version already exists/);
  assert.doesNotMatch(publishJob, /gh release edit/);
  const privateKeyReferences = [...workflow.matchAll(/UPDATE_SIGNING_PRIVATE_KEY/g)];
  assert.equal(privateKeyReferences.length, 1, "the private key must be exposed only to the fresh finalization step");
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
