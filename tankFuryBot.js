/**
 * Tank Fury – single-user gameplay bot.
 * Flow: load game → dismiss banners → click Battle → wait matchmaking → aim+shoot+move
 */

const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

const GAME_URL      = 'https://www.crazygames.com/game/tank-fury-buy';
const HOME_URL      = 'https://www.crazygames.com/';
const REPORTS_DIR   = path.join(__dirname, 'reports');
const SCREENS_DIR   = path.join(__dirname, 'screenshots');
const PROFILES_DIR  = path.join(__dirname, 'user-profiles');
const DEFAULT_PLAY_MS = 25 * 60 * 1000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }

function saveReport(report) {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORTS_DIR, `tf-run-${report.id}.json`), JSON.stringify(report, null, 2));
}

// ── iframe / canvas helpers (same as bot.js) ──────────────────────────────────

async function getGameFrame(page) {
  for (const frame of page.frames()) {
    try {
      const url = frame.url();
      if (url.includes('games.crazygames.com') || url.includes('crazygames.com/game')) {
        if (await frame.$('canvas')) return frame;
      }
    } catch {}
  }
  for (const frame of page.frames()) {
    try { if (await frame.$('canvas')) return frame; } catch {}
  }
  return null;
}

async function canvasIsAlive(page) {
  const frame = await getGameFrame(page) || page;
  return frame.evaluate(() => {
    const c = document.querySelector('canvas');
    return c ? (c.width > 0 && c.height > 0) : false;
  });
}

async function waitForGameLoad(page, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.$('canvas')) { await sleep(2000); return true; }
    for (const frame of page.frames()) {
      try { if (await frame.$('canvas')) { await sleep(2000); return true; } } catch {}
    }
    await sleep(1000);
  }
  return false;
}

async function dismissBanners(page) {
  for (const sel of [
    'button:has-text("Accept")', 'button:has-text("Got it")',
    '[aria-label*="accept" i]', 'button:has-text("Agree")',
    'button:has-text("Continue offline")',
  ]) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) { await btn.click(); await sleep(400); }
    } catch {}
  }
}

async function focusCanvas(page) {
  const frame  = await getGameFrame(page);
  const canvas = frame ? await frame.$('canvas') : await page.$('canvas');
  if (canvas) {
    const box = await canvas.boundingBox();
    if (box) { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await sleep(300); }
  }
}

// ── CTR flow: referrer-based navigation ──────────────────────────────────────
// CrazyGames tracks CTR via HTTP Referer header (which page the user came from).
// Tank Fury doesn't appear in search or category pages, so we simulate the
// referrer by visiting a source page first, then navigating to the game.
//
// Source rotation (matches portal CTR categories):
//   - Homepage  → https://www.crazygames.com/
//   - Tag page  → https://www.crazygames.com/t/battle  (battle tag)
//   - Gamepage  → https://www.crazygames.com/game/tank-stars-online

const CTR_SOURCES = [
  { label: 'homepage', url: 'https://www.crazygames.com/' },
  { label: 'tag-battle', url: 'https://www.crazygames.com/t/battle' },
  { label: 'tag-destroy', url: 'https://www.crazygames.com/t/destroy' },
  { label: 'gamepage', url: 'https://www.crazygames.com/game/tank-stars-online' },
];

async function navigateWithCTR(page, userName, userId = 0) {
  // Pick source deterministically per user so different bots use different origins
  const source = CTR_SOURCES[userId % CTR_SOURCES.length];
  try {
    // 1. Land on source page (browses naturally for a few seconds)
    await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await dismissBanners(page);
    await sleep(rand(2000, 5000)); // human dwell time

    // 2. Scroll a bit to look natural
    await page.evaluate(() => window.scrollBy(0, rand ? rand(200, 600) : 300)).catch(() => {});
    await sleep(rand(500, 1500));

    // 3. Navigate to Tank Fury with source page as HTTP Referer
    //    Playwright's goto referer option sets the Referer request header
    await page.goto(GAME_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
      referer: source.url,
    });

    console.log(`[tf-bot] ${userName} — CTR via ${source.label} (referer set)`);
    return true;
  } catch (err) {
    console.log(`[tf-bot] ${userName} — CTR nav failed (${err.message}), falling back`);
    try {
      await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {}
    return false;
  }
}

// ── Tank Fury specific: click Battle button ───────────────────────────────────

async function clickBattleButton(page) {
  // 1. Try HTML selectors on main page and game frame
  const selectors = [
    'button:has-text("Battle")', 'button:has-text("BATTLE")',
    'button:has-text("Play")',   'button:has-text("PLAY")',
    '[class*="battle" i]',       '[data-action*="battle" i]',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) { await btn.click(); await sleep(500); return true; }
    } catch {}
  }
  const gameFrame = await getGameFrame(page);
  if (gameFrame) {
    for (const sel of selectors) {
      try {
        const btn = await gameFrame.$(sel);
        if (btn && await btn.isVisible()) { await btn.click(); await sleep(500); return true; }
      } catch {}
    }
  }

  // 2. Fallback: click canvas at ~50% x, ~62% y (where Battle/Play is in most menu screens)
  const canvas = gameFrame ? await gameFrame.$('canvas') : await page.$('canvas');
  if (canvas) {
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width * 0.50, box.y + box.height * 0.62);
      await sleep(400);
      return true;
    }
  }
  return false;
}

// ── movement patterns (WASD) ──────────────────────────────────────────────────

const MOVE_PATTERNS = {
  aggressive: [
    { keys: ['w'],      ms: 500 }, { keys: ['w', 'd'], ms: 300 },
    { keys: ['w'],      ms: 500 }, { keys: ['w', 'a'], ms: 300 },
    { keys: ['s'],      ms: 200 },
  ],
  cautious: [
    { keys: ['a'], ms: 600 }, { keys: ['w'], ms: 400 },
    { keys: ['d'], ms: 600 }, { keys: ['s'], ms: 400 },
  ],
  erratic: [
    { keys: ['w', 'a'], ms: 200 }, { keys: ['s', 'd'], ms: 150 },
    { keys: ['a'],      ms: 300 }, { keys: ['w'],      ms: 100 },
    { keys: ['d'],      ms: 250 }, { keys: ['s', 'a'], ms: 180 },
  ],
  circular: [
    { keys: ['w', 'a'], ms: 400 }, { keys: ['w'],      ms: 300 },
    { keys: ['w', 'd'], ms: 400 }, { keys: ['w'],      ms: 300 },
    { keys: ['s', 'd'], ms: 400 }, { keys: ['s'],      ms: 300 },
    { keys: ['s', 'a'], ms: 400 }, { keys: ['s'],      ms: 300 },
  ],
  zigzag: [
    { keys: ['w', 'a'], ms: 350 }, { keys: ['w', 'd'], ms: 350 },
    { keys: ['w', 'a'], ms: 350 }, { keys: ['w', 'd'], ms: 350 },
    { keys: ['s'],      ms: 200 },
  ],
};

async function movementCycle(page, style = 'circular') {
  const moves = MOVE_PATTERNS[style] || MOVE_PATTERNS.circular;
  for (const { keys, ms } of moves) {
    for (const k of keys) await page.keyboard.down(k);
    await sleep(ms);
    for (const k of keys) await page.keyboard.up(k);
    await sleep(30);
  }
}

async function aimAndShoot(page, cx, cy, angle, radius = 180) {
  const rad = angle * Math.PI / 180;
  const tx  = cx + Math.cos(rad) * radius;
  const ty  = cy + Math.sin(rad) * radius;
  await page.mouse.move(tx, ty, { steps: 5 });
  await sleep(80);
  await page.mouse.click(tx, ty);  // shoot
  await sleep(60);
}

// ── main bot run ──────────────────────────────────────────────────────────────

async function runBot(profile = null) {
  const userDataDir = profile
    ? path.join(PROFILES_DIR, profile.name)
    : path.join(PROFILES_DIR, 'TF_single');
  const isReturning = fs.existsSync(userDataDir) && fs.readdirSync(userDataDir).length > 0;
  const playMs  = profile?.playMs ?? DEFAULT_PLAY_MS;
  const userId  = profile?.id    ?? 0;
  const userName = profile?.name ?? 'TF_single';
  const playStyle = profile?.playStyle ?? 'circular';

  const report = {
    id: `${Date.now()}-tf${userId}`,
    userId, userName, playStyle,
    viewport:  profile?.viewport ?? { width: 1280, height: 720 },
    locale:    profile?.locale   ?? 'en-US',
    timezone:  profile?.timezone ?? 'UTC',
    timestamp: new Date().toISOString(),
    status: 'running', errors: [], warnings: [],
    screenshotOnCrash: null,
    gameLoadedOk: false, playDurationMs: 0, canvasHealthChecks: [],
    isFirstVisit: !isReturning, likedGame: false, ctrNavUsed: false,
  };

  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  console.log(`[tf-bot] ${userName} — ${isReturning ? 'returning' : 'first visit'} | play:${Math.round(playMs/60000)}m`);

  let context;
  for (const channel of ['msedge', 'chrome']) {
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        channel,
        headless: true,
        viewport:         profile?.viewport     ?? { width: 1280, height: 720 },
        userAgent:        profile?.userAgent,
        locale:           profile?.locale       ?? 'en-US',
        timezoneId:       profile?.timezone     ?? 'UTC',
        extraHTTPHeaders: profile?.extraHeaders ?? {},
        colorScheme:      'dark',
        args: [
          '--autoplay-policy=no-user-gesture-required',
          '--disable-gpu', '--disable-dev-shm-usage',
          '--disable-background-networking', '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
          '--disable-extensions', '--disable-sync', '--disable-translate',
          '--mute-audio', '--no-first-run', '--metrics-recording-only',
          '--safebrowsing-disable-auto-update', '--js-flags=--max-old-space-size=384',
          '--disable-features=PointerLock',
        ],
        ...(profile?.proxy ? { proxy: { server: profile.proxy } } : {}),
      });
      break;
    } catch {}
  }
  if (!context) {
    report.status = 'error';
    report.errors.push({ type: 'launch', text: 'No usable browser found', at: new Date().toISOString() });
    saveReport(report); return report;
  }

  await context.route('**/*', (route) => {
    const url  = route.request().url();
    const type = route.request().resourceType();
    const blocked =
      type === 'media' ||
      /googletagmanager|google-analytics|doubleclick|googlesyndication|facebook\.net|hotjar|amplitude|mixpanel|segment\.io|clarity\.ms|nexx360|fundingchoicesmessages|adservice|pagead2|analytics\.crazygames|pixel\.facebook|sentry-cdn|cookielaw/.test(url) ||
      (type === 'font' && !/crazygames\.com|games\.crazygames/.test(url));
    if (blocked) return route.abort();
    return route.continue();
  });

  await context.addInitScript(({ colorDepth, hardwareConcurrency }) => {
    Object.defineProperty(screen,    'colorDepth',          { get: () => colorDepth });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => hardwareConcurrency });
    Object.defineProperty(navigator, 'webdriver',           { get: () => false });
  }, {
    colorDepth:          profile?.colorDepth          ?? 24,
    hardwareConcurrency: profile?.hardwareConcurrency ?? 8,
  });

  const page = await context.newPage();
  page.on('console',   msg => { if (msg.type() === 'error' && report.errors.length < 50) report.errors.push({ type: 'console', text: msg.text(), at: new Date().toISOString() }); });
  page.on('pageerror', err => { report.errors.push({ type: 'pageerror', text: err.message, at: new Date().toISOString() }); });

  const startAt = Date.now();

  try {
    // Navigate via referrer source page → game URL (increases CTR)
    const ctrOk = await navigateWithCTR(page, userName, userId);
    report.ctrNavUsed = ctrOk;
    await dismissBanners(page);

    report.gameLoadedOk = await waitForGameLoad(page, 90_000);
    if (!report.gameLoadedOk) {
      report.status = 'load_failed';
      report.errors.push({ type: 'load_timeout', text: 'Canvas never appeared within 90s', at: new Date().toISOString() });
      saveReport(report); await context.close(); return report;
    }

    // Dismiss any connection/offline dialog
    await dismissBanners(page);
    await focusCanvas(page);
    await sleep(1500);

    // Click the Battle button to start matchmaking
    console.log(`[tf-bot] ${userName} — clicking Battle…`);
    await clickBattleButton(page);
    await sleep(1000);
    // Try again in case first click hit a loading screen
    await clickBattleButton(page);

    // Wait for matchmaking to find a match (15-25 s)
    const matchmakingWait = rand(15_000, 25_000);
    console.log(`[tf-bot] ${userName} — waiting ${Math.round(matchmakingWait/1000)}s for matchmaking…`);
    await sleep(matchmakingWait);

    // Get canvas bounding box for aiming
    const gameFrame  = await getGameFrame(page);
    const gameCanvas = gameFrame ? await gameFrame.$('canvas') : await page.$('canvas');
    const canvasBox  = gameCanvas ? await gameCanvas.boundingBox() : null;
    const cx = canvasBox ? canvasBox.x + canvasBox.width  / 2 : page.viewportSize().width  / 2;
    const cy = canvasBox ? canvasBox.y + canvasBox.height / 2 : page.viewportSize().height / 2;

    console.log(`[tf-bot] ${userName} — in match, playing for ${Math.round(playMs/60000)}m`);

    let aimAngle  = (userId * 37) % 360;
    let shootTimer = Date.now();

    while (Date.now() - startAt < playMs) {
      // Canvas health check every 30 s
      const elapsed = Date.now() - startAt;
      if (elapsed > 0 && elapsed % 30_000 < 600) {
        const alive = await canvasIsAlive(page);
        report.canvasHealthChecks.push({ alive, at: new Date().toISOString() });
        if (!alive) report.errors.push({ type: 'canvas_dead', text: 'Canvas frozen', at: new Date().toISOString() });
      }

      // Move tank
      await movementCycle(page, playStyle);

      // Aim and shoot (every ~1.5 s, sweep around)
      if (Date.now() - shootTimer > 1500) {
        await aimAndShoot(page, cx, cy, aimAngle, rand(120, 220));
        aimAngle = (aimAngle + rand(45, 90)) % 360;
        // Burst: fire 2-3 quick shots
        for (let i = 0; i < rand(1, 2); i++) {
          await aimAndShoot(page, cx, cy, (aimAngle + rand(-30, 30)) % 360, rand(100, 200));
        }
        shootTimer = Date.now();
      }

      await sleep(80);
    }

    report.status       = 'completed';
    report.playDurationMs = Date.now() - startAt;
    console.log(`[tf-bot] ${userName} — done | ${Math.round(report.playDurationMs/60000)}m played`);

  } catch (err) {
    report.status = 'error';
    report.errors.push({ type: 'bot_error', text: err.message, at: new Date().toISOString() });
    try {
      if (!fs.existsSync(SCREENS_DIR)) fs.mkdirSync(SCREENS_DIR, { recursive: true });
      await page.screenshot({ path: path.join(SCREENS_DIR, `tf-error-${report.id}.png`) }).catch(() => {});
    } catch {}
  } finally {
    await context.close().catch(() => {});
    saveReport(report);
  }

  return report;
}

if (require.main === module) {
  runBot(null).then(r => {
    console.log(`[tf-bot] Done → ${r.status} | play:${Math.round(r.playDurationMs/60000)}m`);
    process.exit(r.status === 'completed' ? 0 : 1);
  }).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runBot };
