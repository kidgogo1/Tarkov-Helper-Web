import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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

function sourceCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unavailable";
  }
}

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
await requireFile(path.join(distDirectory, "LICENSE"));
await requireFile(path.join(distDirectory, "THIRD_PARTY_NOTICES.md"));
await requireFile(path.join(portableDirectory, "launcher.ps1"));
await requireFile(path.join(portableDirectory, "Tarkov Helper 실행.cmd"));
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
  await cp(distDirectory, path.join(outputDirectory, "app"), {
    recursive: true,
    errorOnExist: true,
  });
  for (const filename of ["launcher.ps1", "Tarkov Helper 실행.cmd", "사용 안내.txt"]) {
    await cp(path.join(portableDirectory, filename), path.join(outputDirectory, filename), {
      errorOnExist: true,
    });
  }
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
    `Source commit: ${sourceCommit()}`,
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
