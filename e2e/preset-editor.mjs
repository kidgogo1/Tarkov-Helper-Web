import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// Only an isolated, headless context: user profiles, open browsers and game input are untouched.
const executablePath = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(existsSync);
const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-gpu'] });
const output = path.resolve('output/playwright');
await mkdir(output, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
  const errors = [];
  const previewRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  // UI transport checks use a stub, never a stream of actual external rendering requests.
  await page.route('**/api/modding/preview', async route => {
    previewRequests.push(route.request().postDataJSON());
    await route.fulfill({ json: { imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5LkAAAAASUVORK5CYII=' } });
  });
  await page.goto('http://127.0.0.1:41754/#/modding?weapon=5447a9cd4bdc2dbd208b4567');
  await page.getByRole('heading', { name: 'Colt M4A1 5.56x45 돌격소총' }).waitFor();
  const stats = page.getByRole('table', { name: '기본 총기 대비 성능' });
  const prices = page.getByRole('region', { name: '빌드 가격 요약' });
  const factoryStats = await stats.innerText();
  assert((await prices.innerText()).includes('추가 구매 0개'));
  assert(await page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled());
  await page.getByRole('button', { name: '전체 장착 트리', exact: true }).click();
  await page.locator('.modding-slot-select').filter({ hasText: /^권총 손잡이/ }).click();
  const choice = page.getByRole('button', { name: 'AR-15 Magpul MOE 권총 손잡이 (블랙) 장착', exact: true });
  await choice.click();
  const selectedCard = page.locator('.modding-assembly-slot-card[aria-pressed="true"]');
  assert((await selectedCard.innerText()).includes('MOE AR15'));
  assert((await selectedCard.locator('img').getAttribute('src')).includes('55802f5d4bdc2dac148b458f'));
  assert((await prices.innerText()).includes('추가 구매 1개'));
  const changedStats = await stats.innerText();
  assert.notEqual(changedStats, factoryStats);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  assert.equal(await stats.innerText(), factoryStats);
  assert((await prices.innerText()).includes('추가 구매 0개'));
  await page.getByRole('button', { name: '다시 실행', exact: true }).click();
  assert.equal(await stats.innerText(), changedStats);
  await page.getByRole('textbox', { name: '모딩 이름', exact: true }).fill('E2E 검증용 M4');
  await page.getByRole('button', { name: '새 모딩으로 저장', exact: true }).click();
  await page.getByRole('button', { name: '현재 총기 즐겨찾기 추가', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '기본 구성으로 초기화', exact: true }).click();
  assert.equal(await stats.innerText(), factoryStats);
  await page.getByRole('button', { name: '모딩 불러오기', exact: true }).click();
  assert.equal(await stats.innerText(), changedStats);
  await page.reload();
  await page.getByRole('heading', { name: 'Colt M4A1 5.56x45 돌격소총' }).waitFor();
  assert.equal(await stats.innerText(), changedStats);
  assert(await page.getByRole('button', { name: '현재 총기 즐겨찾기 해제', exact: true }).isVisible());
  assert(await page.getByRole('combobox', { name: '저장한 모딩', exact: true }).getByRole('option', { name: 'E2E 검증용 M4' }).count() === 1);
  assert(await page.getByRole('button', { name: '실행 취소', exact: true }).isDisabled(), 'History is session-local, not a stale persisted undo queue');
  await page.getByRole('button', { name: '전체 장착 트리', exact: true }).click();
  await page.locator('.modding-slot-select').filter({ hasText: /^권총 손잡이/ }).click();

  for (const width of [1920, 1440, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: width < 768 ? 900 : 1200 });
    const editor = page.locator('.modding-preset-editor');
    await editor.evaluate(el => el.scrollIntoView({ block: 'start' }));
    const geometry = await page.evaluate(() => {
      const rect = selector => globalThis.document.querySelector(selector).getBoundingClientRect().toJSON();
      const image = rect('.modding-preview-figure');
      const cards = [...globalThis.document.querySelectorAll('.modding-assembly-slot-card')].map(el => el.getBoundingClientRect().toJSON());
      return { width: globalThis.innerWidth, scrollWidth: globalThis.document.documentElement.scrollWidth,
        image, cards, top: rect('.modding-assembly-edge.top'), bottom: rect('.modding-assembly-edge.bottom') };
    });
    assert(geometry.scrollWidth <= width + 1, `Horizontal overflow at ${width}: ${geometry.scrollWidth}`);
    assert(geometry.cards.length > 0 && geometry.cards.length <= 14);
    assert(geometry.top.bottom <= geometry.image.top + 1 && geometry.image.bottom <= geometry.bottom.top + 1, `Cards cover the gun at ${width}`);
    await page.screenshot({ path: path.join(output, `preset-editor-${width}.png`) });
    if (width <= 1100) {
      await selectedCard.scrollIntoViewIfNeeded();
      await selectedCard.click();
      await page.waitForFunction(() => {
        const rect = globalThis.document.querySelector('.modding-selection-context').getBoundingClientRect();
        return rect.top >= 0 && rect.top < globalThis.innerHeight;
      }, null, { timeout: 2000 });
      const backToSlots = page.getByRole('button', { name: '총기 부위로 돌아가기', exact: true });
      assert.equal(await backToSlots.count(), 1, 'Stacked editing needs a visible return path to the assembly');
      await backToSlots.click();
      assert(await selectedCard.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= globalThis.innerHeight;
      }), 'The selected assembly card must be visible after returning');
    }
    console.log(JSON.stringify({ width, cards: geometry.cards.length, noOverlap: true, noOverflow: true }));
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('slider', { name: '이미지 확대율' }).fill('150');
  assert.equal(await page.locator('.modding-assembly-lines').count(), 0);
  assert.equal(previewRequests.length, 0, '2D enlargement must not make an external request');
  await page.locator('.modding-assembly-scene').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'preset-editor-zoom.png') });
  await page.getByRole('button', { name: '전체 외형 맞춤', exact: true }).click();
  await page.getByRole('button', { name: '총기 이미지 크게 보기', exact: true }).click();
  assert(await page.getByRole('dialog', { name: /크게 보기$/ }).isVisible());
  await page.keyboard.press('Escape');
  assert.equal(previewRequests.length, 0, 'External preview must remain opt-in through editing and enlargement');
  await page.getByRole('checkbox', { name: /조립 외형 자동 갱신/ }).check();
  await page.waitForResponse('**/api/modding/preview');
  assert.equal(previewRequests.length, 1);
  await page.getByRole('slider', { name: '외형 각도' }).fill('90');
  await page.waitForTimeout(1800);
  assert.equal(previewRequests.length, 1, 'Moving the range alone must not request an image');
  await page.getByRole('button', { name: '각도 적용', exact: true }).click();
  await page.waitForResponse('**/api/modding/preview');
  assert.equal(previewRequests[1].angle, 90);
  assert.equal(await page.locator('.modding-assembly-lines').count(), 0, 'Angled images must not show false model-space connectors');
  assert.deepEqual(errors, []);
  console.log('PASS: edit/part thumbnail/stats/extra-only cost/undo/redo/preset/favorites/reload/responsive layout/enlargement/angle opt-in.');
} finally { await browser.close(); }
