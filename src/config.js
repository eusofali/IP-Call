require('dotenv').config({ quiet: true });
const path = require('path');
const env = process.env;

const cfg = {
  appName: env.APP_NAME || 'IP Call Panel',
  port: Number(env.PORT) || 3000,
  dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
  sessionSecret: env.SESSION_SECRET || '',
  tz: env.DISPLAY_TZ || 'Asia/Dhaka',
  currency: env.CURRENCY || '৳',
  country: env.DEFAULT_COUNTRY || 'BD',
  allowRegister: env.ALLOW_REGISTER === '1',
  helpline: env.HELPLINE || '',
  secureCookies: env.SECURE_COOKIES === '1',
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''), // e.g. https://panel.example.com (used for remote Asterisk media)
  // Call engine
  driver: env.CALL_DRIVER || 'simulator', // simulator | asterisk
  simSpeed: Number(env.SIM_SPEED) || 1,
  maxConcurrent: Number(env.MAX_CONCURRENT) || 50,
  tickMs: Number(env.ENGINE_TICK_MS) || 1000,
  ari: {
    url: env.ARI_URL || 'http://127.0.0.1:8088',
    user: env.ARI_USER || 'ipcall',
    pass: env.ARI_PASSWORD || '',
    app: env.ARI_APP || 'ipcall',
  },
  asterisk: {
    soundsDir: env.ASTERISK_SOUNDS_DIR || '', // e.g. /var/lib/asterisk/sounds/ipcall
    pjsipFile: env.ASTERISK_PJSIP_FILE || '', // e.g. /etc/asterisk/pjsip_ipcall.conf
    sipHost: env.SIP_PUBLIC_HOST || '',       // shown to users as extension server/domain
    mohClass: env.ASTERISK_MOH_CLASS || 'default',
  },
};

// Settings saved by the setup wizard / admin settings page override .env values.
// Keys are flat: "appName", "ari.url", "asterisk.soundsDir", ...
const EDITABLE = ['appName', 'publicUrl', 'currency', 'tz', 'country', 'helpline', 'allowRegister', 'driver', 'simSpeed', 'maxConcurrent',
  'ari.url', 'ari.user', 'ari.pass', 'ari.app', 'asterisk.soundsDir', 'asterisk.pjsipFile', 'asterisk.sipHost', 'asterisk.mohClass'];

function applyOverrides(map) {
  for (const key of EDITABLE) {
    if (!(key in map) || map[key] === null || map[key] === undefined) continue;
    const [a, b] = key.split('.');
    const target = b ? cfg[a] : cfg;
    const k = b || a;
    const cur = target[k];
    let v = map[key];
    if (typeof cur === 'number') v = Number(v) || cur;
    else if (typeof cur === 'boolean') v = v === true || v === '1' || v === 'true';
    target[k] = v;
  }
}
cfg.EDITABLE = EDITABLE;
cfg.applyOverrides = applyOverrides;
module.exports = cfg;
