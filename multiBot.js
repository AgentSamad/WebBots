/**
 * Multi-user orchestrator — 5 bots per batch, IP change between batches.
 *
 * Schedule:
 *   Batch 1 (Users 001-005) → all 5 play → IP changes → Batch 2 → …
 *
 * Each bot plays 15-20 min. After all 5 finish, IP is changed, then next 5 start.
 *
 * Usage:
 *   node multiBot.js                 — 100 users, forever
 *   node multiBot.js --rounds 1      — stop after 1 pass
 *   node multiBot.js --users 20      — only 20 users
 *   node multiBot.js --batch 10      — 10 bots per batch
 *   node multiBot.js --no-ip-change  — skip IP change (useful for testing)
 */

const { runBot }           = require('./bot');
const { generateProfiles } = require('./userProfiles');
const { changeIP, getPublicIP } = require('./changeIP');
const path = require('path');
const fs   = require('fs');

const REPORTS_DIR = path.join(__dirname, 'reports');

// ── CLI args ──────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const getArg    = (flag, def) => { const i = args.indexOf(flag); return i !== -1 && args[i+1] ? Number(args[i+1]) : def; };
const hasFlag   = flag => args.includes(flag);

const USER_COUNT    = getArg('--users',    50);
const BATCH_SIZE    = getArg('--batch',     5);
const MAX_ROUNDS    = getArg('--rounds',    0);   // 0 = loop forever
const SKIP_IP       = hasFlag('--no-ip-change');
const START_USER    = getArg('--start-user', 1);  // skip users before this id
const MIN_PLAY_MIN         = 20;
const MAX_PLAY_MIN         = 25;
const MIN_RETURN_PLAY_MIN  = 20;
const MAX_RETURN_PLAY_MIN  = 25;

// ── helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtDur(ms) {
  if (!ms) return '0m';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function randomPlayMs(isReturn = false) {
  const lo = isReturn ? MIN_RETURN_PLAY_MIN : MIN_PLAY_MIN;
  const hi = isReturn ? MAX_RETURN_PLAY_MIN : MAX_PLAY_MIN;
  return (lo + Math.floor(Math.random() * (hi - lo + 1))) * 60 * 1000;
}

function loadProxies() {
  const f = path.join(__dirname, 'proxies.txt');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

// ── aggregate report ──────────────────────────────────────────────────────────

function saveAggregate(roundNum, results) {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const totalUsers = results.length;
  const completed  = results.filter(r => r.status === 'completed').length;
  const errored    = results.filter(r => r.status !== 'completed').length;
  const avgPlayMs  = results.filter(r => r.playDurationMs > 0)
    .reduce((a, r, _, arr) => a + r.playDurationMs / arr.length, 0);

  const errorCounts = {};
  for (const r of results) {
    for (const e of (r.errors || [])) {
      if (/nexx360|cors|analytics|gtag|uv4|isReadable/i.test(e.text)) continue;
      const key = `[${e.type}] ${e.text?.slice(0, 120)}`;
      errorCounts[key] = (errorCounts[key] || 0) + 1;
    }
  }

  const aggregate = {
    runId:       `multi-round${roundNum}-${Date.now()}`,
    round:       roundNum,
    finishedAt:  new Date().toISOString(),
    batchSize:   BATCH_SIZE,
    totalUsers,
    completed,
    errored,
    successRate: `${((completed / Math.max(totalUsers, 1)) * 100).toFixed(1)}%`,
    avgPlayMs:   Math.round(avgPlayMs),
    topErrors:   Object.entries(errorCounts).sort((a,b) => b[1]-a[1]).slice(0,20).map(([msg,count])=>({count,msg})),
    userResults: results.map(r => ({
      userId: r.userId, userName: r.userName, status: r.status,
      errors: r.errors?.length ?? 0, playMs: r.playDurationMs,
      isFirstVisit: r.isFirstVisit, likedGame: r.likedGame,
    })),
  };

  fs.writeFileSync(path.join(REPORTS_DIR, `multi-run-${Date.now()}.json`), JSON.stringify(aggregate, null, 2));
  return aggregate;
}

// ── run one batch of 5 bots concurrently ─────────────────────────────────────

async function runBatch(batch, proxies, roundNum, batchNum, totalBatches) {
  console.log(`\n[R${roundNum}] ── Batch ${batchNum}/${totalBatches} — ${batch[0].name}…${batch[batch.length-1].name} ──`);

  const results = await Promise.allSettled(batch.map((profile, pi) => {
    const globalIndex = (batchNum - 1) * BATCH_SIZE + pi;
    // Users in the second half of the run are forced as first-time visitors
    const halfPoint  = Math.ceil(USER_COUNT / 2);
    const forceNew   = profile.id > halfPoint;
    const profileName = forceNew ? `${profile.name}_new` : profile.name;
    const profileDir = path.join(__dirname, 'user-profiles', profileName);
    const isReturn   = !forceNew && fs.existsSync(profileDir);
    const playMs     = randomPlayMs(isReturn);
    const proxy      = proxies.length > 0 ? proxies[globalIndex % proxies.length] : undefined;
    const p = { ...profile, name: profileName, playMs, returnPlayMs: playMs, ...(proxy ? { proxy } : {}) };
    const visitLabel = isReturn ? 'return' : 'first';
    console.log(`[R${roundNum}] ▶ ${p.name} | visit:${visitLabel} | play:${Math.round(playMs/60000)}m | proxy:${proxy ?? 'none'}`);

    return runBot(p).then(result => {
      const icon = result.status === 'completed' ? '✓' : '✗';
      console.log(`[R${roundNum}] ${icon} ${p.name} → ${result.status} | play:${fmtDur(result.playDurationMs)}`);
      return result;
    });
  }));

  return results.map(r => r.status === 'fulfilled' ? r.value : {
    status: 'error', errors: [{ type: 'uncaught', text: r.reason?.message }],
    playDurationMs: 0, canvasHealthChecks: [],
  });
}

// ── run one full round ────────────────────────────────────────────────────────

async function runRound(profiles, proxies, roundNum) {
  const batches      = [];
  for (let i = 0; i < profiles.length; i += BATCH_SIZE) batches.push(profiles.slice(i, i + BATCH_SIZE));
  const totalBatches = batches.length;

  console.log(`\n${'═'.repeat(64)}`);
  console.log(` Round ${roundNum} — ${profiles.length} users | ${BATCH_SIZE}/batch | ${totalBatches} batches`);
  console.log(` IP change between batches: ${SKIP_IP ? 'disabled' : 'enabled'}`);
  console.log(`${'═'.repeat(64)}`);

  let currentIP;
  try { currentIP = await getPublicIP(); console.log(`[R${roundNum}] Starting IP: ${currentIP}`); } catch {}

  const roundResults = [];

  for (let bi = 0; bi < batches.length; bi++) {
    const batchNum = bi + 1;
    const batchResults = await runBatch(batches[bi], proxies, roundNum, batchNum, totalBatches);
    roundResults.push(...batchResults);

    const ok    = roundResults.filter(r => r.status === 'completed').length;
    const total = roundResults.length;
    console.log(`[R${roundNum}] Progress: ${total}/${profiles.length} done | ✓${ok} completed`);

    // Change IP + random gap between batches (except after the last one)
    if (bi < batches.length - 1) {
      if (!SKIP_IP) {
        console.log(`\n[R${roundNum}] Changing IP before next batch…`);
        await changeIP();
      }
      const gapMin = 10;
      console.log(`[R${roundNum}] Waiting ${gapMin}m before next batch…\n`);
      await sleep(gapMin * 60 * 1000);
    }
  }

  const agg = saveAggregate(roundNum, roundResults);
  console.log(`\n[R${roundNum}] Round complete — ✓${agg.completed}/${agg.totalUsers} (${agg.successRate}) | avg:${fmtDur(agg.avgPlayMs)}`);
  return agg;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const profiles = generateProfiles(USER_COUNT).filter(p => p.id >= START_USER);
  const proxies  = loadProxies();

  console.log(`\n${'='.repeat(64)}`);
  console.log(` Boom Arena — Multi-User Bot with IP Rotation`);
  console.log(`  Users:      ${USER_COUNT}`);
  console.log(`  Batch size: ${BATCH_SIZE} bots at a time`);
  console.log(`  IP change:  ${SKIP_IP ? 'disabled (--no-ip-change)' : 'after every batch'}`);
  console.log(`  Play time:  ${MIN_PLAY_MIN}–${MAX_PLAY_MIN} min random`);
  console.log(`  Order:      reverse (User 100 → 1)`);
  console.log(`  Proxies:    ${proxies.length > 0 ? proxies.length + ' loaded' : 'none'}`);
  console.log(`  Rounds:     ${MAX_ROUNDS === 0 ? '∞ (loop forever)' : MAX_ROUNDS}`);
  console.log(`${'='.repeat(64)}\n`);

  let round = 0;
  while (MAX_ROUNDS === 0 || round < MAX_ROUNDS) {
    round++;
    await runRound(profiles, proxies, round);
    if (MAX_ROUNDS !== 0 && round >= MAX_ROUNDS) break;
    console.log(`\n[multi] 2 min pause before Round ${round + 1}…\n`);
    await sleep(2 * 60 * 1000);
  }

  console.log('\n[multi] All rounds complete.');
}

main().catch(e => { console.error('[multi] Fatal:', e); process.exit(1); });
