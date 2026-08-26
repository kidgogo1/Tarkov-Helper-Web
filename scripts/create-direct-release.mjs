import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildWindowsLauncher } from "./build-windows-launcher.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = path.join(projectRoot, "dist");
const portableDirectory = path.join(projectRoot, "portable");
const defaultOutput = path.resolve(projectRoot, "..", "Tarkov Helper 바로 실행");

function readOutputArgument() {
  const args = process.argv.slice(2);
  if (args.length === 0) return defaultOutput;
  if (args.length === 2 && args[0] === "--output" && args[1]) {
    return path.resolve(args[1]);
  }
  throw new Error("Usage: node scripts/create-direct-release.mjs [--output <directory>]");
}

async function requireFile(filename) {
  const file = await stat(filename).catch(() => null);
  if (!file?.isFile()) throw new Error(`Required file is missing: ${filename}`);
}

async function collectFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(absolutePath, relativePath));
    if (entry.isFile()) {
      const contents = await readFile(absolutePath);
      files.push({
        path: relativePath,
        size: contents.length,
        sha256: createHash("sha256").update(contents).digest("hex"),
      });
    }
  }
  return files;
}

function manifestText(files) {
  return files.map((file) => `${file.sha256}  ${file.size}  ${file.path}`).join("\n") + "\n";
}

function sourceIdentity() {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Git returned an invalid source commit");
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { commit, label: status ? `${commit}-dirty` : commit };
  } catch (error) {
    throw new Error(`Unable to determine the source commit: ${error?.message ?? error}`);
  }
}

const packageDocument = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
if (
  typeof packageDocument.version !== "string" ||
  !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(packageDocument.version)
) {
  throw new Error("package.json must contain a stable semantic version");
}
const source = sourceIdentity();

const outputDirectory = readOutputArgument();
const filesystemRoot = path.parse(outputDirectory).root;
if (
  outputDirectory === filesystemRoot ||
  outputDirectory === projectRoot ||
  outputDirectory === distDirectory ||
  outputDirectory.startsWith(`${distDirectory}${path.sep}`)
) {
  throw new Error(`Unsafe output directory: ${outputDirectory}`);
}

await requireFile(path.join(distDirectory, "index.html"));
await requireFile(path.join(distDirectory, "data", "tarkov-data.json"));
await requireFile(path.join(distDirectory, "data", "weapon-modding", "catalog.json"));
await requireFile(path.join(distDirectory, "LICENSE"));
await requireFile(path.join(distDirectory, "THIRD_PARTY_NOTICES.md"));
await requireFile(path.join(portableDirectory, "launcher.ps1"));
await requireFile(path.join(portableDirectory, "app-update-worker.ps1"));
await requireFile(path.join(portableDirectory, "app-update-broker.ps1"));
await requireFile(path.join(portableDirectory, "TarkovHelper.ico"));
await requireFile(path.join(portableDirectory, "windows-launcher", "TarkovHelperLauncher.cs"));
await requireFile(path.join(portableDirectory, "windows-launcher", "TarkovHelperLauncher.manifest"));
await requireFile(path.join(portableDirectory, "start-menu.ps1"));
await requireFile(path.join(portableDirectory, "Tarkov Helper 시작 메뉴 등록.vbs"));
await requireFile(path.join(portableDirectory, "Tarkov Helper 시작 메뉴 제거.vbs"));
await requireFile(path.join(portableDirectory, "Tarkov Helper 실행.vbs"));
await requireFile(path.join(portableDirectory, "Tarkov Helper 종료.vbs"));
await requireFile(path.join(portableDirectory, "문제 해결용 실행.cmd"));
await requireFile(path.join(portableDirectory, "Tarkov Helper 상태 복구.cmd"));
await requireFile(path.join(portableDirectory, "Tarkov Helper 격리 복구 실행.cmd"));
await requireFile(path.join(portableDirectory, "사용 안내.txt"));

try {
  await access(outputDirectory);
  throw new Error(`Output directory already exists: ${outputDirectory}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

await mkdir(path.dirname(outputDirectory), { recursive: true });
await mkdir(outputDirectory);

try {
  await buildWindowsLauncher({
    source: path.join(portableDirectory, "windows-launcher", "TarkovHelperLauncher.cs"),
    manifest: path.join(portableDirectory, "windows-launcher", "TarkovHelperLauncher.manifest"),
    icon: path.join(portableDirectory, "TarkovHelper.ico"),
    output: path.join(outputDirectory, "Tarkov Helper.exe"),
    version: packageDocument.version,
  });
  await cp(distDirectory, path.join(outputDirectory, "app"), {
    recursive: true,
    errorOnExist: true,
  });
  for (const filename of [
    "launcher.ps1",
    "app-update-worker.ps1",
    "app-update-broker.ps1",
    "TarkovHelper.ico",
    "start-menu.ps1",
    "Tarkov Helper 시작 메뉴 등록.vbs",
    "Tarkov Helper 시작 메뉴 제거.vbs",
    "Tarkov Helper 실행.vbs",
    "Tarkov Helper 종료.vbs",
    "문제 해결용 실행.cmd",
    "Tarkov Helper 상태 복구.cmd",
    "Tarkov Helper 격리 복구 실행.cmd",
    "사용 안내.txt",
  ]) {
    await cp(path.join(portableDirectory, filename), path.join(outputDirectory, filename), {
      errorOnExist: true,
    });
  }
  await writeFile(path.join(outputDirectory, "UPDATE_CONFIG.json"), `${JSON.stringify({
    schemaVersion: 1,
    updaterEnabled: false,
    protocolVersion: 1,
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(outputDirectory, "app", "version.json"), `${JSON.stringify({
    schemaVersion: 1,
    product: "tarkov-helper-web",
    version: packageDocument.version,
    commit: source.commit,
    updaterProtocolVersion: 1,
  }, null, 2)}\n`, "utf8");
  for (const filename of ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"]) {
    await cp(path.join(distDirectory, filename), path.join(outputDirectory, filename), {
      errorOnExist: true,
    });
  }

  const appFiles = await collectFiles(path.join(outputDirectory, "app"));
  const appManifest = manifestText(appFiles);
  const appBytes = appFiles.reduce((total, file) => total + file.size, 0);
  const appTreeHash = createHash("sha256").update(appManifest, "utf8").digest("hex");
  const packageInfo = [
    "Tarkov Helper Web Direct Release",
    `Version: ${packageDocument.version}`,
    `Source commit: ${source.label}`,
    "Updater protocol: 1",
    `App files: ${appFiles.length}`,
    `App bytes: ${appBytes}`,
    `App tree SHA-256: ${appTreeHash}`,
    "Local URL: http://127.0.0.1:41753/",
    "",
  ].join("\n");
  await writeFile(path.join(outputDirectory, "PACKAGE_INFO.txt"), packageInfo, "utf8");

  const packageFiles = await collectFiles(outputDirectory);
  await writeFile(path.join(outputDirectory, "SHA256SUMS.txt"), manifestText(packageFiles), "utf8");
} catch (error) {
  await rm(outputDirectory, { recursive: true, force: true });
  throw error;
}

process.stdout.write(`Direct release created: ${outputDirectory}\n`);
