import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import { chromium } from "playwright";

const directReleaseRoot = process.env.TARKOV_HELPER_DIRECT_ROOT
  ? path.resolve(process.env.TARKOV_HELPER_DIRECT_ROOT)
  : null;
const appRoot = directReleaseRoot ? path.join(directReleaseRoot, "app") : path.resolve("dist");
const launcherPath = directReleaseRoot
  ? path.join(directReleaseRoot, "launcher.ps1")
  : path.resolve("portable", "launcher.ps1");
const outputDirectory = path.resolve("output", "playwright");
const storageProbeKey = "tarkov-helper-direct-e2e";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function browserExecutable() {
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ]
    : [];
  return process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? candidates.find(existsSync);
}

async function findFirstFile(directory, extensions) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFirstFile(filename, extensions);
      if (nested) return nested;
    } else if (extensions.includes(path.extname(entry.name).toLowerCase())) {
      return filename;
    }
  }
  return null;
}

function encodedAppPath(filename) {
  return path.relative(appRoot, filename).split(path.sep).map(encodeURIComponent).join("/");
}

function startServer() {
  const child = spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath,
      "-Root",
      appRoot,
      "-NoBrowser",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Direct server startup timed out.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 10_000);
    const inspect = () => {
      const match = stdout.match(/TARKOV_HELPER_URL=(http:\/\/127\.0\.0\.1:41753\/)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    };
    child.stdout.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Direct server exited with code ${code}.\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });

  return { child, ready, output: () => ({ stdout, stderr }) };
}

async function stopServer(server) {
  if (server.child.exitCode !== null) return;
  server.child.kill();
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    server.child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

if (process.platform !== "win32") {
  throw new Error("The direct launcher E2E is Windows-only.");
}

let server = startServer();
let browser;

try {
  const baseUrl = await server.ready;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(server.child.exitCode === null, `Direct server did not remain running: ${JSON.stringify(server.output())}`);

  const executablePath = browserExecutable();
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const browserErrors = [];
  const failedResponses = [];
  const externalRequests = [];

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") browserErrors.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(baseUrl).origin) externalRequests.push(request.url());
  });

  const documentResponse = await page.goto(baseUrl, { waitUntil: "networkidle" });
  assert(documentResponse?.status() === 200, "Direct release document did not return HTTP 200");
  assert(documentResponse.headers()["x-frame-options"] === "DENY", "Direct release is missing frame protection");
  await page.getByText("TARKOV HELPER", { exact: true }).waitFor();
  assert(await page.getByRole("tab").count() === 5, "Expected five primary tabs");
  const levelInput = page.locator('input[aria-label="레벨"]');
  const expectedLevel = String(Number(await levelInput.inputValue()) + 1);
  await page.getByRole("button", { name: "레벨 증가" }).click();
  assert(await levelInput.inputValue() === expectedLevel, "Profile level change was not applied");

  const sampleFiles = await Promise.all([
    findFirstFile(appRoot, [".svg"]),
    findFirstFile(appRoot, [".png"]),
    findFirstFile(appRoot, [".webp"]),
  ]);
  assert(sampleFiles.every(Boolean), "The direct release is missing SVG, PNG, or WebP assets");
  const sampleResults = await page.evaluate(async (paths) => Promise.all(paths.map(async (assetPath) => {
    const response = await fetch(assetPath);
    return { path: assetPath, status: response.status, type: response.headers.get("content-type") };
  })), sampleFiles.map(encodedAppPath));
  assert(sampleResults.every((result) => result.status === 200), `Static asset failure: ${JSON.stringify(sampleResults)}`);
  assert(sampleResults[0].type?.startsWith("image/svg+xml"), `Wrong SVG MIME: ${sampleResults[0].type}`);
  assert(sampleResults[1].type === "image/png", `Wrong PNG MIME: ${sampleResults[1].type}`);
  assert(sampleResults[2].type === "image/webp", `Wrong WebP MIME: ${sampleResults[2].type}`);

  await page.getByRole("tab").nth(4).click();
  await page.locator("object.map-svg-image").waitFor();
  await page.waitForFunction(() => Boolean(globalThis.document.querySelector("object.map-svg-image")?.contentDocument?.documentElement));
  await mkdir(outputDirectory, { recursive: true });
  await page.screenshot({ path: path.join(outputDirectory, "direct-release-1440.png"), fullPage: true });

  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [storageProbeKey, "persisted"]);
  await stopServer(server);
  server = startServer();
  const restartedUrl = await server.ready;
  assert(restartedUrl === baseUrl, `Direct release origin changed: ${baseUrl} -> ${restartedUrl}`);
  await page.reload({ waitUntil: "networkidle" });
  assert(await page.evaluate((key) => localStorage.getItem(key), storageProbeKey) === "persisted", "Local storage did not survive server restart");
  assert(await levelInput.inputValue() === expectedLevel, "App progress did not survive direct server restart");
  await page.evaluate((key) => localStorage.removeItem(key), storageProbeKey);

  assert(failedResponses.length === 0, `HTTP failures:\n${failedResponses.join("\n")}`);
  assert(externalRequests.length === 0, `Unexpected external requests:\n${externalRequests.join("\n")}`);
  assert(browserErrors.length === 0, `Browser console errors:\n${browserErrors.join("\n")}`);
  await context.close();
  process.stdout.write(`Direct release browser flow passed: ${baseUrl}\n`);
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}
