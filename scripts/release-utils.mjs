import {
  constants as cryptoConstants,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { lstat, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ZIP_LOCAL_FILE = 0x04034b50;
const ZIP_CENTRAL_FILE = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_ENCRYPTED_FLAG = 0x0001;
const ZIP_STORE = 0;
const ZIP_DEFLATE = 8;
const MAX_ZIP_32 = 0xffffffff;
const MAX_ZIP_ENTRIES = 0xffff;
export const DEFAULT_ZIP_LIMITS = Object.freeze({
  maxArchiveBytes: 128 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryCompressedBytes: 128 * 1024 * 1024,
  maxEntryUncompressedBytes: 128 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 200,
});
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

let crcTable;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    crcTable[index] = value >>> 0;
  }
  return crcTable;
}

export function crc32(contents) {
  const table = getCrcTable();
  let value = 0xffffffff;
  for (const byte of contents) value = (value >>> 8) ^ table[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

export function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

export async function fileRecord(
  filename,
  displayPath = path.basename(filename),
  { maxBytes = Number.MAX_SAFE_INTEGER } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error(`Invalid file size limit: ${maxBytes}`);
  const handle = await open(filename, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Input is not a regular file: ${filename}`);
    if (!Number.isSafeInteger(before.size) || before.size > maxBytes) {
      throw new Error(`File size limit exceeded for ${displayPath}: ${before.size} > ${maxBytes}`);
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, before.size)));
    let size = 0;
    while (size < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - size), size);
      if (bytesRead === 0) break;
      size += bytesRead;
      digest.update(buffer.subarray(0, bytesRead));
    }
    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, size);
    const after = await handle.stat();
    if (size !== before.size || extraBytes !== 0 || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`File changed while hashing: ${displayPath}`);
    }
    return { path: displayPath, size, sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assertSafeArchivePath(archivePath, { directory = false } = {}) {
  if (typeof archivePath !== "string" || archivePath.length === 0) {
    throw new Error("Archive entry path must be a non-empty string");
  }
  if (archivePath.includes("\\") || archivePath.includes("\0") || archivePath.startsWith("/") || /^[A-Za-z]:/.test(archivePath)) {
    throw new Error(`Unsafe archive entry path: ${archivePath}`);
  }
  if (directory !== archivePath.endsWith("/")) {
    throw new Error(`Archive entry has an invalid directory marker: ${archivePath}`);
  }
  const normalized = directory ? archivePath.slice(0, -1) : archivePath;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Unsafe archive entry path: ${archivePath}`);
  }
  if (normalized.length > 1024) throw new Error(`Unsafe archive entry path is too long: ${archivePath}`);
  for (const segment of segments) {
    const invalidWindowsCharacter = [...segment].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint < 32 || '<>:"|?*'.includes(character);
    });
    if (segment.length > 255 || invalidWindowsCharacter) {
      throw new Error(`Unsafe Windows archive entry path: ${archivePath}`);
    }
    if (/[ .]$/u.test(segment)) throw new Error(`Archive entry has a trailing dot or space: ${archivePath}`);
    if (WINDOWS_RESERVED_NAME.test(segment)) throw new Error(`Archive entry uses a Windows reserved name: ${archivePath}`);
  }
  return archivePath;
}

function canonicalWindowsSegment(segment) {
  return segment.normalize("NFC").toLowerCase();
}

export function assertNoWindowsPathCollisions(entries) {
  const nodes = new Map();
  for (const entry of entries) {
    assertSafeArchivePath(entry.path, { directory: entry.directory });
    const displayPath = entry.directory ? entry.path.slice(0, -1) : entry.path;
    const segments = displayPath.split("/");
    const canonicalSegments = segments.map(canonicalWindowsSegment);
    for (let index = 0; index < segments.length; index += 1) {
      const canonicalPath = canonicalSegments.slice(0, index + 1).join("/");
      const originalPath = segments.slice(0, index + 1).join("/");
      const final = index === segments.length - 1;
      const type = final && !entry.directory ? "file" : "directory";
      const existing = nodes.get(canonicalPath);
      if (existing) {
        if (existing.originalPath !== originalPath) {
          throw new Error(`Windows path collision: ${existing.originalPath} and ${originalPath}`);
        }
        if (existing.type === "file" && (type === "directory" || !final)) {
          throw new Error(`File-directory path overlap: ${existing.originalPath} and ${displayPath}`);
        }
        if (final && type === "file") throw new Error(`Windows path collision: ${existing.originalPath} and ${originalPath}`);
      } else {
        nodes.set(canonicalPath, { originalPath, type });
      }
    }
  }
}

async function collectFilesWithinBudget(directory, prefix, budget) {
  const root = await lstat(directory).catch(() => null);
  if (!root?.isDirectory() || root.isSymbolicLink()) throw new Error(`Required directory is missing: ${directory}`);

  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => comparePaths(left.name, right.name));
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    const details = await lstat(absolutePath).catch(() => null);
    if (!details || entry.isSymbolicLink() || details.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in release inputs: ${relativePath}`);
    }
    if (entry.isDirectory() && details.isDirectory()) {
      files.push(...await collectFilesWithinBudget(absolutePath, relativePath, budget));
    } else if (entry.isFile() && details.isFile()) {
      assertSafeArchivePath(relativePath);
      if (details.size > budget.maxEntry) throw new Error(`Release input entry size limit exceeded: ${relativePath}`);
      if (budget.total + details.size > budget.maxTotal) {
        throw new Error(`Release input total uncompressed size limit exceeded: ${relativePath}`);
      }
      budget.total += details.size;
      const contents = await readFileBounded(
        absolutePath,
        budget.maxEntry,
        `Release input ${relativePath}`,
        details,
      );
      files.push({ absolutePath, contents, path: relativePath, size: contents.length, sha256: sha256(contents) });
    } else {
      throw new Error(`Unsupported release input: ${relativePath}`);
    }
  }
  return files;
}

export async function collectFiles(directory, prefix = "", limitOverrides = {}) {
  const limits = validatedZipLimits(limitOverrides);
  return collectFilesWithinBudget(directory, prefix, {
    maxEntry: limits.maxEntryUncompressedBytes,
    maxTotal: limits.maxTotalUncompressedBytes,
    total: 0,
  });
}

export function checksumText(files) {
  const sorted = [...files].sort((left, right) => comparePaths(left.path, right.path));
  return `${sorted.map((file) => `${file.sha256}  ${file.size}  ${file.path}`).join("\n")}\n`;
}

export function parseChecksumText(text, label = "SHA256SUMS.txt") {
  if (!text.endsWith("\n")) throw new Error(`${label} must end with a newline`);
  if (text.includes("\r")) throw new Error(`${label} must use LF line endings`);
  const records = [];
  const seen = new Set();
  for (const line of text.slice(0, -1).split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(0|[1-9]\d*) {2}(.+)$/.exec(line);
    if (!match) throw new Error(`Malformed ${label} line: ${line}`);
    assertSafeArchivePath(match[3]);
    if (seen.has(match[3])) throw new Error(`Duplicate ${label} path: ${match[3]}`);
    if (records.length > 0 && comparePaths(records.at(-1).path, match[3]) >= 0) {
      throw new Error(`${label} paths must be in canonical ascending order`);
    }
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size)) throw new Error(`${label} size exceeds the safe integer range: ${match[3]}`);
    seen.add(match[3]);
    records.push({ path: match[3], sha256: match[1], size });
  }
  return records;
}

export function parsePackageInfo(text) {
  const readValue = (label, pattern) => {
    const match = new RegExp(`^${label}: (${pattern})$`, "m").exec(text);
    if (!match) throw new Error(`PACKAGE_INFO.txt is missing ${label}`);
    return match[1];
  };
  return {
    version: readValue("Version", "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)"),
    sourceCommit: readValue("Source commit", "[0-9a-f]{40}"),
    updaterProtocolVersion: Number(readValue("Updater protocol", "[1-9]\\d*")),
    appFiles: Number(readValue("App files", "0|[1-9]\\d*")),
    appBytes: Number(readValue("App bytes", "0|[1-9]\\d*")),
    appTreeSha256: readValue("App tree SHA-256", "[0-9a-f]{64}"),
  };
}

export function validateStableVersion(version) {
  if (typeof version !== "string" || !STABLE_VERSION.test(version)) {
    throw new Error(`package.json version must be a stable semantic version: ${version ?? "missing"}`);
  }
  return version;
}

export function validateRepository(repository) {
  if (typeof repository !== "string") throw new Error("Repository must use owner/repository form");
  const parts = repository.split("/");
  if (parts.length !== 2) throw new Error("Repository must use owner/repository form");
  const [owner, name] = parts;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
    throw new Error("Repository must use owner/repository form");
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name === "." || name === ".." || name.endsWith(".git")) {
    throw new Error("Repository must use owner/repository form");
  }
  return repository;
}

export function validateCommit(commit) {
  if (typeof commit !== "string" || !COMMIT.test(commit)) throw new Error(`Commit must be a full lowercase SHA-1: ${commit}`);
  return commit;
}

function exactObjectKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort(comparePaths);
  const expected = [...expectedKeys].sort(comparePaths);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} contains unknown or missing keys`);
}

function assertNoDuplicateJsonKeys(text, label) {
  let cursor = 0;
  const skipWhitespace = () => {
    while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
  };
  const parseString = () => {
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      const character = text[cursor];
      if (character === '"') {
        cursor += 1;
        return JSON.parse(text.slice(start, cursor));
      }
      if (character === "\\") cursor += 1;
      cursor += 1;
    }
    throw new Error(`${label} contains an unterminated JSON string`);
  };
  const parseValue = () => {
    skipWhitespace();
    const character = text[cursor];
    if (character === "{") {
      cursor += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[cursor] === "}") { cursor += 1; return; }
      while (cursor < text.length) {
        skipWhitespace();
        if (text[cursor] !== '"') throw new Error(`${label} contains malformed JSON`);
        const key = parseString();
        if (keys.has(key)) throw new Error(`${label} contains duplicate JSON key: ${key}`);
        keys.add(key);
        skipWhitespace();
        if (text[cursor] !== ":") throw new Error(`${label} contains malformed JSON`);
        cursor += 1;
        parseValue();
        skipWhitespace();
        if (text[cursor] === "}") { cursor += 1; return; }
        if (text[cursor] !== ",") throw new Error(`${label} contains malformed JSON`);
        cursor += 1;
      }
      throw new Error(`${label} contains malformed JSON`);
    }
    if (character === "[") {
      cursor += 1;
      skipWhitespace();
      if (text[cursor] === "]") { cursor += 1; return; }
      while (cursor < text.length) {
        parseValue();
        skipWhitespace();
        if (text[cursor] === "]") { cursor += 1; return; }
        if (text[cursor] !== ",") throw new Error(`${label} contains malformed JSON`);
        cursor += 1;
      }
      throw new Error(`${label} contains malformed JSON`);
    }
    if (character === '"') { parseString(); return; }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(cursor));
    if (!primitive) throw new Error(`${label} contains malformed JSON`);
    cursor += primitive[0].length;
  };
  parseValue();
  skipWhitespace();
  if (cursor !== text.length) throw new Error(`${label} contains trailing JSON data`);
}

export function parseStrictJson(text, label = "JSON") {
  assertNoDuplicateJsonKeys(text, label);
  return JSON.parse(text);
}

export function gitText(projectRoot, args) {
  try {
    return execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const detail = error?.stderr?.trim?.() || error?.message || String(error);
    throw new Error(`Git command failed (${args.join(" ")}): ${detail}`);
  }
}

export async function assertReleaseContext({
  commit,
  projectRoot,
  repository,
  requireRepository = false,
  tag,
}) {
  const packagePath = path.join(projectRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const version = validateStableVersion(packageJson.version);
  const expectedTag = `v${version}`;
  const actualTag = tag ?? expectedTag;
  if (actualTag !== expectedTag) {
    throw new Error(`Tag ${actualTag} must exactly match package.json version ${expectedTag}`);
  }

  const head = validateCommit(gitText(projectRoot, ["rev-parse", "HEAD"]));
  const actualCommit = validateCommit(commit ?? head);
  if (actualCommit !== head) throw new Error(`Commit ${actualCommit} does not match HEAD ${head}`);
  if (requireRepository) {
    let tagCommit;
    try {
      tagCommit = validateCommit(gitText(projectRoot, ["rev-parse", "--verify", `refs/tags/${actualTag}^{commit}`]));
    } catch (error) {
      throw new Error(`Release tag ${actualTag} does not resolve to a commit: ${error?.message ?? error}`);
    }
    if (tagCommit !== head) throw new Error(`Release tag ${actualTag} does not resolve to HEAD ${head}`);
  }
  const status = gitText(projectRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (status) throw new Error(`Git working tree must be clean:\n${status}`);

  const actualRepository = repository === undefined ? null : validateRepository(repository);
  if (requireRepository && !actualRepository) throw new Error("Repository is required for a public release");
  return { commit: actualCommit, repository: actualRepository, tag: actualTag, version };
}

export async function loadReleaseConfig(filename) {
  const config = parseStrictJson(await readFile(filename, "utf8"), "release config");
  exactObjectKeys(config, ["schemaVersion", "product", "channel", "repository", "directRootName", "updater"], "release config");
  exactObjectKeys(config.updater, [
    "enabled",
    "protocolVersion",
    "configFile",
    "manifestAsset",
    "signatureAsset",
    "requireImmutableRelease",
    "signing",
  ], "release config updater");
  exactObjectKeys(config.updater.signing, ["algorithm", "minimumRsaBits"], "release config signing");
  if (config.schemaVersion !== 1) throw new Error("release config schemaVersion must be 1");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.product)) throw new Error("release config product is invalid");
  if (config.channel !== "stable") throw new Error("release config channel must be stable");
  if (config.repository !== null) throw new Error("release config must not hardcode repository identity");
  if (typeof config.directRootName !== "string" || !config.directRootName.trim()) throw new Error("release config directRootName is invalid");
  if (
    config.updater?.enabled !== false ||
    config.updater?.protocolVersion !== 1 ||
    config.updater?.configFile !== "UPDATE_CONFIG.json" ||
    config.updater?.manifestAsset !== "update-manifest-v1.json" ||
    config.updater?.signatureAsset !== "update-manifest-v1.sig" ||
    config.updater?.requireImmutableRelease !== true ||
    config.updater?.signing?.algorithm !== "RSA-SHA256" ||
    config.updater?.signing?.minimumRsaBits !== 3072
  ) {
    throw new Error("release config updater contract is invalid");
  }
  return config;
}

function publicKeyDetails(key) {
  if (key.asymmetricKeyType !== "rsa") throw new Error("Update signing key must be an RSA key");
  const modulusLength = key.asymmetricKeyDetails?.modulusLength;
  if (!Number.isInteger(modulusLength) || modulusLength < 3072) {
    throw new Error("Update signing RSA key must be at least 3072 bits");
  }
  const publicKeySpkiPem = key.export({ format: "pem", type: "spki" }).toString();
  const publicKeySpkiDer = key.export({ format: "der", type: "spki" });
  return {
    keyId: `sha256:${sha256(publicKeySpkiDer)}`,
    publicKey: key,
    publicKeySpkiPem,
  };
}

export function loadPublicSigningKey(publicKeyPem) {
  if (!publicKeyPem?.trim()) throw new Error("UPDATE_SIGNING_PUBLIC_KEY is required for a public release");
  try {
    return publicKeyDetails(createPublicKey(publicKeyPem));
  } catch (error) {
    if (/UPDATE_SIGNING_PUBLIC_KEY|at least 3072|must be an RSA/.test(error?.message ?? "")) throw error;
    throw new Error(`UPDATE_SIGNING_PUBLIC_KEY is invalid: ${error?.message ?? error}`);
  }
}

export function loadSigningKeyPair(privateKeyPem, publicKeyPem) {
  if (!privateKeyPem?.trim()) throw new Error("UPDATE_SIGNING_PRIVATE_KEY is required for a public release");
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch (error) {
    throw new Error(`UPDATE_SIGNING_PRIVATE_KEY is invalid: ${error?.message ?? error}`);
  }
  const derived = publicKeyDetails(createPublicKey(privateKey));
  const supplied = loadPublicSigningKey(publicKeyPem);
  if (derived.keyId !== supplied.keyId || derived.publicKeySpkiPem !== supplied.publicKeySpkiPem) {
    throw new Error("UPDATE_SIGNING_PRIVATE_KEY and UPDATE_SIGNING_PUBLIC_KEY do not match");
  }
  return { ...derived, privateKey };
}

export function signManifest(contents, privateKey) {
  return cryptoSign("RSA-SHA256", contents, {
    key: privateKey,
    padding: cryptoConstants.RSA_PKCS1_PADDING,
  });
}

export function verifyManifestSignature(contents, signature, publicKey) {
  return cryptoVerify("RSA-SHA256", contents, {
    key: publicKey,
    padding: cryptoConstants.RSA_PKCS1_PADDING,
  }, signature);
}

function zipHeaders(entry, offset) {
  const name = Buffer.from(entry.path, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(ZIP_LOCAL_FILE, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(ZIP_UTF8_FLAG, 6);
  local.writeUInt16LE(ZIP_DEFLATE, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0x0021, 12);
  local.writeUInt32LE(entry.crc, 14);
  local.writeUInt32LE(entry.compressed.length, 18);
  local.writeUInt32LE(entry.contents.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(ZIP_CENTRAL_FILE, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(ZIP_UTF8_FLAG, 8);
  central.writeUInt16LE(ZIP_DEFLATE, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x0021, 14);
  central.writeUInt32LE(entry.crc, 16);
  central.writeUInt32LE(entry.compressed.length, 20);
  central.writeUInt32LE(entry.contents.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  central.writeUInt32LE(offset, 42);
  return { central: Buffer.concat([central, name]), local: Buffer.concat([local, name]) };
}

export async function createZipFromDirectory({ directory, filename, rootDirectory }) {
  assertSafeArchivePath(rootDirectory);
  const files = await collectFiles(directory);
  if (files.length === 0) throw new Error(`Cannot archive an empty directory: ${directory}`);
  if (files.length > DEFAULT_ZIP_LIMITS.maxEntries || files.length > MAX_ZIP_ENTRIES) throw new Error("ZIP entry count limit exceeded");
  const inputBytes = files.reduce((total, file) => total + file.size, 0);
  if (inputBytes > DEFAULT_ZIP_LIMITS.maxTotalUncompressedBytes) throw new Error("ZIP total uncompressed size limit exceeded");
  if (files.some((file) => file.size > DEFAULT_ZIP_LIMITS.maxEntryUncompressedBytes)) throw new Error("ZIP entry size limit exceeded");
  assertNoWindowsPathCollisions(files.map((file) => ({ directory: false, path: `${rootDirectory}/${file.path}` })));

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const archivePath = `${rootDirectory}/${file.path}`;
    assertSafeArchivePath(archivePath);
    const compressed = deflateRawSync(file.contents, { level: 9 });
    if (compressed.length > DEFAULT_ZIP_LIMITS.maxEntryCompressedBytes) {
      throw new Error(`ZIP compressed entry size limit exceeded: ${archivePath}`);
    }
    if (compressed.length > MAX_ZIP_32 || file.contents.length > MAX_ZIP_32 || offset > MAX_ZIP_32) {
      throw new Error("ZIP64 is not supported: archive is too large");
    }
    const entry = { compressed, contents: file.contents, crc: crc32(file.contents), path: archivePath };
    const headers = zipHeaders(entry, offset);
    localParts.push(headers.local, compressed);
    centralParts.push(headers.central);
    offset += headers.local.length + compressed.length;
    if (offset > DEFAULT_ZIP_LIMITS.maxArchiveBytes) throw new Error("ZIP archive size limit exceeded");
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  const archive = Buffer.concat([...localParts, central, end]);
  if (archive.length > DEFAULT_ZIP_LIMITS.maxArchiveBytes) throw new Error("ZIP archive size limit exceeded");
  await writeFile(filename, archive);
  return files;
}

function findZipEnd(contents) {
  const minimum = Math.max(0, contents.length - 22 - 0xffff);
  for (let offset = contents.length - 22; offset >= minimum; offset -= 1) {
    if (contents.readUInt32LE(offset) === ZIP_END) return offset;
  }
  throw new Error("ZIP end-of-central-directory record is missing");
}

function checkRange(contents, offset, size, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > contents.length) {
    throw new Error(`ZIP ${label} is out of bounds`);
  }
}

function validatedZipLimits(overrides) {
  const limits = { ...DEFAULT_ZIP_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ZIP limit ${name}: ${value}`);
  }
  return limits;
}

function assertSupportedZipExtraFields(contents, offset, length, label) {
  const end = offset + length;
  checkRange(contents, offset, length, `${label} extra fields`);
  const seen = new Set();
  while (offset < end) {
    if (offset + 4 > end) throw new Error(`Malformed ZIP ${label} extra field`);
    const identifier = contents.readUInt16LE(offset);
    const dataLength = contents.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + dataLength > end) throw new Error(`Malformed ZIP ${label} extra field`);
    if (seen.has(identifier)) throw new Error(`Duplicate ZIP ${label} extra field: ${identifier}`);
    seen.add(identifier);
    // git archive emits the standard extended-timestamp field. All alternate
    // path, NTFS, Unix ownership, and ZIP64 fields remain forbidden.
    if (identifier !== 0x5455 || ![5, 9, 13].includes(dataLength)) {
      throw new Error(`Unsupported ZIP ${label} extra field: ${identifier}`);
    }
    const flags = contents[offset];
    const expectedLength = 1 + 4 * Number(Boolean(flags & 1)) + 4 * Number(Boolean(flags & 2)) + 4 * Number(Boolean(flags & 4));
    if ((flags & ~0x07) !== 0 || dataLength !== expectedLength) {
      throw new Error(`Malformed ZIP ${label} extended timestamp field`);
    }
    offset += dataLength;
  }
}

export async function readFileBounded(filename, maxBytes, label = "File", expected = null) {
  const handle = await open(filename, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} input is not a regular file: ${filename}`);
    if (
      expected &&
      (before.size !== expected.size || before.mtimeMs !== expected.mtimeMs ||
        before.dev !== expected.dev || before.ino !== expected.ino)
    ) {
      throw new Error(`${label} changed before it could be read: ${filename}`);
    }
    if (!Number.isSafeInteger(before.size) || before.size > maxBytes) {
      throw new Error(`${label} size limit exceeded: ${before.size} > ${maxBytes}`);
    }
    const contents = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < contents.length) {
      const { bytesRead } = await handle.read(contents, offset, contents.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(probe, 0, 1, offset);
    const after = await handle.stat();
    if (
      offset !== before.size || extraBytes !== 0 || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.dev !== before.dev || after.ino !== before.ino
    ) {
      throw new Error(`${label} changed while being read: ${filename}`);
    }
    return contents;
  } finally {
    await handle.close();
  }
}

export async function readZipArchive(filename, limitOverrides = {}, options = {}) {
  const limits = validatedZipLimits(limitOverrides);
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== "retainContents") ||
    (options.retainContents !== undefined && typeof options.retainContents !== "function")
  ) {
    throw new Error("Invalid ZIP reader options");
  }
  const retainContents = options.retainContents ?? (() => true);
  const contents = await readFileBounded(filename, limits.maxArchiveBytes, "ZIP archive");
  if (contents.length < 22) throw new Error("ZIP file is truncated");
  const endOffset = findZipEnd(contents);
  const disk = contents.readUInt16LE(endOffset + 4);
  const centralDisk = contents.readUInt16LE(endOffset + 6);
  const diskEntries = contents.readUInt16LE(endOffset + 8);
  const entryCount = contents.readUInt16LE(endOffset + 10);
  const centralSize = contents.readUInt32LE(endOffset + 12);
  const centralOffset = contents.readUInt32LE(endOffset + 16);
  const commentLength = contents.readUInt16LE(endOffset + 20);
  checkRange(contents, endOffset + 22, commentLength, "comment");
  if (endOffset + 22 + commentLength !== contents.length) throw new Error("ZIP contains trailing data");
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount || entryCount === MAX_ZIP_ENTRIES) {
    throw new Error("Multi-disk and ZIP64 archives are not supported");
  }
  if (entryCount > limits.maxEntries) throw new Error(`ZIP entry count limit exceeded: ${entryCount}`);
  checkRange(contents, centralOffset, centralSize, "central directory");
  if (centralOffset + centralSize !== endOffset) throw new Error("ZIP central directory layout is invalid");

  const metadata = [];
  let declaredTotal = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    checkRange(contents, cursor, 46, "central entry");
    if (contents.readUInt32LE(cursor) !== ZIP_CENTRAL_FILE) throw new Error("ZIP central entry signature is invalid");
    const versionMadeBy = contents.readUInt16LE(cursor + 4);
    const versionNeeded = contents.readUInt16LE(cursor + 6);
    const flags = contents.readUInt16LE(cursor + 8);
    const method = contents.readUInt16LE(cursor + 10);
    const expectedCrc = contents.readUInt32LE(cursor + 16);
    const compressedSize = contents.readUInt32LE(cursor + 20);
    const uncompressedSize = contents.readUInt32LE(cursor + 24);
    const nameLength = contents.readUInt16LE(cursor + 28);
    const extraLength = contents.readUInt16LE(cursor + 30);
    const entryCommentLength = contents.readUInt16LE(cursor + 32);
    const diskStart = contents.readUInt16LE(cursor + 34);
    const externalAttributes = contents.readUInt32LE(cursor + 38);
    const localOffset = contents.readUInt32LE(cursor + 42);
    const centralEntrySize = 46 + nameLength + extraLength + entryCommentLength;
    checkRange(contents, cursor, centralEntrySize, "central entry");
    if (versionNeeded > 20) throw new Error(`ZIP64 or unsupported ZIP version is not allowed: ${versionNeeded}`);
    if (flags & ZIP_ENCRYPTED_FLAG) throw new Error("Encrypted ZIP entries are not supported");
    if (flags & 0x0008) throw new Error("ZIP data descriptors are not supported");
    if ((flags & ~ZIP_UTF8_FLAG) !== 0) throw new Error(`Unsupported ZIP entry flags: ${flags}`);
    if (method !== ZIP_STORE && method !== ZIP_DEFLATE) throw new Error(`Unsupported ZIP compression method: ${method}`);
    if (diskStart !== 0) throw new Error("Multi-disk ZIP entries are not supported");
    assertSupportedZipExtraFields(contents, cursor + 46 + nameLength, extraLength, "central");
    if (entryCommentLength !== 0) throw new Error("ZIP per-entry comments are not supported");
    const nameBytes = contents.subarray(cursor + 46, cursor + 46 + nameLength);
    if (!(flags & ZIP_UTF8_FLAG) && nameBytes.some((byte) => byte > 0x7f)) {
      throw new Error("Non-ASCII ZIP names must declare UTF-8 encoding");
    }
    let entryPath;
    try {
      entryPath = (flags & ZIP_UTF8_FLAG) ? utf8Decoder.decode(nameBytes) : nameBytes.toString("ascii");
    } catch {
      throw new Error("ZIP entry name is not valid UTF-8");
    }
    const directory = entryPath.endsWith("/");
    assertSafeArchivePath(entryPath, { directory });
    const platform = versionMadeBy >>> 8;
    if (platform === 3) {
      const unixType = (externalAttributes >>> 16) & 0o170000;
      const expectedType = directory ? 0o040000 : 0o100000;
      if (unixType !== expectedType) throw new Error(`Non-regular ZIP entry is not allowed: ${entryPath}`);
    } else {
      const dosAttributes = externalAttributes & 0xffff;
      const allowedDosAttributes = directory ? 0x37 : 0x27;
      if ((dosAttributes & ~allowedDosAttributes) !== 0 || (directory ? !(dosAttributes & 0x10) : Boolean(dosAttributes & 0x10))) {
        throw new Error(`Non-regular ZIP entry is not allowed: ${entryPath}`);
      }
    }
    if (compressedSize > limits.maxEntryCompressedBytes) {
      throw new Error(`ZIP compressed entry size limit exceeded: ${entryPath}`);
    }
    if (uncompressedSize > limits.maxEntryUncompressedBytes) {
      throw new Error(`ZIP entry size limit exceeded: ${entryPath}`);
    }
    declaredTotal += uncompressedSize;
    if (!Number.isSafeInteger(declaredTotal) || declaredTotal > limits.maxTotalUncompressedBytes) {
      throw new Error(`ZIP total uncompressed size limit exceeded at: ${entryPath}`);
    }
    if (
      uncompressedSize > 1024 * 1024 &&
      (compressedSize === 0 || uncompressedSize / compressedSize > limits.maxCompressionRatio)
    ) {
      throw new Error(`ZIP compression ratio limit exceeded: ${entryPath}`);
    }

    checkRange(contents, localOffset, 30, "local entry");
    if (contents.readUInt32LE(localOffset) !== ZIP_LOCAL_FILE) throw new Error("ZIP local entry signature is invalid");
    const localVersionNeeded = contents.readUInt16LE(localOffset + 4);
    const localFlags = contents.readUInt16LE(localOffset + 6);
    const localMethod = contents.readUInt16LE(localOffset + 8);
    const localCrc = contents.readUInt32LE(localOffset + 14);
    const localCompressedSize = contents.readUInt32LE(localOffset + 18);
    const localUncompressedSize = contents.readUInt32LE(localOffset + 22);
    const localNameLength = contents.readUInt16LE(localOffset + 26);
    const localExtraLength = contents.readUInt16LE(localOffset + 28);
    checkRange(contents, localOffset + 30, localNameLength + localExtraLength + compressedSize, "local entry data");
    const localNameBytes = contents.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (!localNameBytes.equals(nameBytes)) throw new Error(`ZIP local and central names differ: ${entryPath}`);
    if (
      localFlags !== flags ||
      localVersionNeeded !== versionNeeded ||
      localMethod !== method ||
      localCrc !== expectedCrc ||
      localCompressedSize !== compressedSize ||
      localUncompressedSize !== uncompressedSize
    ) {
      throw new Error(`ZIP local and central metadata differ: ${entryPath}`);
    }
    assertSupportedZipExtraFields(contents, localOffset + 30 + localNameLength, localExtraLength, "local");
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > centralOffset) throw new Error(`ZIP entry overlaps the central directory: ${entryPath}`);
    metadata.push({
      compressedSize,
      dataOffset,
      directory,
      expectedCrc,
      localOffset,
      method,
      path: entryPath,
      uncompressedSize,
    });
    cursor += centralEntrySize;
  }
  if (cursor !== endOffset) throw new Error("ZIP central directory entry count is invalid");
  assertNoWindowsPathCollisions(metadata);
  const ranges = metadata
    .map((entry) => ({ end: entry.dataOffset + entry.compressedSize, path: entry.path, start: entry.localOffset }))
    .sort((left, right) => left.start - right.start);
  if (ranges.length === 0 || ranges[0].start !== 0) {
    throw new Error("ZIP local records must form a contiguous layout from byte zero");
  }
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) {
      throw new Error(`ZIP entry data overlap: ${ranges[index - 1].path} and ${ranges[index].path}`);
    }
    if (ranges[index].start !== ranges[index - 1].end) {
      throw new Error(`ZIP local record gap: ${ranges[index - 1].path} and ${ranges[index].path}`);
    }
  }
  if (ranges.at(-1).end !== centralOffset) {
    throw new Error("ZIP local records and central directory must be contiguous");
  }

  const entries = [];
  let actualTotal = 0;
  for (const entry of metadata) {
    const compressed = contents.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    let data;
    try {
      data = entry.method === ZIP_STORE
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
    } catch (error) {
      throw new Error(`ZIP inflation failed within configured bounds for ${entry.path}: ${error?.message ?? error}`);
    }
    if (data.length !== entry.uncompressedSize) throw new Error(`ZIP size mismatch: ${entry.path}`);
    if (crc32(data) !== entry.expectedCrc) throw new Error(`ZIP CRC-32 mismatch: ${entry.path}`);
    if (entry.directory && data.length !== 0) throw new Error(`ZIP directory entry contains data: ${entry.path}`);
    actualTotal += data.length;
    if (actualTotal > limits.maxTotalUncompressedBytes) throw new Error(`ZIP total uncompressed size limit exceeded at: ${entry.path}`);
    const retain = retainContents(entry.path, entry.directory);
    if (typeof retain !== "boolean") throw new Error(`ZIP retainContents must return a boolean: ${entry.path}`);
    const record = { directory: entry.directory, path: entry.path, sha256: sha256(data), size: data.length };
    if (retain) record.contents = data;
    entries.push(record);
  }
  const comment = contents.subarray(endOffset + 22, endOffset + 22 + commentLength).toString("utf8");
  return { comment, entries, sha256: sha256(contents), size: contents.length };
}

export async function requireRegularFile(filename) {
  const value = await stat(filename).catch(() => null);
  if (!value?.isFile()) throw new Error(`Required file is missing: ${filename}`);
  return value;
}
