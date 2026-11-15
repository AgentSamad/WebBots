/**
 * Generates 100 unique simulated user profiles.
 * Each profile has a distinct browser fingerprint so the game
 * and monitoring system sees them as separate clients.
 */

const VIEWPORTS = [
  { width: 960,  height: 540  },
  { width: 1024, height: 576  },
  { width: 1024, height: 600  },
  { width: 1024, height: 640  },
  { width: 1024, height: 768  },
  { width: 1152, height: 648  },
  { width: 1280, height: 720  },
  { width: 1280, height: 768  },
  { width: 1280, height: 800  },
  { width: 1366, height: 768  },
];

const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Denver',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
  'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Kolkata',
  'Australia/Sydney', 'America/Sao_Paulo', 'America/Toronto',
  'Pacific/Auckland', 'Africa/Cairo', 'Asia/Dubai', 'America/Mexico_City',
  'Europe/Amsterdam',
];

const LOCALES = [
  'en-US', 'en-GB', 'en-CA', 'en-AU', 'en-IN',
  'fr-FR', 'de-DE', 'es-ES', 'it-IT', 'pt-BR',
  'ja-JP', 'zh-CN', 'ko-KR', 'ar-SA', 'ru-RU',
  'nl-NL', 'pl-PL', 'sv-SE', 'tr-TR', 'id-ID',
];

// Mobile landscape viewports (width > height)
const MOBILE_VIEWPORTS = [
  { width: 844,  height: 390 },  // iPhone 12/13 landscape
  { width: 926,  height: 428 },  // iPhone 14 Pro Max landscape
  { width: 812,  height: 375 },  // iPhone X/11 Pro landscape
  { width: 736,  height: 414 },  // iPhone 8 Plus landscape
  { width: 740,  height: 360 },  // Samsung Galaxy S21 landscape
  { width: 800,  height: 360 },  // Samsung Galaxy S22 landscape
  { width: 915,  height: 412 },  // Samsung Galaxy S20 Ultra landscape
  { width: 823,  height: 390 },  // Pixel 6 landscape
];

// Mobile Chrome / Safari user-agents (landscape capable)
const MOBILE_USER_AGENTS = [
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; Pixel 6a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
];

// Real Chrome user-agents across OS/versions
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.1; rv:131.0) Gecko/20100101 Firefox/131.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  // Mobile UAs removed — CrazyGames serves the app-store page for mobile agents (no canvas loads)
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/114.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
];

// Different play styles — affects movement/aim patterns
const PLAY_STYLES = ['aggressive', 'cautious', 'erratic', 'circular', 'zigzag'];

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function pick(arr, rand) {
  return arr[Math.floor(rand() * arr.length)];
}

function generateProfiles(count = 100) {
  return Array.from({ length: count }, (_, i) => {
    const rand      = seededRandom(i * 31337 + 7);
    const id        = i + 1;
    // Users 1-50 are mobile (landscape viewport, desktop UA to avoid CrazyGames redirect)
    // Users 51-100 are PC/desktop (wider viewport, desktop UA)
    const isMobile  = id <= 50;
    const viewport  = isMobile ? MOBILE_VIEWPORTS[i % MOBILE_VIEWPORTS.length] : VIEWPORTS[i % VIEWPORTS.length];
    const timezone  = TIMEZONES[i % TIMEZONES.length];
    const locale    = LOCALES[i % LOCALES.length];
    const ua        = USER_AGENTS[i % USER_AGENTS.length];
    const style     = PLAY_STYLES[i % PLAY_STYLES.length];
    // First visit: 15–25 min. Return visits: 7–9 min (quick session, returning player).
    const playMs       = (15 + Math.floor(rand() * 10)) * 60 * 1000;
    const returnPlayMs = ( 7 + Math.floor(rand() *  2)) * 60 * 1000;
    // Unique color-depth and hardware concurrency
    const colorDepth      = pick([24, 30, 32], rand);
    const hardwareConcurrency = pick([2, 4, 6, 8, 12, 16], rand);

    return {
      id,
      name:     `User_${String(id).padStart(3, '0')}`,
      isMobile,
      viewport,
      timezone,
      locale,
      userAgent: ua,
      playStyle: style,
      playMs,
      returnPlayMs,
      colorDepth,
      hardwareConcurrency,
      // Extra HTTP headers to vary the apparent client
      extraHeaders: {
        'Accept-Language': locale.replace('_', '-') + ',en;q=0.9',
      },
    };
  });
}

module.exports = { generateProfiles };
