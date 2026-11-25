/**
 * Tank Fury — 50 users, 10 batches of 5.
 * Users 1-10 are returning (saved profiles). Users 11-50 are new.
 * IP rotates between every batch. 10-min gap between batches.
 *
 * Usage:
 *   node tankFuryRun.js
 *   node tankFuryRun.js --no-ip-change
 *   node tankFuryRun.js --start-batch 3   (resume from batch 3)
 */

const { runBot }           = require('./tankFuryBot');
const { generateProfiles } = require('./userProfiles');
const { changeIP, getPublicIP } = require('./changeIP');
const path = require('path');
const fs   = require('fs');

const REPORTS_DIR  = path.join(__dirname, 'reports');
const PROFILES_DIR = path.join(__dirname, 'user-profiles');
const TOTAL_USERS  = 50;
const BATCH_SIZE   = 5;
const MIN_PLAY_MIN = 42;
const MAX_PLAY_MIN = 48;
const GAP_MIN      = 10;

const args        = process.argv.slice(2);
const SKIP_IP     = args.includes('--no-ip-change');
const START_BATCH = (() => { const i = args.indexOf('--start-batch'); return i !== -1 && args[i+1] ? Number(args[i+1]) : 1; })();

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
  const avgPlayMs = results.filter(r => r.playDurationMs > 0)
    .reduce((a, r, _, arr) => a + r.playDurationMs / arr.length, 0);
  const agg = {
    runId:      `tf-multi-${Date.now()}`,
    finishedAt: new Date().toISOString(),
    totalUsers: results.length,
    completed,
    errored:    results.length - completed,
    successRate:`${((completed / Math.max(results.length, 1)) * 100).toFixed(1)}%`,
    avgPlayMs:  Math.round(avgPlayMs),
    users: results.map(r => ({
      userId: r.userId, userName: r.userName, status: r.status,
      playMs: r.playDurationMs, errors: r.errors?.length ?? 0,
      isFirstVisit: r.isFirstVisit,
    })),
  };
  const file = path.join(REPORTS_DIR, `tf-multi-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(agg, null, 2));
  console.log(`\n[tf-run] Report saved: ${file}`);
  return agg;
}

async function runBatch(batch, batchNum, totalBatches) {
  console.log(`\n── Batch ${batchNum}/${totalBatches} — ${batch[0].name}…${batch[batch.length-1].name} ──`);
  const results = await Promise.allSettled(batch.map(profile => {
    const profileDir = path.join(PROFILES_DIR, profile.name);
    const isReturn   = fs.existsSync(profileDir) && fs.readdirSync(profileDir).length > 0;
    const playMs     = randPlayMs();
    const p = { ...profile, playMs };
    console.log(`  ▶ ${p.name} | ${isReturn ? 'returning' : 'new'} | play:${Math.round(playMs/60_000)}m`);
    return runBot(p).then(r => {
      console.log(`  ${r.status === 'completed' ? '✓' : '✗'} ${p.name} → ${r.status} | ${fmtDur(r.playDurationMs)}`);
      return r;
    });
  }));
  return results.map(r => r.status === 'fulfilled' ? r.value : {
    status: 'error', errors: [{ type: 'uncaught', text: r.reason?.message }],
    playDurationMs: 0, userId: 0, userName: '?', isFirstVisit: true,
  });
}

async function main() {
  const profiles     = generateProfiles(TOTAL_USERS);
  const batches      = [];
  for (let i = 0; i < profiles.length; i += BATCH_SIZE) batches.push(profiles.slice(i, i + BATCH_SIZE));
  const totalBatches = batches.length;

  // Count returning users (profile dir already exists)
  const returningCount = profiles.filter(p => {
    const d = path.join(PROFILES_DIR, p.name);
    return fs.existsSync(d) && fs.readdirSync(d).length > 0;
  }).length;

  console.log('\n' + '='.repeat(60));
  console.log(' Tank Fury Bot — 50 users, 10 batches × 5');
  console.log(` Returning users: ${returningCount} | New users: ${TOTAL_USERS - returningCount}`);
  console.log(` Play time:  ${MIN_PLAY_MIN}–${MAX_PLAY_MIN} min per user`);
  console.log(` IP change:  ${SKIP_IP ? 'disabled (--no-ip-change)' : 'between every batch'}`);
  console.log(` Gap:        ${GAP_MIN} min between batches`);
  if (START_BATCH > 1) console.log(` Resuming from batch ${START_BATCH}`);
  console.log('='.repeat(60));

  try { console.log(`Starting IP: ${await getPublicIP()}`); } catch {}

  const allResults = [];

  for (let bi = 0; bi < batches.length; bi++) {
    const batchNum = bi + 1;
    if (batchNum < START_BATCH) { console.log(`[tf-run] Skipping batch ${batchNum} (--start-batch ${START_BATCH})`); continue; }

    const batchResults = await runBatch(batches[bi], batchNum, totalBatches);
    allResults.push(...batchResults);

    const ok = allResults.filter(r => r.status === 'completed').length;
    console.log(`[tf-run] Progress: ${allResults.length}/${TOTAL_USERS} done | ✓${ok} completed`);

    // After every batch except the last: change IP + gap
    if (batchNum < totalBatches) {
      if (!SKIP_IP) {
        console.log(`\n[tf-run] Changing IP before batch ${batchNum + 1}…`);
        await changeIP();
      }
      console.log(`[tf-run] Waiting ${GAP_MIN} min before batch ${batchNum + 1}…`);
      await sleep(GAP_MIN * 60_000);
    }
  }

  const agg = saveAggregate(allResults);
  console.log(`\n${'='.repeat(60)}`);
  console.log(` Done — ✓${agg.completed}/${agg.totalUsers} (${agg.successRate}) | avg:${fmtDur(agg.avgPlayMs)}`);
  console.log('='.repeat(60));
}

main().catch(e => { console.error('[tf-run] Fatal:', e); process.exit(1); });
