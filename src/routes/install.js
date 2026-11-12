// First-run setup wizard: environment check -> site settings -> admin account -> telephony -> done.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const cfg = require('../config');
const { db, isInstalled, saveConfig, setSetting } = require('../db');
const { token, now } = require('../util');
const { testAri } = require('../drivers/asterisk');
const { createDriver } = require('../drivers');

router.use((req, res, next) => {
  if (isInstalled()) return res.redirect('/');
  req.session.install = req.session.install || {};
  next();
});

function has(cmd) {
  try { execFileSync(cmd, ['-version'], { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; }
}
function writable(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, '.w'); fs.writeFileSync(f, 'x'); fs.unlinkSync(f); return true; } catch { return false; }
}

function checks() {
  const major = Number(process.versions.node.split('.')[0]);
  const hosting = process.env.PASSENGER_APP_ENV || process.env.PASSENGER_BASE_URI !== undefined || /cagefs|lsnode/i.test(process.argv.join(' '))
    ? 'Shared hosting (Passenger / cPanel)' : (process.getuid?.() === 0 ? 'Server (running as root)' : 'Server / VPS');
  return {
    hosting,
    list: [
      { name: 'Node.js version', value: process.versions.node, ok: major >= 18, required: true, hint: 'Node 18 or newer (22 recommended).' },
      { name: 'SQLite driver', value: db.driverName, ok: true, required: true },
      { name: 'Data folder writable', value: cfg.dataDir, ok: writable(cfg.dataDir), required: true, hint: 'Make the data/ folder writable by the app.' },
      { name: 'Uploads writable', value: path.join(cfg.dataDir, 'uploads'), ok: writable(path.join(cfg.dataDir, 'uploads')), required: true },
      { name: 'ffmpeg (audio conversion)', value: has('ffmpeg') ? 'found' : 'not found', ok: has('ffmpeg'), required: false,
        hint: 'Optional. Needed only for Asterisk mode to convert MP3 uploads. Upload WAV files if unavailable.' },
    ],
  };
}

router.get('/', (req, res) => {
  const step = Math.min(Math.max(parseInt(req.query.step, 10) || 1, 1), 4);
  const st = req.session.install;
  if (step > 1 && !st.checked) return res.redirect('/install');
  if (step > 2 && !st.site) return res.redirect('/install?step=2');
  if (step > 3 && !st.admin) return res.redirect('/install?step=3');
  const env = process.env;
  res.render('install', {
    title: 'Setup', step, st, checks: step === 1 ? checks() : null, error: null,
    defaults: {
      appName: cfg.appName, currency: cfg.currency, tz: cfg.tz, country: cfg.country, helpline: cfg.helpline,
      driver: env.CALL_DRIVER || (env.ARI_PASSWORD ? 'asterisk' : 'simulator'),
      ari: cfg.ari, asterisk: cfg.asterisk,
    },
  });
});

router.post('/step1', (req, res) => {
  const c = checks();
  if (c.list.some((x) => x.required && !x.ok)) return res.redirect('/install');
  req.session.install.checked = true;
  res.redirect('/install?step=2');
});

router.post('/step2', (req, res) => {
  const b = req.body;
  let tz = String(b.tz || 'UTC').trim();
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { tz = 'UTC'; }
  req.session.install.site = {
    appName: String(b.appName || '').trim().slice(0, 60) || 'IP Call Panel',
    currency: String(b.currency || '').trim().slice(0, 8) || '৳',
    tz, country: b.country === 'BD' ? 'BD' : 'INTL',
    helpline: String(b.helpline || '').trim().slice(0, 40),
    allowRegister: b.allowRegister ? '1' : '0',
  };
  res.redirect('/install?step=3');
});

router.post('/step3', (req, res) => {
  const b = req.body;
  const username = String(b.username || '').trim();
  const err = !/^[a-zA-Z0-9_.-]{3,32}$/.test(username) ? 'Username: 3-32 letters, numbers, . _ -'
    : String(b.password || '').length < 8 ? 'Password must be at least 8 characters.'
    : b.password !== b.password2 ? 'Passwords do not match.' : null;
  if (err) {
    return res.render('install', { title: 'Setup', step: 3, st: req.session.install, checks: null, error: err, defaults: {} });
  }
  req.session.install.admin = {
    name: String(b.name || 'Administrator').trim().slice(0, 60), username,
    email: String(b.email || '').trim().slice(0, 120), hash: bcrypt.hashSync(b.password, 10),
  };
  res.redirect('/install?step=4');
});

router.post('/test-ari', async (req, res) => {
  try { res.json({ ok: true, message: await testAri({ url: req.body.url, user: req.body.user, pass: req.body.pass }) }); }
  catch (e) { res.json({ ok: false, message: e.cause?.code || e.message }); }
});

router.post('/finish', async (req, res) => {
  const st = req.session.install;
  if (!st.site || !st.admin) return res.redirect('/install');
  const b = req.body;
  const tel = b.driver === 'asterisk'
    ? { driver: 'asterisk', 'ari.url': b.ariUrl, 'ari.user': b.ariUser, 'ari.pass': b.ariPass, 'ari.app': b.ariApp || 'ipcall',
        'asterisk.soundsDir': b.soundsDir, 'asterisk.pjsipFile': b.pjsipFile, 'asterisk.sipHost': b.sipHost }
    : { driver: 'simulator' };

  const adminId = db.transaction(() => {
    saveConfig({ ...st.site, ...tel, publicUrl: `${req.protocol}://${req.get('host')}` });
    setSetting('cron_key', token(16));
    const r = db.prepare(`INSERT INTO users (name, username, email, password_hash, role, api_key, created_at)
                          VALUES (?, ?, ?, ?, 'admin', ?, ?)`)
      .run(st.admin.name, st.admin.username, st.admin.email || null, st.admin.hash, token(24), now());
    setSetting('installed', '1');
    return Number(r.lastInsertRowid);
  })();

  try { await req.app.locals.engine.setDriver(createDriver(cfg.driver)); } catch (e) { console.warn(e.message); }
  delete req.session.install;
  req.session.uid = adminId;
  req.flash('success', 'Setup complete! Next: create a customer account (or use this one), add an IP number, upload a voice file and send a test call.');
  res.redirect('/admin/settings?welcome=1');
});

module.exports = router;
