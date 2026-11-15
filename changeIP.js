/**
 * IP changer — called between every batch of 5 bots.
 *
 * Set METHOD below to match what you have:
 *
 *   'dhcp'      — release + renew your network adapter (works if your ISP
 *                 gives a new IP on reconnect; free, no VPN needed)
 *   'nordvpn'   — disconnect then reconnect NordVPN to a different server
 *   'expressvpn'— switch ExpressVPN server
 *   'custom'    — run any command you provide in CUSTOM_COMMAND
 */

const { execSync, exec, spawn } = require('child_process');
const https = require('https');
const http  = require('http');
const dns   = require('dns');
const path  = require('path');
const os    = require('os');
const fs    = require('fs');

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIGURE HERE
// ─────────────────────────────────────────────────────────────────────────────

const METHOD = 'openvpn';  // 'dhcp' | 'nordvpn' | 'expressvpn' | 'planetvpn' | 'openvpn' | 'custom'

// Only for METHOD = 'custom': the shell command to run that changes your IP
const CUSTOM_COMMAND = '';

// NordVPN server groups to rotate through (used with METHOD = 'nordvpn')
const NORD_LOCATIONS = [
  'United States', 'United Kingdom', 'Germany',
  'Netherlands', 'France', 'Canada', 'Australia',
  'Japan', 'Singapore', 'Sweden',
];
let nordIndex = 0;

// How long to wait for the IP to change before giving up (ms)
const TIMEOUT_MS = 60_000;

// ─────────────────────────────────────────────────────────────────────────────

function getPublicIP() {
  return new Promise((resolve, reject) => {
    https.get('https://api.ipify.org?format=json', res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data).ip); } catch { reject(new Error('Bad response from ipify')); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function runCmd(cmd, timeoutMs = 30_000) {
  try {
    execSync(cmd, { stdio: 'pipe', timeout: timeoutMs });
    return true;
  } catch (e) {
    console.error(`[changeIP] Command failed: ${cmd}\n  ${e.message}`);
    return false;
  }
}

// ── methods ───────────────────────────────────────────────────────────────────

async function changeDHCP() {
  // Find the active Ethernet/Wi-Fi adapter name
  let adapter = 'Ethernet';
  try {
    const out = execSync('netsh interface show interface', { encoding: 'utf8' });
    const match = out.match(/Connected\s+Dedicated\s+(\S+)/);
    if (match) adapter = match[1];
    else {
      // Try Wi-Fi
      const wifiMatch = out.match(/Connected\s+\S+\s+(Wi-Fi|Wireless|WLAN)/i);
      if (wifiMatch) adapter = wifiMatch[1];
    }
  } catch {}

  console.log(`[changeIP] DHCP release/renew on adapter: "${adapter}"`);
  runCmd(`ipconfig /release "${adapter}"`);
  await sleep(2000);
  runCmd(`ipconfig /renew "${adapter}"`);
  await sleep(3000);
}

async function changeNordVPN() {
  const loc = NORD_LOCATIONS[nordIndex % NORD_LOCATIONS.length];
  nordIndex++;
  console.log(`[changeIP] NordVPN → disconnecting, then connecting to "${loc}"`);
  runCmd('nordvpn -d');
  await sleep(3000);
  runCmd(`nordvpn -c -g "${loc}"`);
  await sleep(5000);
}

async function changeExpressVPN() {
  console.log('[changeIP] ExpressVPN → disconnecting then reconnecting');
  runCmd('expressvpn disconnect');
  await sleep(3000);
  runCmd('expressvpn connect smart');
  await sleep(5000);
}

async function changePlanetVPN() {
  const script = path.join(__dirname, 'planetvpn-control.ps1');
  const ps = `powershell -ExecutionPolicy Bypass -File "${script}"`;
  console.log('[changeIP] PlanetVPN → disconnecting…');
  runCmd(`${ps} -Action disconnect`, 45_000);
  await sleep(4000);
  console.log('[changeIP] PlanetVPN → connecting to new server…');
  runCmd(`${ps} -Action connect`, 60_000);
  await sleep(5000); // small extra wait after script returns
}

// ── OpenVPN + VPN Gate ────────────────────────────────────────────────────────

const OPENVPN_EXE = 'C:\\Program Files\\OpenVPN\\bin\\openvpn.exe';
let _ovpnProc = null;

function _killOpenVPN() {
  if (_ovpnProc) {
    try { _ovpnProc.kill(); } catch {}
    _ovpnProc = null;
  }
  try { execSync('taskkill /F /IM openvpn.exe', { stdio: 'pipe' }); } catch {}
}

const _vpnGateResolver = new dns.Resolver();
_vpnGateResolver.setServers(['8.8.8.8', '8.8.4.4']);  // bypass local DNS if vpngate.net is unresolvable

function _fetchVPNGate() {
  return new Promise((resolve, reject) => {
    // Resolve hostname via Google DNS first, then connect via IP with Host header
    _vpnGateResolver.resolve4('www.vpngate.net', (err, addresses) => {
      if (err) { return reject(new Error(`DNS for vpngate.net failed: ${err.message}`)); }
      const ip = addresses[0];
      const req = http.get({
        hostname: ip, path: '/api/iphone/',
        headers: { Host: 'www.vpngate.net' },
        timeout: 20_000,
      }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('VPN Gate fetch timeout')); });
    });
  });
}

function _parseVPNGate(csv) {
  return csv.split('\n')
    .filter(l => l && !l.startsWith('*') && !l.startsWith('#'))
    .map(line => {
      const c = line.split(',');
      if (c.length < 15) return null;
      const configB64 = c[14]?.trim();
      if (!configB64 || configB64.length < 100) return null;
      return { ip: c[1], score: parseInt(c[2]) || 0, country: c[5], configB64 };
    })
    .filter(Boolean);
}

async function changeOpenVPN() {
  const tmpOvpn = path.join(os.tmpdir(), 'vpngate_tmp.ovpn');

  // Kill any existing OpenVPN tunnel
  console.log('[changeIP] OpenVPN → killing existing tunnel…');
  _killOpenVPN();
  await sleep(2000);

  // Fetch VPN Gate server list
  console.log('[changeIP] OpenVPN → fetching VPN Gate server list…');
  let csv;
  try { csv = await _fetchVPNGate(); }
  catch (e) {
    console.error('[changeIP] VPN Gate fetch failed:', e.message);
    return false;
  }

  const servers = _parseVPNGate(csv);
  if (!servers.length) {
    console.error('[changeIP] No VPN Gate OpenVPN servers found in response');
    return false;
  }

  // Pick randomly from top 30 by score
  const pool   = servers.sort((a, b) => b.score - a.score).slice(0, 30);
  const server = pool[Math.floor(Math.random() * pool.length)];
  console.log(`[changeIP] OpenVPN → connecting to ${server.country} (${server.ip})…`);

  // Write decoded .ovpn config
  const ovpnContent = Buffer.from(server.configB64, 'base64').toString('utf8');
  fs.writeFileSync(tmpOvpn, ovpnContent);

  // Spawn openvpn and wait for "Initialization Sequence Completed"
  return new Promise(resolve => {
    _ovpnProc = spawn(OPENVPN_EXE, ['--config', tmpOvpn], { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      console.warn('[changeIP] OpenVPN connect timeout (60s)');
      resolve(false);
    }, 60_000);

    let done = false;
    const onOut = chunk => {
      const txt = chunk.toString();
      if (!done && txt.includes('Initialization Sequence Completed')) {
        done = true;
        clearTimeout(timer);
        console.log(`[changeIP] OpenVPN ✓ tunnel up — ${server.country} ${server.ip}`);
        resolve(true);
      }
    };

    _ovpnProc.stdout.on('data', onOut);
    _ovpnProc.stderr.on('data', onOut);

    _ovpnProc.on('exit', code => {
      if (!done) {
        clearTimeout(timer);
        console.error(`[changeIP] OpenVPN exited (code ${code}) before connecting`);
        _ovpnProc = null;
        resolve(false);
      }
    });
  });
}

async function changeCustom() {
  if (!CUSTOM_COMMAND) {
    console.warn('[changeIP] CUSTOM_COMMAND is empty — skipping IP change');
    return;
  }
  console.log(`[changeIP] Running custom: ${CUSTOM_COMMAND}`);
  runCmd(CUSTOM_COMMAND);
  await sleep(3000);
}

// ── main export ───────────────────────────────────────────────────────────────

async function changeIP() {
  let oldIP;
  try { oldIP = await getPublicIP(); } catch { oldIP = 'unknown'; }
  console.log(`[changeIP] Current IP: ${oldIP} — switching via method: ${METHOD}`);

  switch (METHOD) {
    case 'nordvpn':    await changeNordVPN();    break;
    case 'expressvpn': await changeExpressVPN(); break;
    case 'planetvpn':  await changePlanetVPN();  break;
    case 'openvpn':    await changeOpenVPN();    break;
    case 'custom':     await changeCustom();     break;
    case 'dhcp':
    default:          await changeDHCP();      break;
  }

  // Wait until IP actually changes (or timeout)
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const newIP = await getPublicIP();
      if (newIP && newIP !== oldIP) {
        console.log(`[changeIP] ✓ IP changed: ${oldIP} → ${newIP}`);
        return { oldIP, newIP, changed: true };
      }
    } catch {}
    await sleep(3000);
  }

  // Timed out — same IP or unreachable
  let finalIP;
  try { finalIP = await getPublicIP(); } catch { finalIP = 'unknown'; }
  console.warn(`[changeIP] ✗ IP did not change after ${TIMEOUT_MS/1000}s — still: ${finalIP}`);
  return { oldIP, newIP: finalIP, changed: false };
}

module.exports = { changeIP, getPublicIP };
