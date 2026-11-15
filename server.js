/**
 * Dashboard server – serves the monitoring UI
 * and a JSON API for run reports.
 *
 * GET /           → dashboard HTML
 * GET /api/runs   → all run reports (newest first)
 * GET /api/tests  → latest Playwright test results
 * GET /api/status → quick summary { ok, lastRun, errorCount }
 */

const express  = require('express');
const path     = require('path');
const fs       = require('fs');

const app         = express();
const PORT        = process.env.PORT || 3737;
const REPORTS_DIR = path.join(__dirname, 'reports');
const SCREENS_DIR = path.join(__dirname, 'screenshots');

app.use(express.json());
app.use('/screenshots', express.static(SCREENS_DIR));
app.use('/dashboard',   express.static(path.join(__dirname, 'dashboard')));

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/runs', (req, res) => {
  if (!fs.existsSync(REPORTS_DIR)) return res.json([]);
  const runs = fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('run-') && f.endsWith('.json'))
    .sort().reverse()
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean);
  res.json(runs);
});

app.get('/api/multi-runs', (req, res) => {
  if (!fs.existsSync(REPORTS_DIR)) return res.json([]);
  const runs = fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('multi-run-') && f.endsWith('.json'))
    .sort().reverse()
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean);
  res.json(runs);
});

app.get('/api/tests', (req, res) => {
  const f = path.join(REPORTS_DIR, 'playwright-results.json');
  if (!fs.existsSync(f)) return res.json({ message: 'No test results yet. Run: npm test' });
  try { res.json(JSON.parse(fs.readFileSync(f, 'utf-8'))); }
  catch { res.status(500).json({ error: 'Failed to parse test results' }); }
});

app.get('/api/status', (req, res) => {
  if (!fs.existsSync(REPORTS_DIR)) return res.json({ ok: true, lastRun: null, errorCount: 0 });
  const runs = fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('run-') && f.endsWith('.json'))
    .sort().reverse();
  if (!runs.length) return res.json({ ok: true, lastRun: null, errorCount: 0 });
  try {
    const latest = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, runs[0]), 'utf-8'));
    res.json({
      ok:         latest.status === 'completed',
      lastRun:    latest.timestamp,
      status:     latest.status,
      errorCount: latest.errors?.length || 0,
    });
  } catch {
    res.json({ ok: false, lastRun: null, errorCount: -1 });
  }
});

app.get('/api/scheduler-log', (req, res) => {
  const f = path.join(REPORTS_DIR, 'scheduler.log');
  if (!fs.existsSync(f)) return res.json({ lines: [] });
  const lines = fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean).slice(-100).reverse();
  res.json({ lines });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[dashboard] http://localhost:${PORT}`);
});
