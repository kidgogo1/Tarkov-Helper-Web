import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { lstat, readdir } from "node:fs/promises";
import {
  assertReleaseContext,
  checksumText,
  DEFAULT_ZIP_LIMITS,
  fileRecord,
  gitText,
  loadReleaseConfig,
  loadPublicSigningKey,
  parseChecksumText,
  parsePackageInfo,
  parseStrictJson,
  readFileBounded,
  readZipArchive,
  requireRegularFile,
  sha256,
  verifyManifestSignature,
} from "./release-utils.mjs";

const MAX_RELEASE_METADATA_BYTES = 16 * 1024 * 1024;

async function collectBundleFiles(directory) {
  const root = await lstat(directory).catch(() => null);
  if (!root?.isDirectory() || root.isSymbolicLink()) throw new Error(`Release bundle directory is missing: ${directory}`);
  const entries = await readdir(directory, { withFileTypes: true });
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Release bundle contains a non-file entry: ${entry.name}`);
    const maxBytes = entry.name.endsWith(".zip") ? DEFAULT_ZIP_LIMITS.maxArchiveBytes : MAX_RELEASE_METADATA_BYTES;
    records.push(await fileRecord(path.join(directory, entry.name), entry.name, { maxBytes }));
  }
  return records;
}

function parseArguments(argv) {
  const values = {};
  const valueOptions = new Map([
    ["--project-root", "projectRoot"],
    ["--config", "config"],
    ["--bundle", "bundle"],
    ["--tag", "tag"],
    ["--commit", "commit"],
    ["--repository", "repository"],
    ["--release-id", "releaseId"],
    ["--direct-asset-id", "directAssetId"],
    ["--static-asset-id", "staticAssetId"],
    ["--source-asset-id", "sourceAssetId"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--updater-disabled" || argument === "--prepared-only") {
      const key = argument === "--updater-disabled" ? "updaterDisabled" : "preparedOnly";
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
  if (!values.bundle) throw new Error("--bundle is required");
  if (values.updaterDisabled && values.repository) throw new Error("--repository cannot be combined with --updater-disabled");
  if (values.updaterDisabled && values.preparedOnly) throw new Error("--prepared-only cannot be combined with --updater-disabled");
  return values;
}

function positiveId(value, argument) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9]\d*$/.test(text)) throw new Error(`${argument} is required and must be a positive integer`);
  const id = Number(text);
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

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} keys do not match the release contract`);
  }
}

function compareRecordSets(expected, actual, label) {
  const expectedMap = new Map(expected.map((record) => [record.path, record]));
  const actualMap = new Map(actual.map((record) => [record.path, record]));
  if (expectedMap.size !== actualMap.size) throw new Error(`${label} file count mismatch`);
  for (const [recordPath, expectedRecord] of expectedMap) {
    const actualRecord = actualMap.get(recordPath);
    if (!actualRecord) throw new Error(`${label} is missing ${recordPath}`);
    if (actualRecord.size !== expectedRecord.size) throw new Error(`Size mismatch for ${recordPath}`);
    if (actualRecord.sha256 !== expectedRecord.sha256) throw new Error(`SHA-256 mismatch for ${recordPath}`);
  }
}

function archiveFiles(archive, rootDirectory, label) {
  const rootPrefix = `${rootDirectory}/`;
  const records = [];
  for (const entry of archive.entries) {
    if (entry.path === rootPrefix && entry.directory) continue;
    if (!entry.path.startsWith(rootPrefix)) throw new Error(`${label} contains a path outside ${rootDirectory}`);
    const relative = entry.path.slice(rootPrefix.length);
    if (!relative) throw new Error(`${label} contains an empty relative path`);
    if (!entry.directory) records.push({ ...entry, path: relative });
  }
  if (records.length === 0) throw new Error(`${label} has no files`);
  return records;
}

function requireArchiveFile(files, filename, label) {
  const record = files.find((file) => file.path === filename);
  if (!record) throw new Error(`${label} is missing ${filename}`);
  return record;
}

function unpackedMetadata(files) {
  return {
    fileCount: files.length,
    bytes: files.reduce((total, file) => total + file.size, 0),
    treeSha256: sha256(checksumText(files)),
  };
}

function verifyDirectArchive(archive, rootDirectory, context, config, signing, updaterEnabled) {
  const files = archiveFiles(archive, rootDirectory, "Direct archive");
  const sumsFile = requireArchiveFile(files, "SHA256SUMS.txt", "Direct archive");
  const expected = parseChecksumText(sumsFile.contents.toString("utf8"), "Direct SHA256SUMS.txt");
  const actual = files.filter((file) => file.path !== "SHA256SUMS.txt");
  compareRecordSets(expected, actual, "Direct archive");

  const packageFile = requireArchiveFile(files, "PACKAGE_INFO.txt", "Direct archive");
  const packageInfo = parsePackageInfo(packageFile.contents.toString("utf8"));
  if (packageInfo.sourceCommit !== context.commit) throw new Error("Direct PACKAGE_INFO source commit mismatch");
  if (packageInfo.version !== context.version) throw new Error("Direct PACKAGE_INFO version mismatch");
  if (packageInfo.updaterProtocolVersion !== config.updater.protocolVersion) throw new Error("Direct PACKAGE_INFO updater protocol mismatch");
  const appFiles = files
    .filter((file) => file.path.startsWith("app/"))
    .map((file) => ({ ...file, path: file.path.slice("app/".length) }));
  const appBytes = appFiles.reduce((total, file) => total + file.size, 0);
  const appTreeSha256 = sha256(checksumText(appFiles));
  if (packageInfo.appFiles !== appFiles.length) throw new Error("Direct PACKAGE_INFO app file count mismatch");
  if (packageInfo.appBytes !== appBytes) throw new Error("Direct PACKAGE_INFO app byte count mismatch");
  if (packageInfo.appTreeSha256 !== appTreeSha256) throw new Error("Direct PACKAGE_INFO app tree SHA-256 mismatch");
  for (const filename of [config.updater.configFile, "app/version.json", "app-update-worker.ps1", "app-update-broker.ps1"]) {
    requireArchiveFile(files, filename, "Direct archive");
  }
  const versionDocument = parseStrictJson(
    requireArchiveFile(files, "app/version.json", "Direct archive").contents.toString("utf8"),
    "app/version.json",
  );
  exactKeys(versionDocument, ["schemaVersion", "product", "version", "commit", "updaterProtocolVersion"], "app/version.json");
  const expectedVersion = {
    schemaVersion: 1,
    product: config.product,
    version: context.version,
    commit: context.commit,
    updaterProtocolVersion: config.updater.protocolVersion,
  };
  if (JSON.stringify(versionDocument) !== JSON.stringify(expectedVersion)) throw new Error("app/version.json release identity mismatch");

  const updateConfig = parseStrictJson(
    requireArchiveFile(files, config.updater.configFile, "Direct archive").contents.toString("utf8"),
    config.updater.configFile,
  );
  if (updaterEnabled) {
    exactKeys(updateConfig, [
      "schemaVersion",
      "updaterEnabled",
      "protocolVersion",
      "repository",
      "releaseApi",
      "manifestAsset",
      "signatureAsset",
      "requireImmutableRelease",
      "signing",
    ], config.updater.configFile);
    exactKeys(updateConfig.signing, ["algorithm", "keyId", "publicKeySpkiPem"], `${config.updater.configFile} signing`);
    const expectedUpdateConfig = {
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
    };
    if (JSON.stringify(updateConfig) !== JSON.stringify(expectedUpdateConfig)) throw new Error(`${config.updater.configFile} trust root mismatch`);
  } else {
    exactKeys(updateConfig, ["schemaVersion", "updaterEnabled", "protocolVersion"], config.updater.configFile);
    const expectedDisabled = { schemaVersion: 1, updaterEnabled: false, protocolVersion: config.updater.protocolVersion };
    if (JSON.stringify(updateConfig) !== JSON.stringify(expectedDisabled)) throw new Error(`${config.updater.configFile} disabled contract mismatch`);
  }
  return { entryCount: files.length, packageInfo, unpacked: unpackedMetadata(files) };
}

function verifyStaticArchive(archive, rootDirectory) {
  const files = archiveFiles(archive, rootDirectory, "Static archive");
  for (const required of ["index.html", "data/tarkov-data.json", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    requireArchiveFile(files, required, "Static archive");
  }
  return { entryCount: files.length, unpacked: unpackedMetadata(files) };
}

function verifySourceArchive(archive, rootDirectory, commit) {
  const files = archiveFiles(archive, rootDirectory, "Source archive");
  requireArchiveFile(files, "package.json", "Source archive");
  if (archive.comment.trim() !== commit) throw new Error("Source archive commit provenance mismatch");
  return { commit, entryCount: files.length, unpacked: unpackedMetadata(files) };
}

function assertArtifact(artifact, expected, archive, label) {
  exactKeys(artifact, expected.keys, `${label} artifact`);
  if (artifact.filename !== expected.filename) throw new Error(`${label} artifact filename mismatch`);
  if (artifact.format !== "zip") throw new Error(`${label} artifact format mismatch`);
  if (artifact.rootDirectory !== expected.rootDirectory) throw new Error(`${label} artifact root directory mismatch`);
  if (artifact.stripComponents !== 1) throw new Error(`${label} artifact stripComponents mismatch`);
  if (artifact.bytes !== archive.size) throw new Error(`${label} artifact byte count mismatch`);
  if (artifact.sha256 !== archive.sha256) throw new Error(`${label} artifact SHA-256 mismatch`);
  if (artifact.assetId !== expected.assetId) throw new Error(`${label} artifact assetId mismatch`);
  exactKeys(artifact.unpacked, ["fileCount", "bytes", "treeSha256"], `${label} unpacked metadata`);
  if (JSON.stringify(artifact.unpacked) !== JSON.stringify(expected.unpacked)) throw new Error(`${label} unpacked metadata mismatch`);
}

export async function verifyReleaseBundle(options) {
  const scriptRoot = path.resolve(import.meta.dirname, "..");
  const projectRoot = path.resolve(options.projectRoot ?? scriptRoot);
  const configPath = path.resolve(options.config ?? path.join(scriptRoot, "release.config.example.json"));
  const config = await loadReleaseConfig(configPath);
  const updaterEnabled = !options.updaterDisabled;
  const preparedOnly = Boolean(options.preparedOnly);
  const context = await assertReleaseContext({
    commit: options.commit,
    projectRoot,
    repository: options.repository,
    requireRepository: updaterEnabled,
    tag: options.tag,
  });
  const signing = updaterEnabled ? loadPublicSigningKey(process.env.UPDATE_SIGNING_PUBLIC_KEY) : null;
  const releaseIds = updaterEnabled && !preparedOnly
    ? releaseIdentity(options)
    : null;
  const bundle = path.resolve(options.bundle);
  const versionSuffix = `v${context.version}`;
  const filenames = {
    direct: `${config.product}-direct-${versionSuffix}.zip`,
    source: `${config.product}-source-${versionSuffix}.zip`,
    static: `${config.product}-static-${versionSuffix}.zip`,
  };
  const roots = {
    direct: `${config.directRootName} ${versionSuffix}`,
    source: `${config.product}-source-${versionSuffix}`,
    static: `${config.product}-static-${versionSuffix}`,
  };
  const expectedNames = [...Object.values(filenames)];
  if (!preparedOnly) expectedNames.push("SHA256SUMS.txt");
  if (updaterEnabled && !preparedOnly) expectedNames.push(config.updater.manifestAsset, config.updater.signatureAsset);
  expectedNames.sort();

  const bundleFiles = await collectBundleFiles(bundle);
  const actualNames = bundleFiles.map((file) => file.path).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`Release bundle file set mismatch. Expected ${expectedNames.join(", ")}; received ${actualNames.join(", ")}`);
  }
  if (!preparedOnly) {
    await requireRegularFile(path.join(bundle, "SHA256SUMS.txt"));
    const sumsText = (await readFileBounded(path.join(bundle, "SHA256SUMS.txt"), MAX_RELEASE_METADATA_BYTES, "SHA256SUMS.txt")).toString("utf8");
    const sumRecords = parseChecksumText(sumsText);
    const outerActual = bundleFiles.filter((file) => file.path !== "SHA256SUMS.txt");
    compareRecordSets(sumRecords, outerActual, "Release bundle");
  }

  const archives = {};
  const directContents = new Set([
    `${roots.direct}/SHA256SUMS.txt`,
    `${roots.direct}/PACKAGE_INFO.txt`,
    `${roots.direct}/app/version.json`,
    `${roots.direct}/${config.updater.configFile}`,
  ]);
  for (const kind of ["direct", "static", "source"]) {
    archives[kind] = await readZipArchive(path.join(bundle, filenames[kind]), {}, {
      retainContents: (entryPath) => kind === "direct" && directContents.has(entryPath),
    });
  }
  const direct = verifyDirectArchive(archives.direct, roots.direct, context, config, signing, updaterEnabled);
  const staticArchive = verifyStaticArchive(archives.static, roots.static);
  const source = verifySourceArchive(archives.source, roots.source, context.commit);

  if (preparedOnly) {
    return {
      valid: true,
      version: context.version,
      tag: context.tag,
      commit: context.commit,
      repository: context.repository,
      updaterEnabled: true,
      preparedOnly: true,
      archives: {
        direct: { entryCount: direct.entryCount, forwardSlashPaths: true, rootDirectory: roots.direct },
        source: { commit: source.commit, entryCount: source.entryCount, forwardSlashPaths: true, rootDirectory: roots.source },
        static: { entryCount: staticArchive.entryCount, forwardSlashPaths: true, rootDirectory: roots.static },
      },
    };
  }

  if (updaterEnabled) {
    const manifestPath = path.join(bundle, config.updater.manifestAsset);
    const manifestBytes = await readFileBounded(manifestPath, MAX_RELEASE_METADATA_BYTES, "Update manifest");
    const signature = await readFileBounded(path.join(bundle, config.updater.signatureAsset), MAX_RELEASE_METADATA_BYTES, "Update signature");
    if (!verifyManifestSignature(manifestBytes, signature, signing.publicKey)) {
      throw new Error("Update manifest RSA-SHA256 signature is invalid");
    }
    const manifestText = manifestBytes.toString("utf8");
    if (!manifestText.endsWith("\n")) throw new Error("Update manifest must end with a newline");
    const manifest = parseStrictJson(manifestText, "Update manifest");
    exactKeys(manifest, ["schemaVersion", "product", "channel", "repository", "version", "tag", "commit", "createdAt", "releaseId", "updater", "artifacts"], "Update manifest");
    if (manifest.schemaVersion !== config.schemaVersion || manifest.product !== config.product || manifest.channel !== config.channel) {
      throw new Error("Update manifest product contract mismatch");
    }
    if (manifest.repository !== context.repository || manifest.version !== context.version || manifest.tag !== context.tag || manifest.commit !== context.commit) {
      throw new Error("Update manifest release identity mismatch");
    }
    const createdAt = gitText(projectRoot, ["show", "-s", "--format=%cI", context.commit]);
    if (manifest.createdAt !== createdAt) throw new Error("Update manifest createdAt must equal the commit timestamp");
    if (manifest.releaseId !== releaseIds.release) throw new Error("Update manifest releaseId mismatch");
    exactKeys(manifest.updater, ["protocolVersion", "configFile", "manifestAsset", "signatureAsset", "requireImmutableRelease", "signing"], "Update manifest updater");
    exactKeys(manifest.updater.signing, ["algorithm", "keyId"], "Update manifest signing");
    const expectedUpdater = {
      protocolVersion: config.updater.protocolVersion,
      configFile: config.updater.configFile,
      manifestAsset: config.updater.manifestAsset,
      signatureAsset: config.updater.signatureAsset,
      requireImmutableRelease: config.updater.requireImmutableRelease,
      signing: {
        algorithm: config.updater.signing.algorithm,
        keyId: signing.keyId,
      },
    };
    if (JSON.stringify(manifest.updater) !== JSON.stringify(expectedUpdater)) throw new Error("Update manifest updater contract mismatch");
    exactKeys(manifest.artifacts, ["direct", "static", "source"], "Update manifest artifacts");
    assertArtifact(manifest.artifacts.direct, {
      assetId: releaseIds.direct,
      filename: filenames.direct,
      keys: ["assetId", "filename", "format", "bytes", "sha256", "rootDirectory", "stripComponents", "unpacked", "package"],
      rootDirectory: roots.direct,
      unpacked: direct.unpacked,
    }, archives.direct, "Direct");
    exactKeys(manifest.artifacts.direct.package, ["version", "sourceCommit", "updaterProtocolVersion", "appFiles", "appBytes", "appTreeSha256"], "Direct package metadata");
    if (JSON.stringify(manifest.artifacts.direct.package) !== JSON.stringify(direct.packageInfo)) {
      throw new Error("Direct package metadata mismatch");
    }
    assertArtifact(manifest.artifacts.static, {
      assetId: releaseIds.static,
      filename: filenames.static,
      keys: ["assetId", "filename", "format", "bytes", "sha256", "rootDirectory", "stripComponents", "unpacked"],
      rootDirectory: roots.static,
      unpacked: staticArchive.unpacked,
    }, archives.static, "Static");
    assertArtifact(manifest.artifacts.source, {
      assetId: releaseIds.source,
      filename: filenames.source,
      keys: ["assetId", "filename", "format", "bytes", "sha256", "rootDirectory", "stripComponents", "unpacked", "commit"],
      rootDirectory: roots.source,
      unpacked: source.unpacked,
    }, archives.source, "Source");
    if (manifest.artifacts.source.commit !== context.commit) throw new Error("Source artifact commit mismatch");
  }

  return {
    valid: true,
    version: context.version,
    tag: context.tag,
    commit: context.commit,
    repository: context.repository,
    updaterEnabled,
    archives: {
      direct: { entryCount: direct.entryCount, forwardSlashPaths: true, rootDirectory: roots.direct },
      source: { commit: source.commit, entryCount: source.entryCount, forwardSlashPaths: true, rootDirectory: roots.source },
      static: { entryCount: staticArchive.entryCount, forwardSlashPaths: true, rootDirectory: roots.static },
    },
  };
}

export async function runVerifyReleaseBundle(argv = process.argv.slice(2)) {
  return verifyReleaseBundle(parseArguments(argv));
}

const isCommandLine = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCommandLine) {
  try {
    const result = await runVerifyReleaseBundle();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Release bundle verification failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
