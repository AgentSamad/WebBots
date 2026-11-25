/**
 * Poki – Tank Fury bot
 * Stealth: WebGL spoof, canvas noise, plugin list, human mouse, SDK ad-skip
 * Flow: poki.com → click Play → handle commercialBreak → Battle → aim+shoot
 */

const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

const GAME_URL     = 'https://poki.com/en/g/tank-fury';
const REPORTS_DIR  = path.join(__dirname, 'reports');
const SCREENS_DIR  = path.join(__dirname, 'screenshots');
const PROFILES_DIR = path.join(__dirname, 'user-profiles');
const DEFAULT_PLAY_MS = 25 * 60 * 1000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }
function randF(lo, hi) { return lo + Math.random() * (hi - lo); }

function saveReport(report) {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORTS_DIR, `pk-run-${report.id}.json`), JSON.stringify(report, null, 2));
}

// ── Stealth init script (injected into every frame before page JS runs) ───────

function buildStealthScript(profile) {
  return `
(function() {
  // 1. Hide webdriver
  Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });

  // 2. WebGL spoof — headless Chrome exposes SwiftShader/Google; real GPUs don't
  const _getParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(p) {
    if (p === 37445) return ${JSON.stringify(profile?.glVendor   ?? 'Intel Inc.')};
    if (p === 37446) return ${JSON.stringify(profile?.glRenderer ?? 'Intel Iris OpenGL Engine')};
    return _getParam.call(this, p);
  };
  try {
    const _getParam2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(p) {
      if (p === 37445) return ${JSON.stringify(profile?.glVendor   ?? 'Intel Inc.')};
      if (p === 37446) return ${JSON.stringify(profile?.glRenderer ?? 'Intel Iris OpenGL Engine')};
      return _getParam2.call(this, p);
    };
  } catch(e) {}

  // 3. Canvas fingerprint noise (subtle pixel flips so every bot has unique hash)
  const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type, q) {
    const ctx = this.getContext('2d');
    if (ctx) {
      const noiseX = ${rand(0, 3)}, noiseY = ${rand(0, 3)};
      const px = ctx.getImageData(noiseX, noiseY, 1, 1);
      px.data[0] = (px.data[0] + ${rand(1,3)}) & 0xff;
      ctx.putImageData(px, noiseX, noiseY);
    }
    return _toDataURL.call(this, type, q);
  };

  // 4. Chrome plugin list (headless has 0 plugins)
  const fakePlugins = [
    { name: 'Chrome PDF Plugin',  filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 0 },
    { name: 'Chrome PDF Viewer',  filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 0 },
    { name: 'Native Client',      filename: 'internal-nacl-plugin', description: '', length: 0 },
  ];
  Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins, configurable: true });
  Object.defineProperty(navigator, 'mimeTypes', { get: () => ({ length: 1 }), configurable: true });

  // 5. languages
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });

  // 6. Permissions API — real Chrome resolves 'notifications' as 'default', headless throws
  if (navigator.permissions && navigator.permissions.query) {
    const _query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (p) => {
      if (p && p.name === 'notifications') return Promise.resolve({ state: 'default' });
      return _query(p);
    };
  }

  // 7. hardwareConcurrency / deviceMemory
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${profile?.hardwareConcurrency ?? 8}, configurable: true });
  try { Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true }); } catch(e) {}

  // 8. screen dimensions must match viewport to avoid fingerprint mismatch
  try {
    Object.defineProperty(screen, 'width',       { get: () => ${profile?.viewport?.width  ?? 1280} });
    Object.defineProperty(screen, 'height',      { get: () => ${profile?.viewport?.height ?? 720} });
    Object.defineProperty(screen, 'availWidth',  { get: () => ${profile?.viewport?.width  ?? 1280} });
    Object.defineProperty(screen, 'availHeight', { get: () => ${(profile?.viewport?.height ?? 720) - 40} });
    Object.defineProperty(screen, 'colorDepth',  { get: () => ${profile?.colorDepth ?? 24} });
  } catch(e) {}

  // 9. Poki SDK: intercept commercialBreak so bot never pauses for ads
  //    We override the SDK after it initialises by hooking the setter on window.PokiSDK
  let _sdk = window.PokiSDK;
  Object.defineProperty(window, 'PokiSDK', {
    get() { return _sdk; },
    set(v) {
      _sdk = v;
      // Once real SDK is set, replace ad-pause methods with instant-resolve
      if (v && typeof v.commercialBreak === 'function') {
        v.commercialBreak  = () => Promise.resolve();
        v.rewardedBreak    = () => Promise.resolve(false);
      }
    },
    configurable: true,
  });
})();
`;
}

// ── Bezier-curve human mouse movement ─────────────────────────────────────────

async function humanMouseMove(page, x1, y1, x2, y2, steps = null) {
  if (!steps) steps = rand(15, 30);
  // Control points with jitter for natural arc
  const cx1 = x1 + (x2 - x1) * 0.25 + randF(-40, 40);
  const cy1 = y1 + (y2 - y1) * 0.25 + randF(-40, 40);
  const cx2 = x1 + (x2 - x1) * 0.75 + randF(-40, 40);
  const cy2 = y1 + (y2 - y1) * 0.75 + randF(-40, 40);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const bx = mt*mt*mt*x1 + 3*mt*mt*t*cx1 + 3*mt*t*t*cx2 + t*t*t*x2;
    const by = mt*mt*mt*y1 + 3*mt*mt*t*cy1 + 3*mt*t*t*cy2 + t*t*t*y2;
    await page.mouse.move(bx + randF(-1.5, 1.5), by + randF(-1.5, 1.5));
    await sleep(rand(8, 22));
  }
}

// ── Game helpers ───────────────────────────────────────────────────────────────

async function getGameFrame(page) {
  for (const frame of page.frames()) {
    try {
      const url = frame.url();
      if (url.includes('games.poki.com') || url.includes('poki.com/game')) {
        if (await frame.$('canvas')) return frame;
      }
    } catch {}
  }
  for (const frame of page.frames()) {
    try { if (await frame.$('canvas')) return frame; } catch {}
  }
  return null;
}

async function waitForCanvas(page, timeoutMs = 90_000) {
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
    'button:has-text("Agree")', '[aria-label*="accept" i]',
    'button:has-text("Continue")', 'button:has-text("OK")',
  ]) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) { await btn.click(); await sleep(400); }
    } catch {}
  }
}

// Click Poki's "Play" overlay button (appears before game loads)
async function clickPokiPlayButton(page) {
  const selectors = [
    '[data-testid="play-button"]',
    'button:has-text("Play")',
    '[aria-label*="play" i]',
    '[class*="play" i] button',
    '[class*="PlayButton"]',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        console.log('  clicked Poki play overlay');
        await sleep(1000);
        return true;
      }
    } catch {}
  }
  return false;
}

// Click the in-game Battle button (same canvas approach as CrazyGames)
async function clickBattleButton(page) {
  const selectors = [
    'button:has-text("Battle")', 'button:has-text("BATTLE")',
    'button:has-text("Play")',   'button:has-text("PLAY")',
    '[class*="battle" i]',
  ];
  const gameFrame = await getGameFrame(page);
  for (const ctx of [page, gameFrame].filter(Boolean)) {
    for (const sel of selectors) {
      try {
        const btn = await ctx.$(sel);
        if (btn && await btn.isVisible()) { await btn.click(); await sleep(500); return true; }
      } catch {}
    }
  }
  // Fallback: canvas coordinate click at 50%x, 45%y (where BATTLE button is on Poki)
  const canvas = gameFrame ? await gameFrame.$('canvas') : await page.$('canvas');
  if (canvas) {
    const box = await canvas.boundingBox();
    if (box) {
      const bx = box.x + box.width  * 0.50;
      const by = box.y + box.height * 0.45;
      await humanMouseMove(page, box.x + box.width/2, box.y + box.height/4, bx, by);
      await page.mouse.click(bx, by);
      await sleep(400);
      return true;
    }
  }
  return false;
}

async function canvasIsAlive(page) {
  const frame = await getGameFrame(page) || page;
  return frame.evaluate(() => {
    const c = document.querySelector('canvas');
    return c ? (c.width > 0 && c.height > 0) : false;
  }).catch(() => false);
}

// ── Movement patterns ──────────────────────────────────────────────────────────

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
    await sleep(ms + rand(-30, 30)); // slight timing jitter
    for (const k of keys) await page.keyboard.up(k);
    await sleep(rand(20, 60));
  }
}

async function aimAndShoot(page, cx, cy, angle, radius = 180) {
  const rad = angle * Math.PI / 180;
  const tx  = cx + Math.cos(rad) * radius;
  const ty  = cy + Math.sin(rad) * radius;
  await humanMouseMove(page, cx, cy, tx, ty, rand(8, 16));
  await sleep(rand(60, 120));
  await page.mouse.click(tx + randF(-3, 3), ty + randF(-3, 3));
  await sleep(rand(50, 90));
}

// ── Main bot ───────────────────────────────────────────────────────────────────

async function runBot(profile = null) {
  const userDataDir = profile
    ? path.join(PROFILES_DIR, `pk-${profile.name}`)
    : path.join(PROFILES_DIR, 'pk-single');
  const isReturning = fs.existsSync(userDataDir) && fs.readdirSync(userDataDir).length > 0;
  const playMs   = profile?.playMs ?? DEFAULT_PLAY_MS;
  const userId   = profile?.id    ?? 0;
  const userName = profile?.name  ?? 'pk-single';
  const playStyle = profile?.playStyle ?? 'circular';

  const report = {
    id: `${Date.now()}-pk${userId}`,
    userId, userName, playStyle,
    viewport:  profile?.viewport ?? { width: 1280, height: 720 },
    locale:    profile?.locale   ?? 'en-US',
    timezone:  profile?.timezone ?? 'UTC',
    timestamp: new Date().toISOString(),
    status: 'running', errors: [], warnings: [],
    gameLoadedOk: false, playDurationMs: 0, canvasHealthChecks: [],
    isFirstVisit: !isReturning,
  };

  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  console.log(`[pk-bot] ${userName} — ${isReturning ? 'returning' : 'first visit'} | play:${Math.round(playMs/60000)}m`);

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
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-extensions', '--disable-sync', '--disable-translate',
          '--mute-audio', '--no-first-run', '--metrics-recording-only',
          '--safebrowsing-disable-auto-update',
          '--js-flags=--max-old-space-size=384',
          '--disable-features=PointerLock',
          // Stealth: use real GPU path, not SwiftShader
          '--ignore-gpu-blocklist',
          '--enable-gpu-rasterization',
          '--use-gl=swiftshader',          // keep GPU active so canvas works
        ],
        ...(profile?.proxy ? { proxy: { server: profile.proxy } } : {}),
      });
      break;
    } catch {}
  }
  if (!context) {
    report.status = 'error';
    report.errors.push({ type: 'launch', text: 'No usable browser', at: new Date().toISOString() });
    saveReport(report); return report;
  }

  // Inject stealth script into every frame before page JS runs
  await context.addInitScript(buildStealthScript(profile));

  // Block trackers / heavy ads (but NOT Poki SDK — let it load)
  await context.route('**/*', (route) => {
    const url  = route.request().url();
    const type = route.request().resourceType();
    const blocked =
      type === 'media' ||
      /googletagmanager|google-analytics|doubleclick|googlesyndication|facebook\.net|hotjar|amplitude|mixpanel|segment\.io|clarity\.ms|pagead2|adservice/.test(url) ||
      (type === 'font' && !/poki-cdn\.com|poki\.com/.test(url));
    if (blocked) return route.abort();
    return route.continue();
  });

  const page = await context.newPage();
  page.on('console',   msg => { if (msg.type() === 'error' && report.errors.length < 50) report.errors.push({ type: 'console', text: msg.text(), at: new Date().toISOString() }); });
  page.on('pageerror', err => { report.errors.push({ type: 'pageerror', text: err.message, at: new Date().toISOString() }); });

  const startAt = Date.now();

  try {
    await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await dismissBanners(page);
    await sleep(rand(1500, 3000));

    // Wait for game canvas (Poki Tank Fury loads directly — no play overlay)
    report.gameLoadedOk = await waitForCanvas(page, 90_000);
    if (!report.gameLoadedOk) {
      report.status = 'load_failed';
      report.errors.push({ type: 'load_timeout', text: 'Canvas never appeared', at: new Date().toISOString() });
      saveReport(report); await context.close(); return report;
    }

    // Dismiss any post-load banners / cookie prompts
    await dismissBanners(page);
    await sleep(1000);

    // Patch Poki SDK in the game iframe to skip ad breaks
    const gameFrame = await getGameFrame(page);
    if (gameFrame) {
      await gameFrame.evaluate(() => {
        if (window.PokiSDK) {
          window.PokiSDK.commercialBreak = () => Promise.resolve();
          window.PokiSDK.rewardedBreak   = () => Promise.resolve(false);
        }
      }).catch(() => {});
    }

    // Click the Battle / Play button to start matchmaking
    console.log(`[pk-bot] ${userName} — clicking Battle…`);
    await clickBattleButton(page);
    await sleep(1000);
    await clickBattleButton(page);

    // Wait for matchmaking
    const matchWait = rand(15_000, 25_000);
    console.log(`[pk-bot] ${userName} — waiting ${Math.round(matchWait/1000)}s for matchmaking…`);
    await sleep(matchWait);

    // Get canvas center for aiming
    const canvas2    = gameFrame ? await gameFrame.$('canvas') : await page.$('canvas');
    const canvasBox  = canvas2 ? await canvas2.boundingBox() : null;
    const cx = canvasBox ? canvasBox.x + canvasBox.width  / 2 : (page.viewportSize()?.width  ?? 1280) / 2;
    const cy = canvasBox ? canvasBox.y + canvasBox.height / 2 : (page.viewportSize()?.height ?? 720)  / 2;

    console.log(`[pk-bot] ${userName} — in match, playing ${Math.round(playMs/60000)}m`);

    let aimAngle   = (userId * 37) % 360;
    let shootTimer = Date.now();
    let lastMouseX = cx, lastMouseY = cy;

    while (Date.now() - startAt < playMs) {
      // Canvas health check every 30 s
      const elapsed = Date.now() - startAt;
      if (elapsed > 0 && elapsed % 30_000 < 700) {
        const alive = await canvasIsAlive(page);
        report.canvasHealthChecks.push({ alive, at: new Date().toISOString() });
        if (!alive) report.errors.push({ type: 'canvas_dead', text: 'Canvas frozen', at: new Date().toISOString() });
      }

      await movementCycle(page, playStyle);

      if (Date.now() - shootTimer > 1500) {
        const tx = cx + Math.cos(aimAngle * Math.PI/180) * rand(120, 220);
        const ty = cy + Math.sin(aimAngle * Math.PI/180) * rand(120, 220);
        await humanMouseMove(page, lastMouseX, lastMouseY, tx, ty);
        await page.mouse.click(tx + randF(-4, 4), ty + randF(-4, 4));
        lastMouseX = tx; lastMouseY = ty;
        aimAngle = (aimAngle + rand(45, 90)) % 360;
        // Burst
        for (let i = 0; i < rand(1, 2); i++) {
          const ba = (aimAngle + rand(-30, 30) + 360) % 360;
          const bx = cx + Math.cos(ba * Math.PI/180) * rand(100, 200);
          const by = cy + Math.sin(ba * Math.PI/180) * rand(100, 200);
          await humanMouseMove(page, lastMouseX, lastMouseY, bx, by, rand(5, 10));
          await page.mouse.click(bx + randF(-4, 4), by + randF(-4, 4));
          lastMouseX = bx; lastMouseY = by;
          await sleep(rand(80, 150));
        }
        shootTimer = Date.now();
      }

      await sleep(rand(60, 110));
    }

    report.status       = 'completed';
    report.playDurationMs = Date.now() - startAt;
    console.log(`[pk-bot] ${userName} — done | ${Math.round(report.playDurationMs/60000)}m played`);

  } catch (err) {
    report.status = 'error';
    report.errors.push({ type: 'bot_error', text: err.message, at: new Date().toISOString() });
    try {
      if (!fs.existsSync(SCREENS_DIR)) fs.mkdirSync(SCREENS_DIR, { recursive: true });
      await page.screenshot({ path: path.join(SCREENS_DIR, `pk-error-${report.id}.png`) }).catch(() => {});
    } catch {}
  } finally {
    await context.close().catch(() => {});
    saveReport(report);
  }

  return report;
}

if (require.main === module) {
  runBot(null).then(r => {
    console.log(`[pk-bot] Done → ${r.status} | play:${Math.round(r.playDurationMs/60000)}m`);
    process.exit(r.status === 'completed' ? 0 : 1);
  }).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runBot };
