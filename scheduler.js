/**
 * Daily scheduler – runs the bot + tests once per day,
 * then calls the crash reporter.
 *
 * Default schedule: every day at 09:00 local time.
 * Override: BOT_CRON env var, e.g. "0 14 * * *" for 2 PM.
 */

const schedule = require('node-schedule');
const { execSync, spawn } = require('child_process');
const path   = require('path');
const fs     = require('fs');
const { reportIfCrashed, getLatestReport } = require('./crashReporter');

const CRON    = process.env.BOT_CRON || '0 9 * * *';
const RUN_LOG = path.join(__dirname, 'reports', 'scheduler.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    if (!fs.existsSync(path.dirname(RUN_LOG))) fs.mkdirSync(path.dirname(RUN_LOG), { recursive: true });
    fs.appendFileSync(RUN_LOG, line + '\n');
  } catch {}
}

async function runDaily() {
  log('=== Daily Boom Arena bot run started ===');

  // 1. Run Playwright tests first (health check / crash detection)
  log('Running Playwright test suite…');
  try {
    execSync('npx playwright test --reporter=list', {
      cwd:   __dirname,
      stdio: 'pipe',
      timeout: 300_000,
    });
    log('Playwright tests PASSED');
  } catch (err) {
    log(`Playwright tests FAILED:\n${err.stdout?.toString()}\n${err.stderr?.toString()}`);
  }

  // 2. Run the gameplay bot
  log('Starting gameplay bot…');
  const { runBot } = require('./bot');
  let report;
  try {
    report = await runBot();
    log(`Bot finished – status: ${report.status}, errors: ${report.errors.length}`);
  } catch (err) {
    log(`Bot threw: ${err.message}`);
    report = { errors: [{ type: 'scheduler', text: err.message }], status: 'error', timestamp: new Date().toISOString() };
  }

  // 3. Send crash alert if needed
  await reportIfCrashed(report);

  log('=== Daily run complete ===\n');
}

// ── schedule ────────────────────────────────────────────────────────────────

const job = schedule.scheduleJob(CRON, runDaily);
log(`Scheduler started. Next run: ${job.nextInvocation()}`);
log(`Schedule: ${CRON}  (set BOT_CRON env var to change)`);

// Also expose a manual trigger
process.on('SIGUSR1', () => {
  log('Manual trigger received (SIGUSR1)');
  runDaily();
});

// ── run immediately if --now flag ────────────────────────────────────────────
if (process.argv.includes('--now')) {
  log('--now flag: running immediately');
  runDaily();
}

// Keep process alive
process.on('SIGINT',  () => { log('Scheduler stopped'); process.exit(0); });
process.on('SIGTERM', () => { log('Scheduler stopped'); process.exit(0); });
