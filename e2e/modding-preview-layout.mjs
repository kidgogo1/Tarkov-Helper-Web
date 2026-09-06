import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// Isolated headless context: never touches the user's browser, stored builds or game.
const executablePath = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(existsSync);
const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-gpu'] });
const output = path.resolve('output/playwright');
await mkdir(output, { recursive: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:41754/#/modding?weapon=5447a9cd4bdc2dbd208b4567');
  await page.getByRole('heading', { name: 'Colt M4A1 5.56x45 돌격소총' }).waitFor();
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const scene = page.locator('.modding-assembly-scene');
    await scene.scrollIntoViewIfNeeded();
    const geometry = await page.evaluate(() => {
      const rect = selector => globalThis.document.querySelector(selector).getBoundingClientRect().toJSON();
      return { scroll: globalThis.document.documentElement.scrollWidth, width: globalThis.innerWidth,
        image: rect('.modding-preview-figure img'), top: rect('.modding-assembly-edge.top'), bottom: rect('.modding-assembly-edge.bottom') };
    });
    assert(geometry.scroll <= width + 1, `Horizontal overflow at ${width}: ${geometry.scroll}`);
    assert(geometry.top.bottom <= geometry.image.top + 1 && geometry.image.bottom <= geometry.bottom.top + 1, `Part cards overlap image at ${width}`);
    await page.screenshot({ path: path.join(output, `modding-preview-${width}.png`) });
    console.log(JSON.stringify({ width, imageHeight: geometry.image.height, overflow: false, cardsOverlap: false }));
  }
  assert.deepEqual(errors, []);
  console.log('No browser runtime errors; external assembly generation was not enabled.');
} finally { await browser.close(); }
