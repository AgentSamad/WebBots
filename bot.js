/**
 * Boom Arena – single-user gameplay bot.
 * Accepts an optional user profile to simulate a distinct client.
 * Called directly (node bot.js) for a single run, or required
 * by multiBot.js for parallel multi-user runs.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

const GAME_URL      = 'https://www.crazygames.com/game/boom-arena-lmj';
const REPORTS_DIR   = path.join(__dirname, 'reports');
const SCREENS_DIR   = path.join(__dirname, 'screenshots');
const PROFILES_DIR  = path.join(__dirname, 'user-profiles');  // persistent browser data
const DEFAULT_PLAY_MS = 60 * 60 * 1000;  // 1 hour for single runs

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── report helpers ────────────────────────────────────────────────────────────

function saveReport(report) {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const file = path.join(REPORTS_DIR, `run-${report.id}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
}

// ── iframe / canvas helpers ───────────────────────────────────────────────────

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

async function focusCanvas(page) {
  const frame  = await getGameFrame(page);
  const canvas = frame ? await frame.$('canvas') : await page.$('canvas');
  if (canvas) {
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(300);
    }
  }
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
  ]) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) { await btn.click(); await sleep(400); }
    } catch {}
  }
}

async function likeGame(page) {
  // Try known CrazyGames like-button selectors on the top-level page
  const selectors = [
    '[data-cy="like-button"]',
    'button[aria-label*="like" i]',
    'button[aria-label*="thumbs" i]',
    '[class*="like-button"]',
    '[class*="likeButton"]',
    'button:has([class*="like"])',
    'button:has([class*="thumb"])',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        await sleep(500);
        return true;
      }
    } catch {}
  }
  return false;
}

// ── movement patterns per play style ─────────────────────────────────────────

const MOVE_PATTERNS = {
  aggressive: [
    { keys: ['w'],      ms: 500 }, { keys: ['w', 'd'], ms: 300 },
    { keys: ['w'],      ms: 500 }, { keys: ['w', 'a'], ms: 300 },
    { keys: ['s'],      ms: 200 },
  ],
  cautious: [
    { keys: ['a'],      ms: 600 }, { keys: ['w'],      ms: 400 },
    { keys: ['d'],      ms: 600 }, { keys: ['s'],      ms: 400 },
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

async function sweepAim(page, cx, cy, radius, startAngle, sweepDeg) {
  const steps = Math.floor(sweepDeg / 5);
  for (let i = 0; i <= steps; i++) {
    const a = (startAngle + i * 5) * (Math.PI / 180);
    await page.mouse.move(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    await sleep(25);
  }
}

// ── main bot run ──────────────────────────────────────────────────────────────

async function runBot(profile = null) {
  // First visit uses full playMs (15–25 min).
  // Returning visits use returnPlayMs (~8 min) — the profile directory already exists.
  const userDataDirCheck = profile
    ? path.join(PROFILES_DIR, profile.name)
    : path.join(PROFILES_DIR, 'User_single');
  const isReturning = fs.existsSync(userDataDirCheck) &&
                      fs.readdirSync(userDataDirCheck).length > 0;
  const playMs = isReturning
    ? (profile?.returnPlayMs ?? 8 * 60 * 1000)
    : (profile?.playMs ?? DEFAULT_PLAY_MS);
  const userId = profile?.id ?? 0;
  const userName = profile?.name ?? 'User_single';
  const playStyle = profile?.playStyle ?? 'circular';

  const report = {
    id:                 `${Date.now()}-u${userId}`,
    userId,
    userName,
    playStyle,
    viewport:           profile?.viewport ?? { width: 1280, height: 720 },
    locale:             profile?.locale   ?? 'en-US',
    timezone:           profile?.timezone ?? 'UTC',
    timestamp:          new Date().toISOString(),
    status:             'running',
    errors:             [],
    warnings:           [],
    screenshotOnCrash:  null,
    gameLoadedOk:       false,
    playDurationMs:     0,
    canvasHealthChecks: [],
  };

  // Each user gets their own persistent browser profile directory.
  // On the first visit cookies/localStorage are saved; every subsequent
  // run loads that same profile — CrazyGames sees a returning user.
  const userDataDir = profile
    ? path.join(PROFILES_DIR, profile.name)
    : path.join(PROFILES_DIR, 'User_single');

  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  const isFirstVisit = !isReturning;
  report.isFirstVisit = isFirstVisit;
  if (isReturning) {
    console.log(`[bot] ${report.userName} — returning user | play:${Math.round(playMs/60000)}m | proxy:${profile?.proxy ?? 'none'}`);
  } else {
    console.log(`[bot] ${report.userName} — first visit | play:${Math.round(playMs/60000)}m | proxy:${profile?.proxy ?? 'none'}`);
  }

  // launchPersistentContext keeps cookies + localStorage between runs
  let context;
  for (const channel of ['msedge', 'chrome']) {
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        channel,
        headless: true,
        viewport:         profile?.viewport      ?? { width: 960, height: 540 },
        userAgent:        profile?.userAgent,
        locale:           profile?.locale        ?? 'en-US',
        timezoneId:       profile?.timezone      ?? 'UTC',
        extraHTTPHeaders: profile?.extraHeaders  ?? {},
        colorScheme:      'dark',
        args: [
          '--autoplay-policy=no-user-gesture-required',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-extensions',
          '--disable-sync',
          '--disable-translate',
          '--disable-plugins',
          '--mute-audio',
          '--no-first-run',
          '--metrics-recording-only',
          '--safebrowsing-disable-auto-update',
          '--js-flags=--max-old-space-size=384',
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
    saveReport(report);
    return report;
  }

  // Block trackers, ads, analytics and external fonts — game canvas doesn't need them
  await context.route('**/*', (route) => {
    const url = route.request().url();
    const type = route.request().resourceType();
    const blocked =
      type === 'media' ||
      /googletagmanager|google-analytics|doubleclick|googlesyndication|facebook\.net|hotjar|amplitude|mixpanel|segment\.io|clarity\.ms|nexx360|fundingchoicesmessages|adservice|pagead2|analytics\.crazygames|pixel\.facebook|sentry-cdn|cookielaw/.test(url) ||
      (type === 'font' && !/crazygames\.com|games\.crazygames/.test(url));
    if (blocked) return route.abort();
    return route.continue();
  });

  // Spoof hardware fingerprint on every page load
  await context.addInitScript(({ colorDepth, hardwareConcurrency }) => {
    Object.defineProperty(screen,    'colorDepth',          { get: () => colorDepth });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => hardwareConcurrency });
    // Hide webdriver flag so the site doesn't see automation
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  }, {
    colorDepth:          profile?.colorDepth          ?? 24,
    hardwareConcurrency: profile?.hardwareConcurrency ?? 8,
  });

  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error' && report.errors.length < 50) {
      report.errors.push({ type: 'console', text: msg.text(), at: new Date().toISOString() });
    }
  });
  page.on('pageerror', err => {
    report.errors.push({ type: 'pageerror', text: err.message, at: new Date().toISOString() });
  });
  page.on('crash', async () => {
    report.status = 'crashed';
    report.errors.push({ type: 'page_crash', text: 'Tab crashed', at: new Date().toISOString() });
    try {
      if (!fs.existsSync(SCREENS_DIR)) fs.mkdirSync(SCREENS_DIR, { recursive: true });
      const f = path.join(SCREENS_DIR, `crash-${report.id}.png`);
      await page.screenshot({ path: f }).catch(() => {});
      report.screenshotOnCrash = f;
    } catch {}
    saveReport(report);
  });

  const startAt = Date.now();

  try {
    await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await dismissBanners(page);

    report.gameLoadedOk = await waitForGameLoad(page, 90_000);

    if (!report.gameLoadedOk) {
      report.status = 'load_failed';
      report.errors.push({ type: 'load_timeout', text: 'Canvas never appeared within 90 s', at: new Date().toISOString() });
      if (!fs.existsSync(SCREENS_DIR)) fs.mkdirSync(SCREENS_DIR, { recursive: true });
      const f = path.join(SCREENS_DIR, `load-fail-${report.id}.png`);
      await page.screenshot({ path: f });
      report.screenshotOnCrash = f;
      saveReport(report);
      await context.close();
      return report;
    }

    await focusCanvas(page);
    await sleep(1000);

    // ~40% of bots like the game (simulates organic engagement)
    if (Math.random() < 0.4) {
      const liked = await likeGame(page);
      report.likedGame = liked;
      if (liked) console.log(`[bot] ${report.userName} — liked the game`);
    } else {
      report.likedGame = false;
    }

    // Try to dismiss any "Play" / start screen
    for (const sel of ['button:has-text("Play")', 'button:has-text("Start")', '[class*="play-btn"]']) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) { await btn.click(); await sleep(600); break; }
      } catch {}
    }
    await focusCanvas(page);

    // Find canvas bounding box for aim coordinates
    const gameFrame  = await getGameFrame(page);
    const gameCanvas = gameFrame ? await gameFrame.$('canvas') : await page.$('canvas');
    const canvasBox  = gameCanvas ? await gameCanvas.boundingBox() : null;
    const cx         = canvasBox ? canvasBox.x + canvasBox.width  / 2 : page.viewportSize().width  / 2;
    const cy         = canvasBox ? canvasBox.y + canvasBox.height / 2 : page.viewportSize().height / 2;

    let bombTimer   = Date.now();
    let sprintTimer = Date.now();
    let aimAngle    = (userId * 37) % 360;  // each user starts aim at a different angle

    while (Date.now() - startAt < playMs) {
      // Canvas health check every 30 s
      const elapsed = Date.now() - startAt;
      if (elapsed > 0 && elapsed % 30_000 < 600) {
        const alive = await canvasIsAlive(page);
        report.canvasHealthChecks.push({ alive, at: new Date().toISOString() });
        if (report.canvasHealthChecks.length > 20) report.canvasHealthChecks.shift();
        if (!alive) {
          report.errors.push({ type: 'canvas_dead', text: 'Canvas frozen / black', at: new Date().toISOString() });
        }
        if (report.errors.length > 50) report.errors = report.errors.slice(-50);
      }

      await movementCycle(page, playStyle);

      // Sweep aim (direction varies per style)
      const sweepDir = playStyle === 'erratic' ? (Math.random() > 0.5 ? 1 : -1) : 1;
      await sweepAim(page, cx, cy, 150, aimAngle, sweepDir * 90);
      aimAngle = (aimAngle + 90) % 360;

      // Throw bomb every 2 s (E key)
      if (Date.now() - bombTimer > 2000) {
        await page.keyboard.press('e');
        bombTimer = Date.now();
      }

      // Sprint every 8 s
      if (Date.now() - sprintTimer > 8000) {
        await page.keyboard.down('Shift');
        await sleep(500);
        await page.keyboard.up('Shift');
        sprintTimer = Date.now();
      }

      await sleep(80);
    }

    report.status       = 'completed';
    report.playDurationMs = Date.now() - startAt;

  } catch (err) {
    report.status = 'error';
    report.errors.push({ type: 'bot_error', text: err.message, stack: err.stack, at: new Date().toISOString() });
    try {
      if (!fs.existsSync(SCREENS_DIR)) fs.mkdirSync(SCREENS_DIR, { recursive: true });
      const f = path.join(SCREENS_DIR, `error-${report.id}.png`);
      await page.screenshot({ path: f }).catch(() => {});
      report.screenshotOnCrash = f;
    } catch {}

  } finally {
    await context.close().catch(() => {});
    saveReport(report);
  }

  return report;
}

// ── standalone (single user, 1 h, headed) ────────────────────────────────────
if (require.main === module) {
  runBot(null).then(r => {
    console.log(`[bot] Done → status: ${r.status}, errors: ${r.errors.length}`);
    process.exit(r.status === 'completed' ? 0 : 1);
  }).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runBot };
