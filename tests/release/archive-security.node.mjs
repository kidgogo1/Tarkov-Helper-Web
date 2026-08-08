import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNoWindowsPathCollisions,
  assertSafeArchivePath,
  createZipFromDirectory,
  loadReleaseConfig,
  parseChecksumText,
  readZipArchive,
} from "../../scripts/release-utils.mjs";

test("Windows-unsafe archive paths are rejected", () => {
  for (const unsafe of [
    "root/file.txt:payload",
    "root/CON",
    "root/con.txt",
    "root/COM1.log",
    "root/trailing.",
    "root/trailing ",
    "root/dir./file.txt",
    "root/question?.txt",
  ]) {
    assert.throws(() => assertSafeArchivePath(unsafe), /unsafe|reserved|trailing|invalid/i, unsafe);
  }
});

test("case-insensitive, Unicode-normalized, and file-directory collisions are rejected", () => {
  assert.throws(() => assertNoWindowsPathCollisions([
    { path: "root/README.md", directory: false },
    { path: "root/readme.md", directory: false },
  ]), /collision/i);
  assert.throws(() => assertNoWindowsPathCollisions([
    { path: "root/caf\u00e9.txt", directory: false },
    { path: "root/cafe\u0301.txt", directory: false },
  ]), /collision/i);
  assert.throws(() => assertNoWindowsPathCollisions([
    { path: "root/config", directory: false },
    { path: "root/config/settings.json", directory: false },
  ]), /overlap/i);
});

test("ZIP reader enforces archive, entry, total, and regular-file bounds before inflation", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "tarkov-zip-security-"));
  const input = path.join(parent, "input");
  const archive = path.join(parent, "fixture.zip");
  try {
    await mkdir(input);
    await writeFile(path.join(input, "safe.txt"), "0123456789");
    await createZipFromDirectory({ directory: input, filename: archive, rootDirectory: "root" });

    await assert.rejects(readZipArchive(archive, { maxArchiveBytes: 1 }), /archive size limit/i);
    await assert.rejects(readZipArchive(archive, { maxEntryCompressedBytes: 1 }), /compressed entry size limit/i);
    await assert.rejects(readZipArchive(archive, { maxEntryUncompressedBytes: 5 }), /entry size limit/i);
    await assert.rejects(readZipArchive(archive, { maxTotalUncompressedBytes: 5 }), /total uncompressed size limit/i);

    const bytes = Buffer.from(await readFile(archive));
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.notEqual(central, -1);
    bytes.writeUInt32LE((0o010644 << 16) >>> 0, central + 38);
    await writeFile(archive, bytes);
    await assert.rejects(readZipArchive(archive), /non-regular ZIP entry/i);

    await createZipFromDirectory({ directory: input, filename: archive, rootDirectory: "root" });
    const reparse = Buffer.from(await readFile(archive));
    const reparseCentral = reparse.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    reparse.writeUInt16LE(20, reparseCentral + 4);
    reparse.writeUInt32LE(0x0400, reparseCentral + 38);
    await writeFile(archive, reparse);
    await assert.rejects(readZipArchive(archive), /non-regular ZIP entry/i);

    await writeFile(path.join(input, "second.txt"), "abcdefghij");
    await createZipFromDirectory({ directory: input, filename: archive, rootDirectory: "root" });
    const overlap = Buffer.from(await readFile(archive));
    const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    const firstCentral = overlap.indexOf(signature);
    const secondCentral = overlap.indexOf(signature, firstCentral + 4);
    assert.notEqual(secondCentral, -1);
    const firstLocal = overlap.readUInt32LE(firstCentral + 42);
    const secondLocal = overlap.readUInt32LE(secondCentral + 42);
    const firstData = firstLocal + 30 + overlap.readUInt16LE(firstLocal + 26) + overlap.readUInt16LE(firstLocal + 28);
    const overlappingCompressedSize = secondLocal - firstData + 1;
    overlap.writeUInt32LE(overlappingCompressedSize, firstCentral + 20);
    overlap.writeUInt32LE(overlappingCompressedSize, firstLocal + 18);
    await writeFile(archive, overlap);
    await assert.rejects(readZipArchive(archive), /entry data overlap/i);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("ZIP reader rejects dangerous flags, corrupt identity, and trailing records", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "tarkov-zip-malicious-"));
  const input = path.join(parent, "input");
  const archive = path.join(parent, "fixture.zip");
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  try {
    await mkdir(input);
    await writeFile(path.join(input, "safe.txt"), "safe payload\n");
    const fresh = async () => {
      await createZipFromDirectory({ directory: input, filename: archive, rootDirectory: "root" });
      const bytes = Buffer.from(await readFile(archive));
      const central = bytes.indexOf(centralSignature);
      const local = bytes.readUInt32LE(central + 42);
      return { bytes, central, local };
    };

    for (const flag of [0x0001, 0x0008]) {
      const { bytes, central } = await fresh();
      bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | flag, central + 8);
      await writeFile(archive, bytes);
      await assert.rejects(readZipArchive(archive), /encrypted|data descriptors/i);
    }

    {
      const { bytes, central, local } = await fresh();
      bytes[central + 46] ^= 0x01;
      await writeFile(archive, bytes);
      await assert.rejects(readZipArchive(archive), /local and central names differ/i);

      const crcBytes = (await fresh()).bytes;
      const crcCentral = crcBytes.indexOf(centralSignature);
      const crcLocal = crcBytes.readUInt32LE(crcCentral + 42);
      const badCrc = (crcBytes.readUInt32LE(crcCentral + 16) ^ 0xffffffff) >>> 0;
      crcBytes.writeUInt32LE(badCrc, crcCentral + 16);
      crcBytes.writeUInt32LE(badCrc, crcLocal + 14);
      await writeFile(archive, crcBytes);
      await assert.rejects(readZipArchive(archive), /CRC-32 mismatch/i);
      assert(Number.isSafeInteger(local));
    }

    {
      const { bytes } = await fresh();
      await writeFile(archive, Buffer.concat([bytes, Buffer.from([0])]));
      await assert.rejects(readZipArchive(archive), /trailing data|end-of-central-directory/i);
    }

    {
      const { bytes } = await fresh();
      const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      bytes.writeUInt16LE(1, end + 4);
      await writeFile(archive, bytes);
      await assert.rejects(readZipArchive(archive), /multi-disk/i);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("release config and checksum contracts reject schema drift and ambiguous JSON", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "tarkov-release-config-"));
  const filename = path.join(parent, "release.json");
  const valid = {
    schemaVersion: 1,
    product: "tarkov-helper-web",
    channel: "stable",
    repository: null,
    directRootName: "Tarkov Helper Direct",
    updater: {
      enabled: false,
      protocolVersion: 1,
      configFile: "UPDATE_CONFIG.json",
      manifestAsset: "update-manifest-v1.json",
      signatureAsset: "update-manifest-v1.sig",
      requireImmutableRelease: true,
      signing: { algorithm: "RSA-SHA256", minimumRsaBits: 3072 },
    },
  };
  try {
    await writeFile(filename, `${JSON.stringify({ ...valid, unexpected: true })}\n`);
    await assert.rejects(loadReleaseConfig(filename), /unknown or missing keys/i);
    await writeFile(filename, `${JSON.stringify(valid).slice(0, -1)},"product":"forged"}\n`);
    await assert.rejects(loadReleaseConfig(filename), /duplicate JSON key/i);
    assert.throws(() => parseChecksumText(`${"0".repeat(64)}  2  z.txt\n${"0".repeat(64)}  1  a.txt\n`), /canonical ascending order/i);
    assert.throws(() => parseChecksumText(`${"0".repeat(64)}  99999999999999999999  a.txt\n`), /safe integer/i);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
