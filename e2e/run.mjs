import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright";
import { preview } from "vite";

const HOST = "127.0.0.1";
const PORT = 4174;
const BASE_URL = `http://${HOST}:${PORT}`;
const OUTPUT_DIRECTORY = path.resolve("output", "playwright");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function browserExecutable() {
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  }
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ]
    : [];
  return candidates.find(existsSync);
}

async function assertNoHorizontalOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: globalThis.document.documentElement.clientWidth,
    scrollWidth: globalThis.document.documentElement.scrollWidth,
  }));
  assert(
    dimensions.scrollWidth <= dimensions.clientWidth + 1,
    `${label}: horizontal overflow ${dimensions.scrollWidth}px > ${dimensions.clientWidth}px`,
  );
}

const server = await preview({
  logLevel: "error",
  preview: { host: HOST, port: PORT, strictPort: true },
});
const executablePath = browserExecutable();
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  headless: true,
});

try {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const browserErrors = [];
  const failedResponses = [];
  const externalRequests = [];

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      const location = message.location();
      browserErrors.push(
        `${message.type()}: ${message.text()}${location.url ? ` (${location.url}:${location.lineNumber})` : ""}`,
      );
    }
  });
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== BASE_URL) externalRequests.push(request.url());
  });

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.getByText("TARKOV HELPER", { exact: true }).waitFor();
  assert(await page.getByRole("tab").count() === 5, "Expected five primary tabs");

  const levelInput = page.locator('input[aria-label="레벨"]');
  assert(await levelInput.inputValue() === "15", "PVP should start at level 15");
  await page.getByRole("button", { name: "레벨 증가" }).click();
  assert(await levelInput.inputValue() === "16", "PVP level change was not applied");
  await page.getByRole("button", { name: "PVE 프로필" }).click();
  assert(await levelInput.inputValue() === "15", "PVE must keep an independent level");
  await page.reload({ waitUntil: "networkidle" });
  assert(
    await page.getByRole("button", { name: "PVE 프로필" }).getAttribute("aria-pressed") === "true",
    "Active profile did not survive refresh",
  );
  await page.getByRole("button", { name: "PVP 프로필" }).click();
  assert(await levelInput.inputValue() === "16", "PVP level did not survive refresh");

  const questSearch = page.getByRole("searchbox", { name: "퀘스트 검색" });
  await page.getByRole("combobox", { name: "상태" }).selectOption("all");
  await questSearch.fill("A Fuel Matter");
  await page.locator(".quest-list button").first().click();
  await page.getByRole("button", { name: "퀘스트 완료" }).click();
  await page.locator(".quest-detail .status-done").waitFor();
  await questSearch.fill("");

  await page.getByRole("button", { name: /설정/ }).click();
  const settingsDialog = page.getByRole("dialog", { name: "설정" });
  await settingsDialog.getByRole("button", { name: "데이터" }).click();
  await settingsDialog.getByText("488개", { exact: true }).waitFor();
  await settingsDialog.getByText("4,014개", { exact: true }).waitFor();
  await settingsDialog.getByText("454개", { exact: true }).waitFor();
  await settingsDialog.getByRole("button", { name: "닫기" }).click();

  await page.getByRole("tab", { name: /은신처/ }).click();
  await page.locator('button[aria-label$="레벨 증가"]').first().click();

  await page.getByRole("tab", { name: /^아이템$/ }).click();
  await page.locator(".item-row button, .item-list button").first().click();
  const inventoryIncrease = page.locator('button[aria-label$="보유량 증가"]').first();
  if (await inventoryIncrease.count()) await inventoryIncrease.click();

  await page.getByRole("tab", { name: /수집가/ }).click();
  await page.getByText(/COLLECTOR|수집가/).first().waitFor();

  await page.getByRole("tab", { name: /^지도$/ }).click();
  await page.getByRole("combobox", { name: "지도 선택" }).selectOption("Customs");
  await page.waitForFunction(() =>
    globalThis.document.querySelector("object.map-svg-image")?.contentDocument?.getElementById("main"),
  );
  await page.getByRole("button", { name: "Basement" }).click();
  const floorLayers = await page.locator("object.map-svg-image").evaluate((element) => ({
    basement: element.contentDocument?.getElementById("basement")?.style.display,
    main: element.contentDocument?.getElementById("main")?.style.display,
    mainOpacity: element.contentDocument?.getElementById("main")?.style.opacity,
    level2: element.contentDocument?.getElementById("level2")?.style.display,
  }));
  assert(
    floorLayers.basement === "inline" &&
      floorLayers.main === "inline" &&
      floorLayers.mainOpacity === "0.15" &&
      floorLayers.level2 === "none",
    `SVG floor visibility is incorrect: ${JSON.stringify(floorLayers)}`,
  );
  await page.getByLabel("스크린샷 파일 선택").setInputFiles({
    name: "2026-08-07[10-20]_100, 1, 200_0, 0.7071068, 0, 0.7071068_16.74.png",
    mimeType: "image/png",
    buffer: Buffer.from([]),
  });
  await page.getByRole("button", { name: /플레이어 위치 X 100.*Y 1.*Z 200/ }).waitFor();
  await page.getByRole("button", { name: "커스텀 마커 추가" }).click();
  const markerDialog = page.getByRole("dialog", { name: "커스텀 마커 추가" });
  await markerDialog.getByRole("textbox", { name: "마커 이름" }).fill("E2E 집결지");
  await markerDialog.getByRole("button", { name: "마커 저장" }).click();
  await page.getByRole("button", { name: "커스텀 마커 E2E 집결지" }).waitFor();
  await page.getByRole("button", { name: "PVE 프로필" }).click();
  assert(
    await page.getByRole("button", { name: "커스텀 마커 E2E 집결지" }).count() === 0,
    "Custom marker leaked into PVE",
  );
  await page.getByRole("button", { name: "PVP 프로필" }).click();
  await page.getByRole("button", { name: "커스텀 마커 E2E 집결지" }).waitFor();
  await page.screenshot({ path: path.join(OUTPUT_DIRECTORY, "map-1440.png"), fullPage: true });

  const breakpoints = [
    [320, 720],
    [768, 900],
    [1024, 768],
    [1440, 900],
  ];
  await page.getByRole("tab", { name: /^퀘스트$/ }).click();
  for (const [width, height] of breakpoints) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    await assertNoHorizontalOverflow(page, `${width}px viewport`);
    await page.screenshot({
      path: path.join(OUTPUT_DIRECTORY, `quests-${width}.png`),
      fullPage: true,
    });
  }

  assert(failedResponses.length === 0, `HTTP failures:\n${failedResponses.join("\n")}`);
  assert(externalRequests.length === 0, `Unexpected external requests:\n${externalRequests.join("\n")}`);
  assert(browserErrors.length === 0, `Browser console errors:\n${browserErrors.join("\n")}`);

  await context.close();
  process.stdout.write(
    `Browser flows passed; screenshots: ${path.relative(process.cwd(), OUTPUT_DIRECTORY)}\n`,
  );
} finally {
  await browser.close();
  await new Promise((resolve, reject) => {
    server.httpServer.close((error) => (error ? reject(error) : resolve()));
  });
}
