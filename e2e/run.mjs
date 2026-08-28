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

function isExpectedHostedBridgeProbe(pathname) {
  return pathname.startsWith("/api/v1/local-tracker/") ||
    pathname.startsWith("/api/v1/item-prices/") ||
    pathname === "/api/v1/native-overlay/session" ||
    pathname === "/api/v1/client/session" ||
    pathname === "/api/v1/app-update/session";
}

function isAllowedExternalAsset(url) {
  return url.protocol === "https:" && (
    url.hostname === "static.wikia.nocookie.net" ||
    url.hostname === "assets.tarkov.dev"
  );
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

async function assertWeaponModdingDesktopLayout(page) {
  const geometry = await page.evaluate(() => {
    const picker = globalThis.document.querySelector(".modding-part-picker");
    const stage = globalThis.document.querySelector(".modding-weapon-stage");
    const installed = globalThis.document.querySelector(".modding-installed-parts");
    const image = globalThis.document.querySelector(".modding-weapon-image");
    const priceSummary = globalThis.document.querySelector(".modding-build-price-summary");
    const stats = globalThis.document.querySelector(".modding-stats");
    const candidateList = globalThis.document.querySelector(".modding-part-list");
    const candidateRows = [
      ...globalThis.document.querySelectorAll(".modding-part-row"),
    ];
    const candidate = candidateRows.find(
      (row) => row.querySelector(".modding-part-performance"),
    ) ?? candidateRows[0];
    const pricedCandidate = candidateRows.find((row) => {
      const trader = row.querySelector('[data-price-kind="trader"]');
      const flea = row.querySelector('[data-price-kind="flea"]');
      return trader?.getAttribute("data-empty") !== "true" &&
        flea?.getAttribute("data-empty") !== "true";
    });
    const candidatePreview = candidate?.querySelector(".modding-part-preview");
    const candidateImage = candidate?.querySelector(".modding-part-image");
    const candidateDetails = candidate?.querySelector(".modding-part-details");
    const candidateName = candidate?.querySelector(".modding-part-name");
    const candidateSummary = candidate?.querySelector(".modding-part-summary");
    const candidateShortName = candidateSummary?.querySelector("small");
    const candidatePerformance = candidateSummary?.querySelector(".modding-part-performance");
    const candidateCommerce = candidate?.querySelector(".modding-part-commerce");
    const traderCell = pricedCandidate?.querySelector('[data-price-kind="trader"]');
    const fleaCell = pricedCandidate?.querySelector('[data-price-kind="flea"]');
    const traderValue = traderCell?.querySelector(".modding-price-value");
    const fleaValue = fleaCell?.querySelector(".modding-price-value");
    const installedPartName = installed.querySelector(".modding-slot-select strong");
    if (![picker, stage, installed, image, priceSummary, stats, candidateList, candidate,
      candidatePreview, candidateImage,
      candidateDetails, candidateName, candidateSummary, candidateShortName,
      candidatePerformance, candidateCommerce, traderCell, fleaCell, traderValue,
      fleaValue, installedPartName].every(
      (element) => element instanceof globalThis.HTMLElement,
    )) return null;
    const rect = (element) => element.getBoundingClientRect();
    const listRect = rect(candidateList);
    const nameStyle = globalThis.getComputedStyle(candidateName);
    const installedNameStyle = globalThis.getComputedStyle(installedPartName);
    const fullyVisibleRows = candidateRows.filter((row) => {
      const rowRect = rect(row);
      return rowRect.top >= listRect.top - 1 && rowRect.bottom <= listRect.bottom + 1;
    }).length;
    return {
      picker: rect(picker),
      stage: rect(stage),
      installed: rect(installed),
      image: rect(image),
      priceSummary: rect(priceSummary),
      stats: rect(stats),
      candidate: rect(candidate),
      candidatePreview: rect(candidatePreview),
      candidateImage: rect(candidateImage),
      candidateDetails: rect(candidateDetails),
      candidateName: rect(candidateName),
      candidateSummary: rect(candidateSummary),
      candidateShortName: rect(candidateShortName),
      candidatePerformance: rect(candidatePerformance),
      candidateCommerce: rect(candidateCommerce),
      fullyVisibleRows,
      priceCellsInOrder: Boolean(
        traderCell.compareDocumentPosition(fleaCell) &
          globalThis.Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      priceValueOffset: Math.abs(rect(traderValue).top - rect(fleaValue).top),
      candidateNameWhiteSpace: nameStyle.whiteSpace,
      candidateNameTextOverflow: nameStyle.textOverflow,
      installedNameWhiteSpace: installedNameStyle.whiteSpace,
      installedNameTextOverflow: installedNameStyle.textOverflow,
    };
  });
  assert(geometry, "Weapon modding layout elements were unavailable");
  assert(
    geometry.picker.right <= geometry.stage.left + 2 &&
      geometry.stage.right <= geometry.installed.left + 2,
    `Weapon workbench columns are out of order: ${JSON.stringify(geometry)}`,
  );
  assert(
    geometry.priceSummary.top >= geometry.image.bottom - 2 &&
      geometry.stats.top >= geometry.priceSummary.bottom - 2 &&
      Math.abs(geometry.priceSummary.left - geometry.stage.left) <= 2 &&
      Math.abs(geometry.priceSummary.right - geometry.stage.right) <= 2 &&
      Math.abs(geometry.stats.left - geometry.stage.left) <= 2 &&
      Math.abs(geometry.stats.right - geometry.stage.right) <= 2,
    `Build prices and current stats are not below the weapon image in order: ${JSON.stringify(geometry)}`,
  );
  assert(
    geometry.candidatePreview.left < geometry.candidateDetails.left &&
      geometry.candidatePreview.right <= geometry.candidateDetails.left + 2 &&
      geometry.candidateName.top < geometry.candidateSummary.top &&
      Math.abs(geometry.candidateShortName.top - geometry.candidatePerformance.top) <= 4 &&
      geometry.candidateCommerce.top >= geometry.candidateSummary.bottom - 2 &&
      geometry.candidateNameWhiteSpace === "normal" &&
      geometry.candidateNameTextOverflow !== "ellipsis" &&
      geometry.installedNameWhiteSpace === "normal" &&
      geometry.installedNameTextOverflow !== "ellipsis",
    `Compatible part row hierarchy is incorrect: ${JSON.stringify(geometry)}`,
  );
  assert(
    geometry.candidate.height < 96 && geometry.candidatePreview.width <= 60,
    `Compatible part rows are not compact enough: ${JSON.stringify(geometry)}`,
  );
  assert(
    geometry.fullyVisibleRows >= 7,
    `Expected at least seven fully visible part rows: ${JSON.stringify(geometry)}`,
  );
  assert(
    geometry.priceCellsInOrder && geometry.priceValueOffset <= 2,
    `Trader and flea values are out of order or misaligned: ${JSON.stringify(geometry)}`,
  );
}

async function assertWeaponHotspotLabels(page, label) {
  const result = await page.evaluate(() => {
    const container = globalThis.document.querySelector(".modding-weapon-image");
    const buttons = [...globalThis.document.querySelectorAll(".modding-hotspots > button")];
    if (!(container instanceof globalThis.HTMLElement) || !buttons.every(
      (button) => button instanceof globalThis.HTMLElement,
    )) return null;
    const containerRect = container.getBoundingClientRect();
    const rectangles = buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        name: button.textContent?.replace(/\s+/g, " ").trim() ?? "unknown",
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
    });
    const clipped = rectangles.filter((rect) =>
      rect.left < containerRect.left - 1 || rect.right > containerRect.right + 1 ||
      rect.top < containerRect.top - 1 || rect.bottom > containerRect.bottom + 1,
    ).map((rect) => rect.name);
    const overlaps = [];
    for (const [index, rect] of rectangles.entries()) {
      for (const other of rectangles.slice(index + 1)) {
        if (
          rect.left < other.right - 1 && rect.right > other.left + 1 &&
          rect.top < other.bottom - 1 && rect.bottom > other.top + 1
        ) overlaps.push(`${rect.name} <> ${other.name}`);
      }
    }
    return { clipped, overlaps };
  });
  assert(result, `${label}: hotspot labels were unavailable`);
  assert(result.clipped.length === 0, `${label}: clipped hotspot labels: ${result.clipped.join(", ")}`);
  assert(result.overlaps.length === 0, `${label}: overlapping hotspot labels: ${result.overlaps.join(", ")}`);
}

async function assertWeaponModdingTabletLayout(page) {
  const geometry = await page.evaluate(() => {
    const workbench = globalThis.document.querySelector(".modding-workbench");
    const picker = globalThis.document.querySelector(".modding-part-picker");
    const stage = globalThis.document.querySelector(".modding-weapon-stage");
    const installed = globalThis.document.querySelector(".modding-installed-parts");
    if (![workbench, picker, stage, installed].every(
      (element) => element instanceof globalThis.HTMLElement,
    )) return null;
    const rect = (element) => element.getBoundingClientRect();
    return {
      workbench: rect(workbench),
      picker: rect(picker),
      stage: rect(stage),
      installed: rect(installed),
    };
  });
  assert(geometry, "Weapon modding tablet layout elements were unavailable");
  assert(
    geometry.stage.right <= geometry.installed.left + 2 &&
      geometry.picker.top >= Math.max(geometry.stage.bottom, geometry.installed.bottom) - 2 &&
      Math.abs(geometry.picker.left - geometry.workbench.left) <= 2 &&
      Math.abs(geometry.picker.right - geometry.workbench.right) <= 2,
    `Weapon modding tablet layout is incorrect: ${JSON.stringify(geometry)}`,
  );
}

async function assertWeaponModdingStackedLayout(page, label) {
  const geometry = await page.evaluate(() => {
    const picker = globalThis.document.querySelector(".modding-part-picker");
    const stage = globalThis.document.querySelector(".modding-weapon-stage");
    const installed = globalThis.document.querySelector(".modding-installed-parts");
    const image = globalThis.document.querySelector(".modding-weapon-image");
    const priceSummary = globalThis.document.querySelector(".modding-build-price-summary");
    const stats = globalThis.document.querySelector(".modding-stats");
    if (![picker, stage, installed, image, priceSummary, stats].every(
      (element) => element instanceof globalThis.HTMLElement,
    )) return null;
    const rect = (element) => element.getBoundingClientRect();
    return {
      picker: rect(picker),
      stage: rect(stage),
      installed: rect(installed),
      image: rect(image),
      priceSummary: rect(priceSummary),
      stats: rect(stats),
    };
  });
  assert(geometry, `${label}: stacked layout elements were unavailable`);
  assert(
    geometry.priceSummary.top >= geometry.image.bottom - 2 &&
      geometry.stats.top >= geometry.priceSummary.bottom - 2 &&
      geometry.stage.bottom <= geometry.installed.top + 2 &&
      geometry.installed.bottom <= geometry.picker.top + 2,
    `${label}: stacked workbench order is incorrect: ${JSON.stringify(geometry)}`,
  );
}

async function assertMapCentered(page, label) {
  const geometry = await page.evaluate(() => {
    const viewport = globalThis.document.querySelector('[data-testid="map-viewport"]');
    const map = globalThis.document.querySelector("object.map-svg-image");
    if (!(viewport instanceof globalThis.HTMLElement) || !(map instanceof globalThis.HTMLElement)) return null;
    const viewportRect = viewport.getBoundingClientRect();
    const mapRect = map.getBoundingClientRect();
    return {
      viewportCenterX: viewportRect.left + viewportRect.width / 2,
      viewportCenterY: viewportRect.top + viewportRect.height / 2,
      mapCenterX: mapRect.left + mapRect.width / 2,
      mapCenterY: mapRect.top + mapRect.height / 2,
      mapWidth: mapRect.width,
      mapHeight: mapRect.height,
      viewportWidth: viewportRect.width,
      viewportHeight: viewportRect.height,
    };
  });
  assert(geometry, `${label}: map geometry was unavailable`);
  assert(
    Math.abs(geometry.mapCenterX - geometry.viewportCenterX) <= 2 &&
      Math.abs(geometry.mapCenterY - geometry.viewportCenterY) <= 2,
    `${label}: map is not centered: ${JSON.stringify(geometry)}`,
  );
  assert(
    geometry.mapWidth <= geometry.viewportWidth + 2 &&
      geometry.mapHeight <= geometry.viewportHeight + 2,
    `${label}: fitted map exceeds the viewport: ${JSON.stringify(geometry)}`,
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
  let weaponCatalogRequests = 0;

  page.on("console", (message) => {
    const location = message.location();
    const expectedHostedBridgeProbe = message.type() === "error" &&
      location.url !== "" && isExpectedHostedBridgeProbe(new URL(location.url, BASE_URL).pathname);
    if ((message.type() === "error" || message.type() === "warning") && !expectedHostedBridgeProbe) {
      browserErrors.push(
        `${message.type()}: ${message.text()}${location.url ? ` (${location.url}:${location.lineNumber})` : ""}`,
      );
    }
  });
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    const url = new URL(response.url());
    const expectedHostedBridgeProbe = response.status() === 404 && isExpectedHostedBridgeProbe(url.pathname);
    if (response.status() >= 400 && !expectedHostedBridgeProbe) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === BASE_URL && url.pathname.endsWith("/data/weapon-modding/catalog.json")) {
      weaponCatalogRequests += 1;
    }
    if (url.origin !== BASE_URL && !isAllowedExternalAsset(url)) externalRequests.push(request.url());
  });

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  const dataCounts = await page.evaluate(async () => {
    const response = await fetch("./data/tarkov-data.json");
    if (!response.ok) throw new Error(`Unable to load app data: ${response.status}`);
    const data = await response.json();
    return data.meta.counts;
  });
  await page.getByText("TARKOV HELPER", { exact: true }).waitFor();
  assert(await page.getByRole("tab").count() === 7, "Expected seven primary tabs");

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

  await questSearch.fill("Beyond the Red Meat - Part 2");
  await page.getByRole("button", { name: /The Secret Recipe/ }).waitFor();
  await questSearch.fill("The Secret Recipe");
  await page.getByRole("button", { name: /The Secret Recipe/ }).click();
  await page.getByRole("heading", { name: "The Secret Recipe" }).waitFor();
  await page.locator(".quest-detail").getByText(
    "이전 이름: Beyond the Red Meat - Part 2",
    { exact: true },
  ).waitFor();
  assert(
    await page.locator(".quest-detail .quest-objectives > li").count() === 2,
    "The Secret Recipe should expose both current objectives",
  );
  assert(
    await page.getByRole("heading", { name: "선행 퀘스트" }).count() === 0,
    "The Secret Recipe should not retain the removed legacy prerequisite",
  );
  assert(
    await page.getByRole("link", { name: "위키 열기", exact: true }).getAttribute("href") ===
      "https://escapefromtarkov.fandom.com/wiki/The_Secret_Recipe",
    "The Secret Recipe should use the current wiki page",
  );
  await questSearch.fill("");

  await page.getByRole("button", { name: /설정/ }).click();
  const settingsDialog = page.getByRole("dialog", { name: "설정" });
  await settingsDialog.getByRole("button", { name: "데이터" }).click();
  await settingsDialog.getByText(`${dataCounts.quests.toLocaleString()}개`, { exact: true }).waitFor();
  await settingsDialog.getByText(`${dataCounts.items.toLocaleString()}개`, { exact: true }).waitFor();
  await settingsDialog.getByText(`${dataCounts.mapMarkers.toLocaleString()}개`, { exact: true }).waitFor();
  await settingsDialog.getByRole("heading", { name: "진단 기록" }).waitFor();
  await settingsDialog.getByText("저장된 진단 기록이 없습니다.", { exact: true }).waitFor();
  await settingsDialog.getByRole("button", { name: "닫기" }).click();

  await page.getByRole("tab", { name: /은신처/ }).click();
  await page.locator('button[aria-label$="레벨 증가"]').first().click();

  await page.getByRole("tab", { name: /^아이템$/ }).click();
  await page.locator(".item-row button, .item-list button").first().click();
  const inventoryIncrease = page.locator('button[aria-label$="보유량 증가"]').first();
  if (await inventoryIncrease.count()) await inventoryIncrease.click();

  await page.getByRole("tab", { name: /수집가/ }).click();
  await page.getByText(/COLLECTOR|수집가/).first().waitFor();

  await page.getByRole("tab", { name: "시세" }).click();
  const priceSearch = page.getByRole("searchbox", { name: "아이템 시세 검색" });
  await priceSearch.fill("LEDX");
  await page.getByRole("button", { name: /LEDX Skin Transilluminator/ }).click();
  await page.getByRole("article").getByText("LEDX Skin Transilluminator", { exact: true }).waitFor();

  await page.getByRole("tab", { name: "무기 모딩" }).click();
  const weaponSearch = page.getByRole("searchbox", { name: "총기 검색" });
  await weaponSearch.fill("M4A1");
  await page.getByRole("button", { name: /Colt M4A1/ }).click();
  await page.getByRole("heading", { name: /Colt M4A1/ }).waitFor();
  const buildPriceSummary = page.getByRole("region", { name: "빌드 가격 요약" });
  await buildPriceSummary.waitFor();
  assert(
    await buildPriceSummary.getByRole("region", { name: "원본 총기 가격" }).count() === 1 &&
      await buildPriceSummary.getByRole("region", { name: "상인만 부품 가격" }).count() === 1 &&
      await buildPriceSummary.getByRole("region", { name: "플리만 부품 가격" }).count() === 1 &&
      await buildPriceSummary.getByRole("region", { name: "최저가 부품 가격" }).count() === 1 &&
      await buildPriceSummary.getByRole("region", { name: "장착 부품 상인 요구 조건" }).count() === 1,
    "Build price summary is missing a purchase plan or trader requirement section",
  );
  const weaponHotspots = page.getByRole("group", { name: "총기 부위 선택" })
    .getByRole("button");
  assert(
    await weaponHotspots.count() > 6,
    "M4A1 must expose installed-part nested slots as central hotspots",
  );
  await page.getByRole("group", { name: "총기 부위 선택" })
    .getByRole("button", { name: /^권총 손잡이/ })
    .click();
  const compatiblePartList = page.getByRole("list", { name: "호환 부품 목록" });
  await compatiblePartList.getByRole("button").first().waitFor();
  const cqrChoice = compatiblePartList.getByRole("button", { name: /Hera Arms CQR.*장착$/ });
  await cqrChoice.waitFor();
  assert(
    (await cqrChoice.textContent())?.includes("선택 시 자동 해제"),
    "M4A1 combination stock must remain visible with its automatic-removal warning",
  );
  const previewButton = compatiblePartList.getByRole("button", { name: /이미지 크게 보기$/ }).first();
  await previewButton.hover();
  const previewStyles = await previewButton.evaluate((button) => {
    const image = button.querySelector("img");
    return {
      cursor: globalThis.getComputedStyle(button).cursor,
      filter: image ? globalThis.getComputedStyle(image).filter : "none",
    };
  });
  assert(
    previewStyles.cursor === "zoom-in" && previewStyles.filter !== "none",
    `Candidate thumbnail does not signal image zoom: ${JSON.stringify(previewStyles)}`,
  );
  await previewButton.click();
  await page.getByRole("dialog", { name: /이미지$/ }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: /이미지$/ }).waitFor({ state: "detached" });
  assert(
    await previewButton.evaluate((button) => globalThis.document.activeElement === button),
    "Closing a part image preview must restore thumbnail focus",
  );
  await assertWeaponHotspotLabels(page, "weapon modding 1440px viewport");
  await assertWeaponModdingDesktopLayout(page);
  await assertNoHorizontalOverflow(page, "weapon modding desktop");
  await page.screenshot({ path: path.join(OUTPUT_DIRECTORY, "modding-1440.png"), fullPage: true });

  await page.setViewportSize({ width: 1221, height: 800 });
  await assertNoHorizontalOverflow(page, "weapon modding 1221px viewport");
  await assertWeaponHotspotLabels(page, "weapon modding 1221px viewport");

  await page.setViewportSize({ width: 1024, height: 800 });
  await assertNoHorizontalOverflow(page, "weapon modding 1024px viewport");
  await assertWeaponHotspotLabels(page, "weapon modding 1024px viewport");
  await assertWeaponModdingTabletLayout(page);
  await page.screenshot({ path: path.join(OUTPUT_DIRECTORY, "modding-1024.png"), fullPage: true });

  await page.setViewportSize({ width: 861, height: 800 });
  await assertNoHorizontalOverflow(page, "weapon modding 861px viewport");
  await assertWeaponHotspotLabels(page, "weapon modding 861px viewport");

  await page.setViewportSize({ width: 768, height: 800 });
  await assertNoHorizontalOverflow(page, "weapon modding 768px viewport");
  await assertWeaponModdingStackedLayout(page, "weapon modding 768px viewport");
  await page.screenshot({ path: path.join(OUTPUT_DIRECTORY, "modding-768.png"), fullPage: true });

  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByRole("button", { name: "필터·정렬" }).click();
  await page.getByRole("region", { name: "부품 필터와 정렬" }).waitFor();
  await assertNoHorizontalOverflow(page, "weapon modding 320px viewport");
  await assertWeaponModdingStackedLayout(page, "weapon modding 320px viewport");
  assert(
    await page.locator(".modding-hotspots").evaluate((element) =>
      globalThis.getComputedStyle(element).display,
    ) === "none",
    "Weapon hotspots should defer to the slot tree on narrow screens",
  );
  await page.screenshot({ path: path.join(OUTPUT_DIRECTORY, "modding-320.png"), fullPage: true });
  await page.getByRole("button", { name: "필터·정렬" }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  assert(weaponCatalogRequests === 1, `Expected one modding catalog request, got ${weaponCatalogRequests}`);
  await page.getByRole("tab", { name: "아이템" }).click();
  await page.getByRole("tab", { name: "무기 모딩" }).click();
  await page.getByRole("searchbox", { name: "총기 검색" }).waitFor();
  assert(
    weaponCatalogRequests === 1,
    `Modding catalog was requested again after tab re-entry: ${weaponCatalogRequests}`,
  );

  await page.getByRole("tab", { name: /^지도$/ }).click();
  await page.getByRole("combobox", { name: "지도 선택" }).selectOption("Customs");
  await page.waitForFunction(() =>
    globalThis.document.querySelector("object.map-svg-image")?.contentDocument?.getElementById("main"),
  );
  await assertMapCentered(page, "Customs initial fit");
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
