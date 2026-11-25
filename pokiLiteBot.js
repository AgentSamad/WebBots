/**
 * pokiLiteBot.js — Low-memory Poki Tank Fury bot.
 *
 * Key difference from pokiTankFuryBot.js:
 *   - Takes a shared browser instance (passed from orchestrator).
 *   - Creates a lightweight BrowserContext instead of a full Chromium process.
 *   - Blocks decorative images, fonts, and ad networks on poki.com.
 *   - Saves/restores cookies + localStorage as JSON (no profile directory).
 *
 * Memory per bot: ~80–120 MB (vs ~450 MB with launchPersistentContext).
 */

const path = require('path');
const fs   = require('fs');
const { randomUUID } = require('crypto');

const GAME_URL     = 'https://poki.com/en/g/tank-fury';
const PROFILES_DIR = path.join(__dirname, 'user-profiles');
const REPORTS_DIR  = path.join(__dirname, 'reports');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }
function randF(lo, hi) { return lo + Math.random() * (hi - lo); }

// ── Stealth script injected into every frame ────────────────────────────────

function buildStealthScript(profile) {
  return `(function() {
    // Hide webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });

    // WebGL GPU spoofing (hides SwiftShader)
    const _getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(p) {
      if (p === 37445) return ${JSON.stringify(profile.glVendor   || 'Intel Inc.')};
      if (p === 37446) return ${JSON.stringify(profile.glRenderer || 'Intel Iris OpenGL Engine')};
      return _getParam.call(this, p);
    };
    try {
      const _getParam2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(p) {
        if (p === 37445) return ${JSON.stringify(profile.glVendor   || 'Intel Inc.')};
        if (p === 37446) return ${JSON.stringify(profile.glRenderer || 'Intel Iris OpenGL Engine')};
        return _getParam2.call(this, p);
      };
    } catch(e) {}

    // Per-bot canvas noise so fingerprints differ
    const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
    const _seed = ${profile.id};
    HTMLCanvasElement.prototype.toDataURL = function(...a) {
      try {
        const ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
          const id = ctx.getImageData(0, 0, Math.min(this.width, 8), Math.min(this.height, 8));
          for (let i = 0; i < id.data.length; i += 400) id.data[i] ^= (_seed * 7 + i) & 0xFF;
          ctx.putImageData(id, 0, 0);
        }
      } catch(e) {}
      return _toDataURL.apply(this, a);
    };

    // Poki user identity — fixed per profile so returning visits work
    try {
      if (!localStorage.getItem('poki_events_user_id')) {
        localStorage.setItem('poki_events_user_id', ${JSON.stringify(profile.pokiUserId)});
      }
    } catch(e) {}

    // Skip ad breaks — override PokiSDK when available
    Object.defineProperty(window, 'PokiSDK', {
      configurable: true,
      get() { return this._pokiSDKReal; },
      set(v) {
        if (v && typeof v === 'object') {
          const noop = () => Promise.resolve(true);
          v.commercialBreak = noop;
          v.rewardedBreak   = noop;
        }
        this._pokiSDKReal = v;
      }
    });
  })();`;
}

// ── Human-like mouse movement (Bezier curve) ────────────────────────────────

async function humanMouseMove(page, x1, y1, x2, y2) {
  const steps = rand(12, 22);
  const cx1 = x1 + (x2-x1)*0.25 + randF(-25, 25);
  const cy1 = y1 + (y2-y1)*0.25 + randF(-25, 25);
  const cx2 = x1 + (x2-x1)*0.75 + randF(-25, 25);
  const cy2 = y1 + (y2-y1)*0.75 + randF(-25, 25);
  for (let i = 0; i <= steps; i++) {
    const t = i/steps, mt = 1-t;
    const bx = mt*mt*mt*x1 + 3*mt*mt*t*cx1 + 3*mt*t*t*cx2 + t*t*t*x2;
    const by = mt*mt*mt*y1 + 3*mt*mt*t*cy1 + 3*mt*t*t*cy2 + t*t*t*y2;
    await page.mouse.move(bx + randF(-1,1), by + randF(-1,1));
    await sleep(rand(7, 18));
  }
}

// ── Blocked domains (ads + heavy poki.com assets) ───────────────────────────

const AD_DOMAINS = [
  'doubleclick.net','googlesyndication.com','googleadservices.com','amazon-adsystem.com',
  'adsafeprotected.com','moatads.com','criteo.com','taboola.com','outbrain.com',
  'pubmatic.com','rubiconproject.com','openx.net','appnexus.com','spotxchange.com',
  'adsrvr.org','casalemedia.com','lijit.com','contextweb.com','advertising.com',
  'quantserve.com','scorecard​research.com','imrworldwide.com',
];

function shouldBlock(url) {
  return AD_DOMAINS.some(d => url.includes(d));
}

// ── Main bot function ────────────────────────────────────────────────────────

/**
 * @param {import('playwright').Browser} browser  Shared browser instance.
 * @param {object} profile
 *   id, name, viewport, userAgent, locale, timezone,
 *   glVendor, glRenderer, pokiUserId, playMs
 */
async function runBot(browser, profile) {
  const report = {
    userId: profile.id, userName: profile.name,
    status: 'error', playDurationMs: 0,
    errors: [], isFirstVisit: true,
    startedAt: new Date().toISOString(),
  };

  const startMs = Date.now();
  let context   = null;
  let gameFrame = null;

  const profileDir  = path.join(PROFILES_DIR, `pk-lite-${profile.name}`);
  const cookieFile  = path.join(profileDir, 'cookies.json');
  const storageFile = path.join(profileDir, 'storage.json');
  const isReturn    = fs.existsSync(cookieFile);
  report.isFirstVisit = !isReturn;

  try {
    // ── Create lightweight context ─────────────────────────────────────────
    context = await browser.newContext({
      viewport:    profile.viewport || { width: 1280, height: 720 },
      userAgent:   profile.userAgent,
      locale:      profile.locale    || 'en-US',
      timezoneId:  profile.timezone  || 'America/New_York',
      extraHTTPHeaders: { 'Accept-Language': (profile.locale || 'en-US') + ',en;q=0.9' },
    });

    // Inject stealth into every frame (page + iframes)
    await context.addInitScript(buildStealthScript(profile));

    // Block ads — abort immediately (saves CPU + memory)
    await context.route('**/*', (route) => {
      if (shouldBlock(route.request().url())) {
        route.abort();
      } else {
        route.continue();
      }
    });

    // Restore cookies for returning users
    if (isReturn) {
      try {
        const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
        await context.addCookies(cookies);
      } catch(e) { report.errors.push({ type: 'cookie-load', text: e.message }); }
    }

    const page = await context.newPage();

    // ── Navigate to game ───────────────────────────────────────────────────
    await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await sleep(rand(2000, 4000));

    // Dismiss cookie banners
    for (const sel of ['button:has-text("Accept")', 'button:has-text("Got it")', '[aria-label*="accept" i]']) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) { await btn.click(); await sleep(300); }
      } catch {}
    }

    // ── Wait for game iframe ───────────────────────────────────────────────
    const frameDeadline = Date.now() + 60_000;
    while (!gameFrame && Date.now() < frameDeadline) {
      for (const f of page.frames()) {
        if (f.url().includes('games.poki.com')) { gameFrame = f; break; }
      }
      if (!gameFrame) await sleep(1000);
    }
    if (!gameFrame) throw new Error('Game iframe not found after 60s');

    // ── Wait for canvas ────────────────────────────────────────────────────
    let canvas = null;
    const canvasDeadline = Date.now() + 60_000;
    while (!canvas && Date.now() < canvasDeadline) {
      canvas = await gameFrame.$('canvas').catch(() => null);
      if (!canvas) await sleep(1000);
    }
    if (!canvas) throw new Error('Canvas not found after 60s');

    await sleep(rand(3000, 6000));

    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas has no bounding box');

    // ── Click BATTLE button ────────────────────────────────────────────────
    // Try text selectors first
    let battleClicked = false;
    for (const sel of ['text=BATTLE', 'text=Battle', 'text=PLAY', '[class*="battle"]']) {
      try {
        const el = await gameFrame.$(sel);
        if (el && await el.isVisible()) {
          await el.click();
          battleClicked = true;
          break;
        }
      } catch {}
    }
    if (!battleClicked) {
      // Fallback: click at 50%x, 45%y (battle button position)
      const bx = box.x + box.width * 0.5;
      const by = box.y + box.height * 0.45;
      await humanMouseMove(page, box.x + box.width*0.3, box.y + box.height*0.7, bx, by);
      await page.mouse.click(bx, by);
    }

    await sleep(rand(2000, 4000));

    // Wait for matchmaking to complete (20–40 sec)
    await sleep(rand(20_000, 40_000));

    // ── Gameplay loop ──────────────────────────────────────────────────────
    const playEnd = Date.now() + profile.playMs;
    let roundsCompleted = 0;
    let lastBattleClick = Date.now();

    while (Date.now() < playEnd) {
      try {
        const freshBox = await canvas.boundingBox().catch(() => null) || box;

        // Aim at a random point in the upper-center (enemy area)
        const tx = freshBox.x + freshBox.width  * randF(0.25, 0.75);
        const ty = freshBox.y + freshBox.height * randF(0.1,  0.35);
        await humanMouseMove(page, freshBox.x + freshBox.width/2, freshBox.y + freshBox.height/2, tx, ty);
        await page.mouse.click(tx, ty);
        await sleep(rand(600, 1500));

        // Fire again with slight offset
        await page.mouse.click(tx + randF(-15, 15), ty + randF(-15, 15));
        await sleep(rand(1200, 3000));

        // Re-click battle every ~2 minutes in case a round ended
        if (Date.now() - lastBattleClick > 2 * 60_000) {
          roundsCompleted++;
          const bx2 = freshBox.x + freshBox.width  * 0.5;
          const by2 = freshBox.y + freshBox.height * 0.45;
          await page.mouse.click(bx2, by2);
          await sleep(rand(500, 1200));
          lastBattleClick = Date.now();
        }
      } catch(e) {
        report.errors.push({ type: 'gameplay', text: e.message.slice(0, 120) });
        await sleep(2000);
      }
    }

    report.playDurationMs = Date.now() - startMs;
    report.status = 'completed';
    report.roundsCompleted = roundsCompleted;

    // ── Persist cookies + poki_events_user_id for returning visits ────────
    try {
      if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

      // Save cookies
      const cookies = await context.cookies();
      fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));

      // Save the actual poki_events_user_id Poki gave the iframe (may differ from injected)
      const userIdFile = path.join(profileDir, 'poki_user_id.txt');
      if (gameFrame) {
        const lsId = await gameFrame.evaluate(() => localStorage.getItem('poki_events_user_id')).catch(() => null);
        if (lsId) fs.writeFileSync(userIdFile, lsId);
      }
    } catch(e) { /* non-fatal */ }

  } catch(e) {
    report.errors.push({ type: 'fatal', text: e.message });
    report.playDurationMs = Date.now() - startMs;
  } finally {
    try { if (context) await context.close(); } catch {}
  }

  return report;
}

module.exports = { runBot };
