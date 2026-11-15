/**
 * Crash reporter – reads latest run reports and sends
 * an email alert when errors are found.
 *
 * Configure via environment variables or config.json.
 */

const nodemailer = require('nodemailer');
const path = require('path');
const fs   = require('fs');

const CONFIG_FILE  = path.join(__dirname, 'config.json');
const REPORTS_DIR  = path.join(__dirname, 'reports');

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  }
  return {
    email: {
      enabled: false,
      host:    process.env.SMTP_HOST    || 'smtp.gmail.com',
      port:    Number(process.env.SMTP_PORT) || 587,
      user:    process.env.SMTP_USER    || '',
      pass:    process.env.SMTP_PASS    || '',
      from:    process.env.SMTP_FROM    || '',
      to:      process.env.ALERT_EMAIL  || '',
    },
  };
}

async function sendCrashEmail(config, report) {
  if (!config.email?.enabled || !config.email.user) return;

  const transporter = nodemailer.createTransport({
    host:   config.email.host,
    port:   config.email.port,
    secure: config.email.port === 465,
    auth:   { user: config.email.user, pass: config.email.pass },
  });

  const errorList = report.errors
    .map(e => `• [${e.type}] ${e.text}`)
    .join('\n');

  const html = `
    <h2>🚨 Boom Arena Bot – Crash / Error Report</h2>
    <p><strong>Run ID:</strong> ${report.id}</p>
    <p><strong>Timestamp:</strong> ${report.timestamp}</p>
    <p><strong>Status:</strong> <span style="color:red">${report.status}</span></p>
    <p><strong>Errors (${report.errors.length}):</strong></p>
    <pre style="background:#f4f4f4;padding:12px;border-radius:4px">${errorList}</pre>
    ${report.screenshotOnCrash ? `<p><strong>Screenshot:</strong> ${report.screenshotOnCrash}</p>` : ''}
    <hr>
    <p style="color:#888;font-size:12px">Boom Arena Bot – automated daily monitor</p>
  `;

  await transporter.sendMail({
    from:    config.email.from || config.email.user,
    to:      config.email.to,
    subject: `[Boom Arena Bot] ${report.status.toUpperCase()} – ${new Date(report.timestamp).toLocaleString()}`,
    html,
  });

  console.log(`[crashReporter] Alert email sent to ${config.email.to}`);
}

async function reportIfCrashed(report) {
  if (!report || report.errors.length === 0) {
    console.log('[crashReporter] Run clean – no errors to report');
    return;
  }

  const config = loadConfig();
  console.log(`[crashReporter] ${report.errors.length} error(s) found – status: ${report.status}`);

  try {
    await sendCrashEmail(config, report);
  } catch (err) {
    console.error('[crashReporter] Failed to send email:', err.message);
  }
}

function getLatestReport() {
  if (!fs.existsSync(REPORTS_DIR)) return null;
  const files = fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('run-') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (!files.length) return null;
  return JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, files[0]), 'utf-8'));
}

module.exports = { reportIfCrashed, getLatestReport, loadConfig };
