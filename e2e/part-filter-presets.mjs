import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// This ephemeral browser never attaches to user profiles or reads their saved data.
// All rendering-service requests are intercepted, including accidental opt-in regressions.
const executablePath = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(existsSync);
const output = path.resolve('output/playwright');
const presetName = 'E2E 저반동 · 상점 5만원';
const recoilOrder = ['반동 감소 큰 순', '인체공학 높은 순'];
const ergonomicsOrder = [...recoilOrder].reverse();
const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-gpu'] });

// The web preview has no portable local bridge. These four observed endpoints
// are a strict subset of e2e/run.mjs probes; other failures and warnings still fail.
function isExpectedHostedBridgeProbe(urlText) {
  if (!urlText) return false;
  const url = new URL(urlText);
  return url.origin === 'http://127.0.0.1:41754' && [
    '/api/v1/local-tracker/status', '/api/v1/native-overlay/session',
    '/api/v1/client/session', '/api/v1/app-update/session',
  ].includes(url.pathname);
}

async function selectMuzzleAndOpenFilters(page) {
  // The CQR grip leads both metrics, so a shared first place there is valid.
  // M4 muzzle candidates have an actual recoil/ergonomics trade-off for this check.
  await page.getByRole('button', { name: '전체 장착 트리', exact: true }).click();
  await page.locator('.modding-slot-select').filter({ hasText: /^총구/ }).first().click();
  await page.getByRole('list', { name: '호환 부품 목록' }).waitFor();
  const toggle = page.getByRole('button', { name: '필터·정렬', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.getByRole('region', { name: '필터 프리셋', exact: true }).waitFor();
}

async function sortPriority(page) {
  return page.locator('.modding-sort-priorities li.enabled label > span').allTextContents();
}

async function candidateNames(page) {
  return page.getByRole('list', { name: '호환 부품 목록' }).locator('.modding-part-name').allTextContents();
}

async function settingsFromControls(page) {
  return {
    query: await page.getByRole('searchbox', { name: '부품 검색', exact: true }).inputValue(),
    traderPrice: await page.getByRole('spinbutton', { name: '최대 상점가 (₽ 환산)', exact: true }).inputValue(),
    fleaPrice: await page.getByRole('spinbutton', { name: '최대 플리 참고가', exact: true }).inputValue(),
    traderPriceRequired: await page.getByRole('checkbox', { name: '상점 가격 있음', exact: true }).isChecked(),
    sortKeys: await sortPriority(page),
  };
}

async function openSavedPresets(page) {
  const details = page.locator('.modding-filter-preset-library');
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
}

try {
  await mkdir(output, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  const consoleProblems = [];
  const failedResponses = [];
  const expectedProbeResponses = new Map();
  const expectedProbeConsoleErrors = new Map();
  let previewRequests = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    const url = message.location().url;
    const expected = message.type() === 'error' && /status of 404/.test(message.text()) && isExpectedHostedBridgeProbe(url);
    if (expected) expectedProbeConsoleErrors.set(url, (expectedProbeConsoleErrors.get(url) ?? 0) + 1);
    if (!expected && (message.type() === 'error' || message.type() === 'warning')) {
      consoleProblems.push({ type: message.type(), text: message.text(), url });
    }
  });
  page.on('response', (response) => {
    if (response.status() === 404 && isExpectedHostedBridgeProbe(response.url())) {
      expectedProbeResponses.set(response.url(), (expectedProbeResponses.get(response.url()) ?? 0) + 1);
    }
    else if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() });
  });
  await context.route('**/api/modding/preview', async (route) => {
    previewRequests += 1;
    await route.fulfill({ status: 503, json: { error: 'External preview is disabled in this isolated test.' } });
  });
  await page.goto('http://127.0.0.1:41754/#/modding?weapon=5447a9cd4bdc2dbd208b4567');
  await page.getByRole('heading', { name: 'Colt M4A1 5.56x45 돌격소총' }).waitFor();
  await selectMuzzleAndOpenFilters(page);
  const recoil = page.getByRole('button', { name: '반동 우선 필터 프리셋 적용', exact: true });
  const ergonomics = page.getByRole('button', { name: '인체공학 우선 필터 프리셋 적용', exact: true });

  await recoil.focus();
  await page.keyboard.press('Enter');
  assert.equal(await recoil.getAttribute('aria-pressed'), 'true', 'A keyboard activation must apply the preset');
  assert.deepEqual(await sortPriority(page), recoilOrder);
  assert.deepEqual(await page.locator('.modding-sort-priorities li.enabled > strong').allTextContents(), ['1순위', '2순위']);
  const recoilCandidates = await candidateNames(page);
  assert(recoilCandidates.length > 1, 'The bundled M4 muzzle data must exercise ordering across multiple candidates');
  await ergonomics.click();
  assert.deepEqual(await sortPriority(page), ergonomicsOrder);
  const ergonomicsCandidates = await candidateNames(page);
  assert.deepEqual([...ergonomicsCandidates].sort(), [...recoilCandidates].sort(), 'The built-in presets sort the same unfiltered candidate set');
  assert.notEqual(ergonomicsCandidates[0], recoilCandidates[0], 'Changing the first priority must change the actual best candidate, not only the priority labels');
  console.log(JSON.stringify({ recoilFirst: recoilCandidates[0], ergonomicsFirst: ergonomicsCandidates[0] }));

  await recoil.click();
  await page.getByRole('searchbox', { name: '부품 검색', exact: true }).fill('AR-15');
  await page.getByRole('spinbutton', { name: '최대 상점가 (₽ 환산)', exact: true }).fill('50000');
  await page.getByRole('spinbutton', { name: '최대 플리 참고가', exact: true }).fill('200000');
  await page.getByRole('checkbox', { name: '상점 가격 있음', exact: true }).check();
  const savedSettings = await settingsFromControls(page);
  assert.deepEqual(savedSettings, { query: 'AR-15', traderPrice: '50000', fleaPrice: '200000', traderPriceRequired: true, sortKeys: recoilOrder });
  const savedCandidates = await candidateNames(page);
  assert(savedCandidates.length > 0 && savedCandidates.length < recoilCandidates.length, 'Saved constraints must meaningfully filter the live candidate list');
  await openSavedPresets(page);
  await page.getByRole('textbox', { name: '필터 프리셋 이름', exact: true }).fill(presetName);
  await page.getByRole('button', { name: '새 필터 프리셋 저장', exact: true }).click();
  const savedSelect = page.getByRole('combobox', { name: '저장한 필터 프리셋', exact: true });
  assert.equal(await savedSelect.getByRole('option', { name: presetName, exact: true }).count(), 1);
  await page.getByRole('button', { name: '필터 초기화', exact: true }).click();
  assert.equal((await settingsFromControls(page)).query, '');
  assert.deepEqual(await sortPriority(page), []);
  await page.getByRole('button', { name: '필터 프리셋 불러오기', exact: true }).click();
  assert.deepEqual(await settingsFromControls(page), savedSettings);
  assert.deepEqual(await candidateNames(page), savedCandidates);

  await page.reload();
  await page.getByRole('heading', { name: 'Colt M4A1 5.56x45 돌격소총' }).waitFor();
  await selectMuzzleAndOpenFilters(page);
  await openSavedPresets(page);
  await savedSelect.selectOption({ label: presetName });
  const load = page.getByRole('button', { name: '필터 프리셋 불러오기', exact: true });
  await load.focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await settingsFromControls(page), savedSettings, 'All saved controls must restore after a full page reload');
  assert.deepEqual(await candidateNames(page), savedCandidates, 'Reloaded saved settings must restore the real filtered order');

  for (const width of [1440, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('.modding-filter-presets').scrollIntoViewIfNeeded();
    const geometry = await page.evaluate(() => {
      const panel = globalThis.document.querySelector('.modding-filter-panel');
      const bounds = panel.getBoundingClientRect();
      const clipped = [...panel.querySelectorAll('button, input, select, summary')].filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1);
      }).map((element) => element.getAttribute('aria-label') || element.textContent?.trim());
      return { scrollWidth: globalThis.document.documentElement.scrollWidth, clipped };
    });
    assert(geometry.scrollWidth <= width + 1, `Horizontal overflow at ${width}px: ${geometry.scrollWidth}`);
    assert.deepEqual(geometry.clipped, [], `Filter controls extend beyond their panel at ${width}px`);
    await page.screenshot({ path: path.join(output, `part-filter-presets-${width}.png`) });
    if (width === 1440) {
      await page.locator('.modding-filter-panel').screenshot({ path: path.join(output, 'part-filter-presets-panel.png') });
      await page.getByRole('region', { name: '정렬 우선순위', exact: true }).scrollIntoViewIfNeeded();
      await page.locator('.modding-filter-panel').screenshot({ path: path.join(output, 'part-filter-presets-priorities.png') });
    }
    console.log(JSON.stringify({ width, noOverflow: true, noClippedControls: true }));
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  await ergonomics.click();
  assert.equal((await settingsFromControls(page)).query, '', 'Built-in presets explicitly clear prior constraints');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '선택 필터 프리셋 덮어쓰기', exact: true }).click();
  await page.getByRole('button', { name: '필터 초기화', exact: true }).click();
  await load.click();
  assert.deepEqual(await sortPriority(page), ergonomicsOrder, 'An explicitly confirmed overwrite must update the stored settings');
  assert.equal((await settingsFromControls(page)).traderPrice, '');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '선택 필터 프리셋 삭제', exact: true }).click();
  assert.equal(await savedSelect.getByRole('option', { name: presetName, exact: true }).count(), 0);
  assert.deepEqual(await sortPriority(page), ergonomicsOrder, 'Deleting a stored preset must preserve the currently applied filters');
  assert.equal(previewRequests, 0, 'Filter presets must never activate the external weapon renderer');
  assert.deepEqual(errors, [], 'The isolated preset flow must not raise browser runtime errors');
  assert.deepEqual(consoleProblems, [], 'The isolated preset flow must not log console errors or warnings');
  assert.deepEqual(failedResponses, [], 'Non-bridge resource and API failures must not be hidden');
  console.log(JSON.stringify({ expectedUnavailableBridgeProbes: [...expectedProbeResponses].map(([url, count]) => ({
    url, status: 404, responseCount: count, consoleCount: expectedProbeConsoleErrors.get(url) ?? 0,
  })), unexpectedConsoleProblems: 0, unexpectedFailedResponses: 0 }));
  console.log('PASS: built-in priority and candidate order, keyboard use, save/reset/load/reload, overwrite/delete, four viewport widths, zero preview requests.');
} finally {
  await browser.close();
}
