import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultSource = path.join(projectRoot, "portable", "windows-launcher", "TarkovHelperLauncher.cs");
const defaultManifest = path.join(projectRoot, "portable", "windows-launcher", "TarkovHelperLauncher.manifest");
const defaultIcon = path.join(projectRoot, "portable", "TarkovHelper.ico");
const PINNED_DOTNET_SDK = "10.0.301";

function requireRange(contents, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > contents.length) {
    throw new Error(`${label} exceeds the launcher PE bounds`);
  }
}

function readUInt16(contents, offset, label) {
  requireRange(contents, offset, 2, label);
  return contents.readUInt16LE(offset);
}

function readUInt32(contents, offset, label) {
  requireRange(contents, offset, 4, label);
  return contents.readUInt32LE(offset);
}

function mapRva(contents, sectionTableOffset, sectionCount, rva) {
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTableOffset + (index * 40);
    requireRange(contents, offset, 40, "PE section table");
    const virtualSize = readUInt32(contents, offset + 8, "PE section virtual size");
    const virtualAddress = readUInt32(contents, offset + 12, "PE section virtual address");
    const rawSize = readUInt32(contents, offset + 16, "PE section raw size");
    const rawOffset = readUInt32(contents, offset + 20, "PE section raw offset");
    if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
      const mapped = rawOffset + (rva - virtualAddress);
      requireRange(contents, mapped, 1, "PE mapped RVA");
      return mapped;
    }
  }
  throw new Error(`Launcher PE RVA 0x${rva.toString(16)} is not mapped by a section`);
}

function resourceDirectoryEntries(contents, directoryOffset, label) {
  requireRange(contents, directoryOffset, 16, label);
  const count = readUInt16(contents, directoryOffset + 12, `${label} named count`) +
    readUInt16(contents, directoryOffset + 14, `${label} ID count`);
  requireRange(contents, directoryOffset + 16, count * 8, `${label} entries`);
  return Array.from({ length: count }, (_, index) => {
    const entryOffset = directoryOffset + 16 + (index * 8);
    return {
      nameOrId: readUInt32(contents, entryOffset, `${label} entry name`),
      target: readUInt32(contents, entryOffset + 4, `${label} entry target`),
    };
  });
}

function resourceData(contents, resourceOffset, sectionTableOffset, sectionCount, rootEntry, label) {
  let target = rootEntry.target;
  for (let depth = 0; depth < 2; depth += 1) {
    if ((target & 0x80000000) === 0) throw new Error(`${label} level ${depth} is not a resource directory`);
    const entries = resourceDirectoryEntries(contents, resourceOffset + (target & 0x7fffffff), `${label} level ${depth}`);
    if (entries.length === 0) throw new Error(`${label} level ${depth} is empty`);
    target = entries[0].target;
  }
  if ((target & 0x80000000) !== 0) throw new Error(`${label} language entry is not resource data`);
  const dataEntryOffset = resourceOffset + target;
  const dataRva = readUInt32(contents, dataEntryOffset, `${label} data RVA`);
  const dataSize = readUInt32(contents, dataEntryOffset + 4, `${label} data size`);
  const dataOffset = mapRva(contents, sectionTableOffset, sectionCount, dataRva);
  requireRange(contents, dataOffset, dataSize, `${label} data`);
  return contents.subarray(dataOffset, dataOffset + dataSize);
}

function fixedVersion(resource, label) {
  const signature = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);
  const offset = resource.indexOf(signature);
  if (offset < 0) throw new Error(`${label} is missing VS_FIXEDFILEINFO`);
  requireRange(resource, offset, 24, `${label} VS_FIXEDFILEINFO`);
  const dotted = (most, least) => [most >>> 16, most & 0xffff, least >>> 16, least & 0xffff].join(".");
  return {
    file: dotted(resource.readUInt32LE(offset + 8), resource.readUInt32LE(offset + 12)),
    product: dotted(resource.readUInt32LE(offset + 16), resource.readUInt32LE(offset + 20)),
  };
}

export function inspectWindowsLauncher(contents, expectedVersion) {
  if (!Buffer.isBuffer(contents)) throw new TypeError("Launcher PE contents must be a Buffer");
  requireRange(contents, 0, 64, "Launcher DOS header");
  if (contents.subarray(0, 2).toString("ascii") !== "MZ") throw new Error("Launcher is missing the MZ header");
  const peOffset = readUInt32(contents, 0x3c, "Launcher PE offset");
  requireRange(contents, peOffset, 24, "Launcher PE header");
  if (!contents.subarray(peOffset, peOffset + 4).equals(Buffer.from("PE\0\0", "binary"))) {
    throw new Error("Launcher is missing the PE signature");
  }
  const coffOffset = peOffset + 4;
  const sectionCount = readUInt16(contents, coffOffset + 2, "Launcher section count");
  const optionalHeaderSize = readUInt16(contents, coffOffset + 16, "Launcher optional header size");
  const characteristics = readUInt16(contents, coffOffset + 18, "Launcher characteristics");
  if ((characteristics & 0x0002) === 0) throw new Error("Launcher PE is not marked executable");
  const optionalOffset = coffOffset + 20;
  requireRange(contents, optionalOffset, optionalHeaderSize, "Launcher optional header");
  if (readUInt16(contents, optionalOffset, "Launcher optional header magic") !== 0x10b) {
    throw new Error("Launcher must be a PE32 image");
  }
  const subsystem = readUInt16(contents, optionalOffset + 68, "Launcher subsystem");
  if (subsystem !== 2) throw new Error("Launcher must use the Windows GUI subsystem");
  const resourceRva = readUInt32(contents, optionalOffset + 112, "Launcher resource RVA");
  const resourceSize = readUInt32(contents, optionalOffset + 116, "Launcher resource size");
  if (resourceRva === 0 || resourceSize === 0) throw new Error("Launcher has no PE resource directory");
  const sectionTableOffset = optionalOffset + optionalHeaderSize;
  const resourceOffset = mapRva(contents, sectionTableOffset, sectionCount, resourceRva);
  const rootEntries = resourceDirectoryEntries(contents, resourceOffset, "Launcher resource root");
  const byId = new Map(rootEntries
    .filter((entry) => (entry.nameOrId & 0x80000000) === 0)
    .map((entry) => [entry.nameOrId, entry]));
  for (const [typeId, name] of [[3, "RT_ICON"], [14, "RT_GROUP_ICON"], [16, "RT_VERSION"], [24, "RT_MANIFEST"]]) {
    if (!byId.has(typeId)) throw new Error(`Launcher is missing ${name}`);
  }
  const version = fixedVersion(resourceData(contents, resourceOffset, sectionTableOffset, sectionCount, byId.get(16), "RT_VERSION"), "RT_VERSION");
  if (expectedVersion) {
    const normalized = `${expectedVersion}.0`;
    if (version.file !== normalized || version.product !== normalized) {
      throw new Error(`Launcher version mismatch: expected ${normalized}, received ${version.file}/${version.product}`);
    }
  }
  const manifest = resourceData(contents, resourceOffset, sectionTableOffset, sectionCount, byId.get(24), "RT_MANIFEST")
    .toString("utf8")
    .replace(/^\uFEFF/, "");
  if (!/requestedExecutionLevel\s+level="asInvoker"\s+uiAccess="false"/.test(manifest)) {
    throw new Error("Launcher manifest must request asInvoker without UIAccess");
  }
  return { fileVersion: version.file, productVersion: version.product, resourceTypeIds: [...byId.keys()], subsystem };
}

async function regularFile(filename, label) {
  const details = await stat(filename).catch(() => null);
  if (!details?.isFile()) throw new Error(`${label} is missing: ${filename}`);
}

function findDotnetCompiler() {
  const dotnet = process.env.DOTNET_HOST_PATH || "dotnet.exe";
  const listed = spawnSync(dotnet, ["--list-sdks"], { encoding: "utf8", windowsHide: true });
  if (listed.error || listed.status !== 0) {
    throw new Error(`Unable to list installed .NET SDKs: ${listed.error?.message ?? listed.stderr ?? listed.status}`);
  }
  const sdks = listed.stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^(\S+)\s+\[(.+)]$/.exec(line.trim());
    return match ? [{ version: match[1], root: match[2] }] : [];
  });
  const sdk = sdks.find((sdk) => sdk.version === PINNED_DOTNET_SDK);
  if (!sdk) {
    const installed = sdks.length > 0 ? sdks.map((candidate) => candidate.version).join(", ") : "none";
    throw new Error(`Required .NET SDK ${PINNED_DOTNET_SDK} is not installed (installed: ${installed})`);
  }
  return { dotnet, compiler: path.join(sdk.root, sdk.version, "Roslyn", "bincore", "csc.dll") };
}

function frameworkReferences() {
  const windows = process.env.WINDIR || process.env.SystemRoot;
  if (!windows) throw new Error("The Windows directory is unavailable");
  for (const framework of ["Framework64", "Framework"]) {
    const root = path.join(windows, "Microsoft.NET", framework, "v4.0.30319");
    const mscorlib = path.join(root, "mscorlib.dll");
    const system = path.join(root, "System.dll");
    if (existsSync(mscorlib) && existsSync(system)) return { mscorlib, system };
  }
  throw new Error(".NET Framework 4 reference assemblies are unavailable");
}

function parseArguments(argv) {
  const values = {};
  const options = new Map([
    ["--source", "source"],
    ["--manifest", "manifest"],
    ["--icon", "icon"],
    ["--output", "output"],
    ["--version", "version"],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = options.get(argv[index]);
    const value = argv[index + 1];
    if (!key || !value) throw new Error(`Unknown or incomplete launcher build argument: ${argv[index] ?? "<missing>"}`);
    if (values[key] !== undefined) throw new Error(`Duplicate launcher build argument: ${argv[index]}`);
    values[key] = value;
  }
  if (!values.output || !values.version) throw new Error("--output and --version are required");
  values.source ??= defaultSource;
  values.manifest ??= defaultManifest;
  values.icon ??= defaultIcon;
  return values;
}

export async function buildWindowsLauncher({ source = defaultSource, manifest = defaultManifest, icon = defaultIcon, output, version }) {
  if (process.platform !== "win32") throw new Error("The Windows launcher can only be built on Windows");
  if (!output || path.extname(output).toLowerCase() !== ".exe") throw new Error("Launcher output must be an .exe file");
  if (typeof version !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    throw new Error("Launcher version must be a stable three-part semantic version");
  }
  await Promise.all([
    regularFile(source, "Launcher source"),
    regularFile(manifest, "Launcher manifest"),
    regularFile(icon, "Launcher icon"),
  ]);
  await access(output).then(
    () => { throw new Error(`Launcher output already exists: ${output}`); },
    (error) => { if (error?.code !== "ENOENT") throw error; },
  );
  const { dotnet, compiler } = findDotnetCompiler();
  await regularFile(compiler, ".NET Roslyn compiler");
  const references = frameworkReferences();
  await Promise.all([
    regularFile(references.mscorlib, ".NET Framework mscorlib"),
    regularFile(references.system, ".NET Framework System"),
  ]);

  const temporary = await mkdtemp(path.join(os.tmpdir(), "tarkov-helper-launcher-build-"));
  try {
    const assemblyInfo = path.join(temporary, "AssemblyInfo.cs");
    const fourPartVersion = `${version}.0`;
    await writeFile(assemblyInfo, [
      "using System.Reflection;",
      "[assembly: AssemblyTitle(\"Tarkov Helper\")]",
      "[assembly: AssemblyDescription(\"Tarkov Helper portable launcher\")]",
      "[assembly: AssemblyCompany(\"Tarkov Helper\")]",
      "[assembly: AssemblyProduct(\"Tarkov Helper\")]",
      `[assembly: AssemblyVersion("${fourPartVersion}")]`,
      `[assembly: AssemblyFileVersion("${fourPartVersion}")]`,
      `[assembly: AssemblyInformationalVersion("${version}")]`,
      "",
    ].join("\n"), "utf8");
    await mkdir(path.dirname(output), { recursive: true });
    const pathMap = `${path.dirname(path.resolve(source))}=/_/launcher,${temporary}=/_/generated`;
    const result = spawnSync(dotnet, [
      compiler,
      "/nologo",
      "/noconfig",
      "/nostdlib+",
      "/deterministic+",
      "/optimize+",
      "/debug-",
      "/target:winexe",
      "/platform:anycpu",
      "/warn:4",
      "/warnaserror+",
      "/langversion:7.3",
      "/codepage:65001",
      `/pathmap:${pathMap}`,
      `/win32icon:${path.resolve(icon)}`,
      `/win32manifest:${path.resolve(manifest)}`,
      `/out:${path.resolve(output)}`,
      `/reference:${references.mscorlib}`,
      `/reference:${references.system}`,
      path.resolve(source),
      assemblyInfo,
    ], {
      cwd: path.dirname(path.resolve(source)),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Windows launcher compilation failed: ${result.error?.message ?? result.stderr ?? result.stdout ?? result.status}`);
    }
    const contents = await readFile(output);
    inspectWindowsLauncher(contents, version);
    return { bytes: contents.length, output: path.resolve(output) };
  } catch (error) {
    await rm(output, { force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const options = parseArguments(process.argv.slice(2));
  const result = await buildWindowsLauncher(options);
  process.stdout.write(`Windows launcher built: ${result.output} (${result.bytes} bytes)\n`);
}
