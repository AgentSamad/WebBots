/**
 * pokiLiteRun.js — Low-memory Poki Tank Fury orchestrator.
 *
 * Memory model:
 *   OLD: N bots × launchPersistentContext = N Chromium processes × ~450 MB = ~9 GB for 20 bots
 *   NEW: 1 shared chromium.launch + N browser.newContext = ~100 MB/bot = ~2 GB for 20 bots
 *
 * Usage:
 *   node pokiLiteRun.js                     # run all 100 users
 *   node pokiLiteRun.js --batch-size 30     # 30 concurrent (needs ~4 GB RAM)
 *   node pokiLiteRun.js --batch-size 50     # 50 concurrent (needs ~6 GB RAM)
 *   node pokiLiteRun.js --start-batch 3     # resume from batch 3
 */

const { chromium } = require('playwright');
const { runBot }   = require('./pokiLiteBot');
const { generateProfiles } = require('./userProfiles');
const { randomUUID } = require('crypto');
const path = require('path');
const fs   = require('fs');

// ── Config ──────────────────────────────────────────────────────────────────

const TOTAL_USERS  = 100;
const MIN_PLAY_MIN = 42;
const MAX_PLAY_MIN = 48;

// Parse CLI args
const args = process.argv.slice(2);
function getArg(flag, def) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i+1] ? Number(args[i+1]) : def;
}
const BATCH_SIZE  = getArg('--batch-size',  20);   // default 20 concurrent
const START_BATCH = getArg('--start-batch',  1);

const REPORTS_DIR = path.join(__dirname, 'reports');

// ── GPU variant pool ─────────────────────────────────────────────────────────

const GL_VARIANTS = [
  { glVendor: 'Intel Inc.',           glRenderer: 'Intel Iris OpenGL Engine' },
  { glVendor: 'Intel Inc.',           glRenderer: 'Intel HD Graphics 620' },
  { glVendor: 'NVIDIA Corporation',   glRenderer: 'NVIDIA GeForce GTX 1050 Ti/PCIe/SSE2' },
  { glVendor: 'NVIDIA Corporation',   glRenderer: 'NVIDIA GeForce RTX 2060/PCIe/SSE2' },
  { glVendor: 'AMD',                   glRenderer: 'AMD Radeon RX 580 Series' },
  { glVendor: 'Google Inc. (Intel)',   glRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)' },
  { glVendor: 'Google Inc. (NVIDIA)', glRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11)' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtDur(ms) {
  if (!ms) return '0m';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function randPlayMs() {
  return (MIN_PLAY_MIN + Math.floor(Math.random() * (MAX_PLAY_MIN - MIN_PLAY_MIN + 1))) * 60_000;
}

function saveAggregate(results) {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const completed = results.filter(r => r.status === 'completed').length;
  const withPlay  = results.filter(r => r.playDurationMs > 0);
  const avgPlayMs = withPlay.length
    ? withPlay.reduce((a, r) => a + r.playDurationMs, 0) / withPlay.length
    : 0;
  const agg = {
    runId:       `pk-lite-${Date.now()}`,
    finishedAt:  new Date().toISOString(),
    totalUsers:  results.length,
    completed,
    errored:     results.length - completed,
    successRate: `${((completed / Math.max(results.length, 1)) * 100).toFixed(1)}%`,
    avgPlayMs:   Math.round(avgPlayMs),
    users: results.map(r => ({
      userId:    r.userId,
      userName:  r.userName,
      status:    r.status,
      playMs:    r.playDurationMs,
      errors:    r.errors?.length ?? 0,
      isFirstVisit: r.isFirstVisit,
    })),
  };
  const file = path.join(REPORTS_DIR, `${agg.runId}.json`);
  fs.writeFileSync(file, JSON.stringify(agg, null, 2));
  console.log(`\n[pk-lite] Report saved: ${file}`);
  return agg;
}

// ── Run one batch using shared browser ──────────────────────────────────────

async function runBatch(browser, batch, batchNum, totalBatches) {
  console.log(`\n── Batch ${batchNum}/${totalBatches} — ${batch[0].name}…${batch[batch.length-1].name} (${batch.length} bots) ──`);

  const results = await Promise.allSettled(batch.map(profile => {
    console.log(`  ▶ ${profile.name} | ${profile.isReturn ? 'returning' : 'new'} | play:${Math.round(profile.playMs/60_000)}m | GPU:${profile.glRenderer.split(' ').slice(0,3).join(' ')}`);
    return runBot(browser, profile).then(r => {
      const icon = r.status === 'completed' ? '✓' : '✗';
      console.log(`  ${icon} ${profile.name} → ${r.status} | ${fmtDur(r.playDurationMs)}`);
      return r;
    });
  }));

  return results.map(r => r.status === 'fulfilled' ? r.value : {
    status: 'error',
    errors: [{ type: 'uncaught', text: r.reason?.message }],
    playDurationMs: 0, userId: 0, userName: '?', isFirstVisit: true,
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const profiles = generateProfiles(TOTAL_USERS);

  // Load or create a stable pokiUserId per profile (makes returning user tracking work)
  const profilesWithMeta = profiles.map(p => {
    const profileDir  = path.join(__dirname, 'user-profiles', `pk-lite-${p.name}`);
    const cookieFile  = path.join(profileDir, 'cookies.json');
    const userIdFile  = path.join(profileDir, 'poki_user_id.txt');
    const isReturn    = fs.existsSync(cookieFile);

    let pokiUserId;
    if (fs.existsSync(userIdFile)) {
      pokiUserId = fs.readFileSync(userIdFile, 'utf8').trim();
    } else {
      pokiUserId = randomUUID();
      // Save immediately so the same ID is used on every future run
      if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(userIdFile, pokiUserId);
    }

    return {
      ...p,
      ...GL_VARIANTS[p.id % GL_VARIANTS.length],
      pokiUserId,
      playMs:   randPlayMs(),
      isReturn,
    };
  });

  const batches = [];
  for (let i = 0; i < profilesWithMeta.length; i += BATCH_SIZE) {
    batches.push(profilesWithMeta.slice(i, i + BATCH_SIZE));
  }
  const totalBatches   = batches.length;
  const returningCount = profilesWithMeta.filter(p => p.isReturn).length;

  console.log('\n' + '='.repeat(60));
  console.log(' Poki Tank Fury — LITE (shared browser, low memory)');
  console.log(` Users:    ${TOTAL_USERS} total | ${returningCount} returning | ${TOTAL_USERS - returningCount} new`);
  console.log(` Batches:  ${totalBatches} × ${BATCH_SIZE} concurrent`);
  console.log(` Play:     ${MIN_PLAY_MIN}–${MAX_PLAY_MIN} min per user`);
  console.log(` Memory:   ~${80 + BATCH_SIZE * 100} MB peak per batch (vs ${BATCH_SIZE * 450} MB old)`);
  if (START_BATCH > 1) console.log(` Resuming from batch ${START_BATCH}`);
  console.log('='.repeat(60));

  // Launch ONE shared browser for all bots
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-accelerated-2d-canvas',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-extensions',
      '--no-first-run',
      '--disable-default-apps',
      '--disable-translate',
      '--safebrowsing-disable-auto-update',
      '--disable-client-side-phishing-detection',
      '--disable-component-update',
      '--disable-features=AudioServiceOutOfProcess,VizDisplayCompositor',
      '--disable-print-preview',
      '--disable-speech-api',
      '--media-cache-size=1',
      '--disk-cache-size=1',
      '--js-flags=--max-old-space-size=64',
      `--renderer-process-limit=${Math.min(BATCH_SIZE, 8)}`,
    ],
  });

  console.log('[pk-lite] Browser launched (shared across all bots)');

  const allResults = [];

  try {
    for (let bi = 0; bi < batches.length; bi++) {
      const batchNum = bi + 1;
      if (batchNum < START_BATCH) {
        console.log(`[pk-lite] Skipping batch ${batchNum}`);
        continue;
      }

      const batchResults = await runBatch(browser, batches[bi], batchNum, totalBatches);
      allResults.push(...batchResults);

      const ok = allResults.filter(r => r.status === 'completed').length;
      console.log(`[pk-lite] Progress: ${allResults.length}/${TOTAL_USERS} done | ✓${ok} completed`);

      // Brief pause between batches (optional — remove if you want back-to-back)
      if (batchNum < totalBatches) {
        console.log('[pk-lite] Brief pause before next batch…');
        await sleep(5000);
      }
    }
  } finally {
    await browser.close();
    console.log('[pk-lite] Browser closed.');
  }

  const agg = saveAggregate(allResults);
  console.log('\n' + '='.repeat(60));
  console.log(` Done — ✓${agg.completed}/${agg.totalUsers} (${agg.successRate}) | avg:${fmtDur(agg.avgPlayMs)}`);
  console.log('='.repeat(60));
}

main().catch(e => { console.error('[pk-lite] Fatal:', e); process.exit(1); });
