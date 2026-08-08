import { execFileSync, spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertReleaseContext,
  checksumText,
  collectFiles,
  createZipFromDirectory,
  fileRecord,
  gitText,
  loadReleaseConfig,
  loadPublicSigningKey,
  loadSigningKeyPair,
  parsePackageInfo,
  readZipArchive,
  requireRegularFile,
  sha256,
  signManifest,
} from "./release-utils.mjs";
import { verifyReleaseBundle } from "./verify-release-bundle.mjs";

function parseArguments(argv) {
  const values = {};
  const valueOptions = new Map([
    ["--project-root", "projectRoot"],
    ["--config", "config"],
    ["--direct", "direct"],
    ["--static", "staticDirectory"],
    ["--output", "output"],
    ["--tag", "tag"],
    ["--commit", "commit"],
    ["--repository", "repository"],
    ["--prepared", "prepared"],
    ["--release-id", "releaseId"],
    ["--direct-asset-id", "directAssetId"],
    ["--static-asset-id", "staticAssetId"],
    ["--source-asset-id", "sourceAssetId"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--updater-disabled" || argument === "--prepare-only") {
      const key = argument === "--updater-disabled" ? "updaterDisabled" : "prepareOnly";
      if (values[key]) throw new Error(`Duplicate argument: ${argument}`);
      values[key] = true;
      continue;
    }
    const key = valueOptions.get(argument);
    const value = argv[index + 1];
    if (!key || !value || value.startsWith("--")) throw new Error(`Unknown or incomplete argument: ${argument}`);
    if (values[key] !== undefined) throw new Error(`Duplicate argument: ${argument}`);
    values[key] = value;
    index += 1;
  }
  if (!values.output) throw new Error("--output is required");
  if (values.updaterDisabled && values.repository) throw new Error("--repository cannot be combined with --updater-disabled");
  if (values.prepareOnly && values.updaterDisabled) throw new Error("--prepare-only cannot be combined with --updater-disabled");
  if (values.prepared && (values.prepareOnly || values.direct || values.staticDirectory || values.updaterDisabled)) {
    throw new Error("--prepared cannot be combined with direct/static/prepare/local options");
  }
  return values;
}

function positiveId(value, argument) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw new Error(`${argument} is required and must be a positive integer`);
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new Error(`${argument} exceeds the safe integer range`);
  return id;
}

function releaseIdentity(options) {
  const ids = {
    release: positiveId(options.releaseId, "--release-id"),
    direct: positiveId(options.directAssetId, "--direct-asset-id"),
    static: positiveId(options.staticAssetId, "--static-asset-id"),
    source: positiveId(options.sourceAssetId, "--source-asset-id"),
  };
  if (new Set([ids.direct, ids.static, ids.source]).size !== 3) {
    throw new Error("Direct, static, and source asset IDs must be distinct");
  }
  return ids;
}

function pathsOverlap(left, right) {
  const leftToRight = path.relative(left, right);
  const rightToLeft = path.relative(right, left);
  const contains = (relative) => relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  return contains(leftToRight) || contains(rightToLeft);
}

function assertSafeOutput(output, protectedPaths) {
  const filesystemRoot = path.parse(output).root;
  if (output === filesystemRoot) throw new Error(`Unsafe output directory: ${output}`);
  for (const protectedPath of protectedPaths) {
    if (pathsOverlap(output, protectedPath)) throw new Error(`Output directory overlaps release input: ${output}`);
  }
}

async function ensureMissing(directory) {
  try {
    await access(directory);
    throw new Error(`Output directory already exists: ${directory}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function createDirectInput(scriptRoot, projectRoot) {
  if (projectRoot !== scriptRoot) throw new Error("--direct is required when --project-root is not the release script repository");
  const temporaryParent = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-direct-release-"));
  const direct = path.join(temporaryParent, "Tarkov Helper 바로 실행");
  const result = spawnSync(process.execPath, [path.join(scriptRoot, "scripts", "create-direct-release.mjs"), "--output", direct], {
    cwd: scriptRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    await rm(temporaryParent, { recursive: true, force: true });
    throw new Error(`Direct release creation failed:\n${result.stdout}\n${result.stderr}`);
  }
  return { direct, temporaryParent };
}

async function prepareDirectInput({ config, context, direct, projectRoot, signing, updaterEnabled }) {
  const temporaryParent = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-release-stage-"));
  const staged = path.join(temporaryParent, "direct");
  try {
    await cp(direct, staged, { recursive: true, errorOnExist: true });
    for (const filename of ["app-update-worker.ps1", "app-update-broker.ps1"]) {
      const source = path.join(projectRoot, "portable", filename);
      await requireRegularFile(source);
      await cp(source, path.join(staged, filename), { force: true });
    }
    const updateConfig = updaterEnabled
      ? {
          schemaVersion: 1,
          updaterEnabled: true,
          protocolVersion: config.updater.protocolVersion,
          repository: context.repository,
          releaseApi: `https://api.github.com/repos/${context.repository}/releases/latest`,
          manifestAsset: config.updater.manifestAsset,
          signatureAsset: config.updater.signatureAsset,
          requireImmutableRelease: config.updater.requireImmutableRelease,
          signing: {
            algorithm: config.updater.signing.algorithm,
            keyId: signing.keyId,
            publicKeySpkiPem: signing.publicKeySpkiPem,
          },
        }
      : {
          schemaVersion: 1,
          updaterEnabled: false,
          protocolVersion: config.updater.protocolVersion,
        };
    await writeFile(path.join(staged, config.updater.configFile), `${JSON.stringify(updateConfig, null, 2)}\n`, "utf8");
    const versionDocument = {
      schemaVersion: 1,
      product: config.product,
      version: context.version,
      commit: context.commit,
      updaterProtocolVersion: config.updater.protocolVersion,
    };
    await writeFile(path.join(staged, "app", "version.json"), `${JSON.stringify(versionDocument, null, 2)}\n`, "utf8");

    const appFiles = await collectFiles(path.join(staged, "app"));
    const appManifest = checksumText(appFiles);
    const appBytes = appFiles.reduce((total, file) => total + file.size, 0);
    const packageInfo = [
      "Tarkov Helper Web Direct Release",
      `Version: ${context.version}`,
      `Source commit: ${context.commit}`,
      `Updater protocol: ${config.updater.protocolVersion}`,
      `App files: ${appFiles.length}`,
      `App bytes: ${appBytes}`,
      `App tree SHA-256: ${sha256(appManifest)}`,
      "Local URL: http://127.0.0.1:41753/",
      "",
    ].join("\n");
    await writeFile(path.join(staged, "PACKAGE_INFO.txt"), packageInfo, "utf8");
    await rm(path.join(staged, "SHA256SUMS.txt"), { force: true });
    await writeFile(path.join(staged, "SHA256SUMS.txt"), checksumText(await collectFiles(staged)), "utf8");
    return { staged, temporaryParent };
  } catch (error) {
    await rm(temporaryParent, { recursive: true, force: true });
    throw error;
  }
}

async function sourceArchive({ commit, filename, projectRoot, rootDirectory }) {
  try {
    execFileSync("git", [
      "archive",
      "--format=zip",
      `--prefix=${rootDirectory}/`,
      `--output=${filename}`,
      commit,
    ], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error?.stderr?.trim?.() || error?.message || String(error);
    throw new Error(`Source archive creation failed: ${detail}`);
  }
}

function artifact(assetId, filename, rootDirectory, record, unpacked, extra = {}) {
  return {
    assetId,
    filename,
    format: "zip",
    bytes: record.size,
    sha256: record.sha256,
    rootDirectory,
    stripComponents: 1,
    unpacked,
    ...extra,
  };
}

function archiveUnpacked(archive, rootDirectory) {
  const prefix = `${rootDirectory}/`;
  const files = archive.entries
    .filter((entry) => !entry.directory && entry.path.startsWith(prefix))
    .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
  if (files.length === 0 || files.some((file) => !file.path)) throw new Error(`Archive root mismatch: ${rootDirectory}`);
  return {
    fileCount: files.length,
    bytes: files.reduce((total, file) => total + file.size, 0),
    treeSha256: sha256(checksumText(files)),
  };
}

function releaseLayout(config, version) {
  const versionSuffix = `v${version}`;
  return {
    filenames: {
      direct: `${config.product}-direct-${versionSuffix}.zip`,
      source: `${config.product}-source-${versionSuffix}.zip`,
      static: `${config.product}-static-${versionSuffix}.zip`,
    },
    roots: {
      direct: `${config.directRootName} ${versionSuffix}`,
      source: `${config.product}-source-${versionSuffix}`,
      static: `${config.product}-static-${versionSuffix}`,
    },
  };
}

function packageInfoFromArchive(archive, rootDirectory) {
  const expectedPath = `${rootDirectory}/PACKAGE_INFO.txt`;
  const entry = archive.entries.find((candidate) => !candidate.directory && candidate.path === expectedPath);
  if (!entry) throw new Error("Prepared Direct ZIP is missing PACKAGE_INFO.txt");
  return parsePackageInfo(entry.contents.toString("utf8"));
}

async function writeFinalMetadata({ config, context, filenames, output, releaseIds, roots, signing }) {
  const records = {};
  const archives = {};
  for (const kind of ["direct", "static", "source"]) {
    records[kind] = await fileRecord(path.join(output, filenames[kind]), filenames[kind]);
    archives[kind] = await readZipArchive(path.join(output, filenames[kind]));
  }
  const packageInfo = packageInfoFromArchive(archives.direct, roots.direct);
  const manifest = {
    schemaVersion: config.schemaVersion,
    product: config.product,
    channel: config.channel,
    repository: context.repository,
    version: context.version,
    tag: context.tag,
    commit: context.commit,
    createdAt: gitText(context.projectRoot, ["show", "-s", "--format=%cI", context.commit]),
    releaseId: releaseIds.release,
    updater: {
      protocolVersion: config.updater.protocolVersion,
      configFile: config.updater.configFile,
      manifestAsset: config.updater.manifestAsset,
      signatureAsset: config.updater.signatureAsset,
      requireImmutableRelease: config.updater.requireImmutableRelease,
      signing: {
        algorithm: config.updater.signing.algorithm,
        keyId: signing.keyId,
      },
    },
    artifacts: {
      direct: artifact(
        releaseIds.direct,
        filenames.direct,
        roots.direct,
        records.direct,
        archiveUnpacked(archives.direct, roots.direct),
        { package: packageInfo },
      ),
      static: artifact(
        releaseIds.static,
        filenames.static,
        roots.static,
        records.static,
        archiveUnpacked(archives.static, roots.static),
      ),
      source: artifact(
        releaseIds.source,
        filenames.source,
        roots.source,
        records.source,
        archiveUnpacked(archives.source, roots.source),
        { commit: context.commit },
      ),
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(output, config.updater.manifestAsset), manifestBytes);
  await writeFile(path.join(output, config.updater.signatureAsset), signManifest(manifestBytes, signing.privateKey));
  await writeFile(path.join(output, "SHA256SUMS.txt"), checksumText(await collectFiles(output)), "utf8");
}

async function finalizePreparedBundle({ config, configPath, context, filenames, options, releaseIds, roots, signing }) {
  const prepared = path.resolve(options.prepared);
  const output = path.resolve(options.output);
  assertSafeOutput(output, [context.projectRoot, prepared]);
  await verifyReleaseBundle({
    bundle: prepared,
    commit: context.commit,
    config: configPath,
    preparedOnly: true,
    projectRoot: context.projectRoot,
    repository: context.repository,
    tag: context.tag,
  });
  let outputCreated = false;
  try {
    await ensureMissing(output);
    await mkdir(path.dirname(output), { recursive: true });
    await mkdir(output);
    outputCreated = true;
    for (const filename of Object.values(filenames)) {
      await cp(path.join(prepared, filename), path.join(output, filename), { errorOnExist: true });
    }
    await writeFinalMetadata({ config, context, filenames, output, releaseIds, roots, signing });
    const verification = await verifyReleaseBundle({
      bundle: output,
      commit: context.commit,
      config: configPath,
      directAssetId: releaseIds.direct,
      projectRoot: context.projectRoot,
      releaseId: releaseIds.release,
      repository: context.repository,
      sourceAssetId: releaseIds.source,
      staticAssetId: releaseIds.static,
      tag: context.tag,
    });
    return { output, ...verification };
  } catch (error) {
    if (outputCreated) await rm(output, { recursive: true, force: true });
    throw error;
  }
}

export async function createReleaseBundle(options) {
  const scriptRoot = path.resolve(import.meta.dirname, "..");
  const projectRoot = path.resolve(options.projectRoot ?? scriptRoot);
  const configPath = path.resolve(options.config ?? path.join(scriptRoot, "release.config.example.json"));
  const config = await loadReleaseConfig(configPath);
  const updaterEnabled = !options.updaterDisabled;
  const context = await assertReleaseContext({
    commit: options.commit,
    projectRoot,
    repository: options.repository,
    requireRepository: updaterEnabled,
    tag: options.tag,
  });
  context.projectRoot = projectRoot;
  const signing = updaterEnabled
    ? options.prepareOnly
      ? loadPublicSigningKey(process.env.UPDATE_SIGNING_PUBLIC_KEY)
      : loadSigningKeyPair(process.env.UPDATE_SIGNING_PRIVATE_KEY, process.env.UPDATE_SIGNING_PUBLIC_KEY)
    : null;
  const releaseIds = updaterEnabled && !options.prepareOnly
    ? releaseIdentity(options)
    : null;
  const { filenames, roots } = releaseLayout(config, context.version);
  if (options.prepared) {
    return finalizePreparedBundle({ config, configPath, context, filenames, options, releaseIds, roots, signing });
  }

  let direct = options.direct ? path.resolve(options.direct) : null;
  let temporaryDirectParent = null;
  if (!direct) {
    const generated = await createDirectInput(scriptRoot, projectRoot);
    direct = generated.direct;
    temporaryDirectParent = generated.temporaryParent;
  }
  const staticDirectory = path.resolve(options.staticDirectory ?? path.join(projectRoot, "dist"));
  const output = path.resolve(options.output);
  let prepared = null;
  let outputCreated = false;
  try {
    assertSafeOutput(output, [projectRoot, direct, staticDirectory]);
    await requireRegularFile(path.join(direct, "PACKAGE_INFO.txt"));
    await requireRegularFile(path.join(direct, "SHA256SUMS.txt"));
    await requireRegularFile(path.join(staticDirectory, "index.html"));
    await requireRegularFile(path.join(staticDirectory, "data", "tarkov-data.json"));
    await requireRegularFile(path.join(staticDirectory, "LICENSE"));
    await requireRegularFile(path.join(staticDirectory, "THIRD_PARTY_NOTICES.md"));
    prepared = await prepareDirectInput({
      config,
      context,
      direct,
      projectRoot,
      signing,
      updaterEnabled,
    });
    await ensureMissing(output);
    await mkdir(path.dirname(output), { recursive: true });
    await mkdir(output);
    outputCreated = true;
    await createZipFromDirectory({ directory: prepared.staged, filename: path.join(output, filenames.direct), rootDirectory: roots.direct });
    await createZipFromDirectory({ directory: staticDirectory, filename: path.join(output, filenames.static), rootDirectory: roots.static });
    await sourceArchive({
      commit: context.commit,
      filename: path.join(output, filenames.source),
      projectRoot,
      rootDirectory: roots.source,
    });

    if (options.prepareOnly) {
      const verification = await verifyReleaseBundle({
        bundle: output,
        commit: context.commit,
        config: configPath,
        preparedOnly: true,
        projectRoot,
        repository: context.repository,
        tag: context.tag,
      });
      return { output, ...verification };
    }
    if (updaterEnabled) {
      await writeFinalMetadata({ config, context, filenames, output, releaseIds, roots, signing });
    } else {
      await writeFile(path.join(output, "SHA256SUMS.txt"), checksumText(await collectFiles(output)), "utf8");
    }
    const verification = await verifyReleaseBundle({
      bundle: output,
      commit: context.commit,
      config: configPath,
      projectRoot,
      repository: context.repository ?? undefined,
      releaseId: releaseIds?.release,
      directAssetId: releaseIds?.direct,
      staticAssetId: releaseIds?.static,
      sourceAssetId: releaseIds?.source,
      tag: context.tag,
      updaterDisabled: !updaterEnabled,
    });
    return { output, ...verification };
  } catch (error) {
    if (outputCreated) await rm(output, { recursive: true, force: true });
    throw error;
  } finally {
    if (prepared) await rm(prepared.temporaryParent, { recursive: true, force: true });
    if (temporaryDirectParent) await rm(temporaryDirectParent, { recursive: true, force: true });
  }
}

export async function runCreateReleaseBundle(argv = process.argv.slice(2)) {
  return createReleaseBundle(parseArguments(argv));
}

const isCommandLine = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCommandLine) {
  try {
    const result = await runCreateReleaseBundle();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Release bundle creation failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
