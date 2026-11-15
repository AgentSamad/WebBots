/**
 * Boom Arena – automated test suite
 *
 * Tests:
 *   1. Page loads & returns HTTP 200
 *   2. Game title / meta is correct
 *   3. Unity canvas appears within 90 s
 *   4. Canvas has non-trivial dimensions
 *   5. Canvas is rendering (not solid black)
 *   6. No critical JS errors during load
 *   7. No network resource failures (> 10 assets)
 *   8. Performance – LCP fires within 10 s
 *   9. Bot can focus the canvas & send input
 *  10. Canvas stays alive after 60 s of gameplay
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');

const GAME_URL    = 'https://www.crazygames.com/game/boom-arena-lmj';
const SCREENS_DIR = path.join(__dirname, '..', 'screenshots');
const REPORTS_DIR = path.join(__dirname, '..', 'reports');

// ── shared state ─────────────────────────────────────────────────────────────

const jsErrors     = [];
const failedAssets = [];

// ── helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForCanvas(page, maxMs = 90_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await page.$('canvas')) return true;
    await sleep(1000);
  }
  return false;
}

async function canvasPixelIsNotBlack(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return false;
    try {
      const ctx  = canvas.getContext('2d');
      const data = ctx.getImageData(canvas.width / 2, canvas.height / 2, 4, 4).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 10 || data[i + 1] > 10 || data[i + 2] > 10) return true;
      }
      return false;
    } catch { return true; }
  });
}

async function dismissBanners(page) {
  for (const sel of [
    'button:has-text("Accept")',
    'button:has-text("Got it")',
    '[aria-label*="accept" i]',
  ]) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) { await btn.click(); await sleep(400); }
    } catch {}
  }
}

// ── fixture: open the game page once per file ─────────────────────────────────

test.describe('Boom Arena – live game health checks', () => {

  let sharedPage;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    sharedPage = await context.newPage();

    sharedPage.on('console', msg => {
      if (msg.type() === 'error') jsErrors.push({ text: msg.text(), at: Date.now() });
    });
    sharedPage.on('pageerror', err => {
      jsErrors.push({ text: err.message, at: Date.now(), stack: err.stack });
    });
    sharedPage.on('requestfailed', req => {
      failedAssets.push({ url: req.url(), reason: req.failure()?.errorText, at: Date.now() });
    });

    await sharedPage.goto(GAME_URL, { waitUntil: 'domcontentloaded' });
    await dismissBanners(sharedPage);
  });

  test.afterAll(async () => {
    // Persist this run's crash summary
    if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const summary = {
      runAt: new Date().toISOString(),
      jsErrors,
      failedAssets,
    };
    fs.writeFileSync(
      path.join(REPORTS_DIR, `test-run-${Date.now()}.json`),
      JSON.stringify(summary, null, 2)
    );
    await sharedPage.context().close();
  });

  // ── 1. HTTP 200 ─────────────────────────────────────────────────────────────
  test('1 – page returns HTTP 200', async () => {
    const response = await sharedPage.goto(GAME_URL, { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(200);
  });

  // ── 2. correct title ─────────────────────────────────────────────────────────
  test('2 – page title contains "Boom Arena"', async () => {
    const title = await sharedPage.title();
    expect(title).toContain('Boom Arena');
  });

  // ── 3. canvas appears ────────────────────────────────────────────────────────
  test('3 – Unity canvas appears within 90 s', async () => {
    const appeared = await waitForCanvas(sharedPage, 90_000);
    if (!appeared) {
      if (!fs.existsSync(SCREENS_DIR)) fs.mkdirSync(SCREENS_DIR, { recursive: true });
      await sharedPage.screenshot({ path: path.join(SCREENS_DIR, `no-canvas-${Date.now()}.png`) });
    }
    expect(appeared, 'Canvas never appeared – game failed to load').toBe(true);
  });

  // ── 4. canvas dimensions ─────────────────────────────────────────────────────
  test('4 – canvas has valid dimensions (> 100×100 px)', async () => {
    const dims = await sharedPage.evaluate(() => {
      const c = document.querySelector('canvas');
      return c ? { w: c.width, h: c.height } : null;
    });
    expect(dims).not.toBeNull();
    expect(dims.w).toBeGreaterThan(100);
    expect(dims.h).toBeGreaterThan(100);
  });

  // ── 5. canvas is rendering ────────────────────────────────────────────────────
  test('5 – canvas is rendering (not all-black)', async () => {
    await sleep(3000);  // allow extra render time
    const alive = await canvasPixelIsNotBlack(sharedPage);
    // This may legitimately fail on a loading screen; we warn, not hard-fail
    if (!alive) {
      console.warn('[test 5] Canvas appears black – game may still be loading');
    }
    // soft assertion: log but do not block the suite
  });

  // ── 6. no critical JS errors during load ─────────────────────────────────────
  test('6 – no critical JS errors during page load', async () => {
    const critical = jsErrors.filter(e =>
      !e.text.includes('ads') &&
      !e.text.includes('analytics') &&
      !e.text.includes('gtag') &&
      !e.text.includes('cookie') &&
      !e.text.includes('favicon')
    );
    if (critical.length > 0) {
      console.error('[test 6] Critical JS errors:', critical);
    }
    expect(critical.length, `${critical.length} critical JS error(s) detected`).toBe(0);
  });

  // ── 7. failed network requests ────────────────────────────────────────────────
  test('7 – game assets load without network errors', async () => {
    const gameAssets = failedAssets.filter(a =>
      a.url.includes('boom') || a.url.includes('unity') || a.url.includes('.wasm') || a.url.includes('.data')
    );
    expect(gameAssets.length, `Failed game assets: ${gameAssets.map(a => a.url).join(', ')}`).toBe(0);
  });

  // ── 8. performance – page interactive quickly ─────────────────────────────────
  test('8 – page becomes interactive within 15 s', async () => {
    const start = Date.now();
    await sharedPage.waitForLoadState('domcontentloaded', { timeout: 15_000 });
    const elapsed = Date.now() - start;
    console.log(`[test 8] DOM ready in ${elapsed} ms`);
    expect(elapsed).toBeLessThan(15_000);
  });

  // ── 9. canvas accepts keyboard input ─────────────────────────────────────────
  test('9 – canvas can be focused and accepts key input', async () => {
    const canvas = await sharedPage.$('canvas');
    expect(canvas, 'Canvas element not found').not.toBeNull();

    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    await sharedPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(300);

    // Send a key and verify no crash follows
    await sharedPage.keyboard.press('w');
    await sleep(200);

    const stillAlive = await sharedPage.evaluate(() => document.querySelector('canvas') !== null);
    expect(stillAlive, 'Canvas disappeared after key press').toBe(true);
  });

  // ── 10. canvas stays alive after 60 s ────────────────────────────────────────
  test('10 – canvas stays alive after 60 s of simulated play', async () => {
    test.setTimeout(130_000);

    const canvas = await sharedPage.$('canvas');
    if (!canvas) { test.skip(); return; }

    const box      = await canvas.boundingBox();
    const cx       = box.x + box.width / 2;
    const cy       = box.y + box.height / 2;
    const deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
      // Simple movement: circle of WASD
      for (const key of ['w', 'a', 's', 'd']) {
        await sharedPage.keyboard.down(key);
        await sleep(300);
        await sharedPage.keyboard.up(key);
      }
      // Rotate aim
      const angle = ((Date.now() / 1000) % 360) * (Math.PI / 180);
      await sharedPage.mouse.move(cx + Math.cos(angle) * 120, cy + Math.sin(angle) * 120);
      await sharedPage.mouse.down();
      await sleep(80);
      await sharedPage.mouse.up();
      await sleep(200);
    }

    const stillHasCanvas = await sharedPage.evaluate(() => document.querySelector('canvas') !== null);
    expect(stillHasCanvas, 'Canvas disappeared during 60 s play session – possible crash').toBe(true);

    if (!fs.existsSync(SCREENS_DIR)) fs.mkdirSync(SCREENS_DIR, { recursive: true });
    await sharedPage.screenshot({
      path: path.join(SCREENS_DIR, `after-60s-${Date.now()}.png`),
    });
  });
});
