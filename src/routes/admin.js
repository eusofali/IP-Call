const router = require('express').Router();
const bcrypt = require('bcryptjs');
const cfg = require('../config');
const { db, getSetting, setSetting, saveConfig } = require('../db');
const u = require('../util');
const { adjust } = require('../services/billing');
const { generatePjsip, applyPjsip } = require('../services/asterisk-config');
const { testAri } = require('../drivers/asterisk');
const { createDriver } = require('../drivers');

router.get('/users', (req, res) => {
  const q = String(req.query.q || '').trim();
  const rows = db.prepare(`SELECT us.*,
        (SELECT COUNT(*) FROM calls c WHERE c.user_id = us.id) calls,
        (SELECT COUNT(*) FROM ip_numbers i WHERE i.user_id = us.id) trunks
      FROM users us ${q ? 'WHERE us.username LIKE ? OR us.name LIKE ? OR us.email LIKE ?' : ''} ORDER BY us.id DESC LIMIT 500`)
    .all(...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []));
  const sys = db.prepare(`SELECT COUNT(*) total, SUM(status='completed') success, COALESCE(SUM(cost),0) revenue FROM calls`).get();
  res.render('admin_users', { title: 'Users', active: 'admin-users', rows, q, sys });
});

router.post('/users', (req, res) => {
  const b = req.body;
  const username = String(b.username || '').trim();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username) || String(b.password || '').length < 8) {
    req.flash('error', 'Username 3-32 chars and password at least 8 characters.'); return res.redirect('/admin/users');
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) { req.flash('error', 'Username taken.'); return res.redirect('/admin/users'); }
  db.prepare(`INSERT INTO users (name, username, email, phone, password_hash, role, rate_per_min, pulse_sec, max_extensions, api_key, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(String(b.name || username).trim(), username, b.email || null, b.phone || null, bcrypt.hashSync(b.password, 10),
      b.role === 'admin' ? 'admin' : 'user', u.num(b.rate_per_min, 0.35), u.int(b.pulse_sec, 60), u.int(b.max_extensions, 10), u.token(24), u.now());
  req.flash('success', `User ${username} created.`);
  res.redirect('/admin/users');
});

router.post('/users/:id/update', (req, res) => {
  const b = req.body;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.redirect('/admin/users');
  const role = target.id === req.user.id ? 'admin' : (b.role === 'admin' ? 'admin' : 'user');
  const status = target.id === req.user.id ? 'active' : (b.status === 'suspended' ? 'suspended' : 'active');
  db.prepare(`UPDATE users SET name=?, email=?, phone=?, role=?, status=?, rate_per_min=?, pulse_sec=?, max_extensions=? WHERE id = ?`)
    .run(String(b.name || target.name).trim(), b.email || null, b.phone || null, role, status,
      Math.max(0, u.num(b.rate_per_min, target.rate_per_min)), Math.max(1, u.int(b.pulse_sec, target.pulse_sec)),
      Math.max(0, u.int(b.max_extensions, target.max_extensions)), target.id);
  if (b.password) {
    if (b.password.length < 8) req.flash('error', 'Password not changed: minimum 8 characters.');
    else db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(b.password, 10), target.id);
  }
  if (!req.session.flash) req.flash('success', 'User updated.');
  res.redirect('/admin/users');
});

router.post('/users/:id/balance', (req, res) => {
  const amount = u.num(req.body.amount, 0);
  const type = req.body.type === 'adjust' ? 'adjust' : (amount >= 0 ? 'topup' : 'adjust');
  if (!amount) { req.flash('error', 'Enter an amount.'); return res.redirect('/admin/users'); }
  const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.redirect('/admin/users');
  const bal = adjust(target.id, amount, type, String(req.body.note || '').slice(0, 200) || (amount > 0 ? 'Balance top-up' : 'Balance deduction'), { createdBy: req.user.id });
  // Batches paused for low balance can continue now.
  if (amount > 0) db.prepare("UPDATE batches SET status = 'running', pause_reason = NULL WHERE user_id = ? AND status = 'paused' AND pause_reason = 'Insufficient balance'").run(target.id);
  req.flash('success', `${target.username}: balance is now ${u.fmtMoney(bal)}.`);
  res.redirect('/admin/users');
});

router.post('/users/:id/impersonate', (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (target && target.id !== req.user.id) { req.session.impersonator = req.user.id; req.session.uid = target.id; }
  res.redirect('/');
});

router.post('/users/:id/delete', (req, res) => {
  if (Number(req.params.id) === req.user.id) { req.flash('error', 'You cannot delete yourself.'); return res.redirect('/admin/users'); }
  const active = [...req.app.locals.engine.active.values()].some((a) => a.userId === Number(req.params.id));
  if (active) { req.flash('error', 'User has calls in progress.'); return res.redirect('/admin/users'); }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  req.flash('success', 'User deleted.');
  res.redirect('/admin/users');
});

// ---------------- Settings ----------------
router.get('/settings', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.render('admin_settings', {
    title: 'Settings', active: 'admin-settings', welcome: req.query.welcome === '1',
    cronUrl: `${base}/cron/tick?key=${getSetting('cron_key')}`, notice: getSetting('notice', ''),
    pjsip: cfg.driver === 'asterisk' ? generatePjsip() : null, engine: req.app.locals.engine,
  });
});

router.post('/settings/site', (req, res) => {
  const b = req.body;
  let tz = String(b.tz || 'UTC').trim();
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { tz = cfg.tz; }
  saveConfig({
    appName: String(b.appName || '').trim().slice(0, 60) || cfg.appName, currency: String(b.currency || '').trim().slice(0, 8) || cfg.currency,
    tz, country: b.country === 'BD' ? 'BD' : 'INTL', helpline: String(b.helpline || '').trim().slice(0, 40),
    allowRegister: b.allowRegister ? '1' : '0', billing: b.billing ? '1' : '0', maxConcurrent: String(Math.max(1, u.int(b.maxConcurrent, cfg.maxConcurrent))),
  });
  setSetting('notice', String(b.notice || '').slice(0, 1000));
  req.flash('success', 'Settings saved.');
  res.redirect('/admin/settings');
});

router.post('/settings/telephony', async (req, res) => {
  const b = req.body;
  const engine = req.app.locals.engine;
  const map = b.driver === 'asterisk'
    ? { driver: 'asterisk', 'ari.url': b.ariUrl, 'ari.user': b.ariUser, 'ari.app': b.ariApp || 'ipcall',
        'asterisk.soundsDir': b.soundsDir, 'asterisk.pjsipFile': b.pjsipFile, 'asterisk.sipHost': b.sipHost, 'asterisk.mohClass': b.mohClass || 'default', publicUrl: String(b.publicUrl || '').trim().replace(/\/+$/, '') }
    : { driver: 'simulator', simSpeed: String(Math.max(1, u.int(b.simSpeed, 1))) };
  if (b.driver === 'asterisk' && b.ariPass) map['ari.pass'] = b.ariPass;
  const prev = cfg.driver;
  saveConfig(map);
  try {
    if (prev !== cfg.driver || cfg.driver === 'asterisk') await engine.setDriver(createDriver(cfg.driver));
    req.flash('success', `Telephony saved. Engine is using "${cfg.driver}".`);
  } catch (e) {
    req.flash('error', `Saved, but the driver could not be switched now (${e.message}). Restart the app after calls finish.`);
  }
  res.redirect('/admin/settings');
});

router.post('/settings/test-ari', async (req, res) => {
  try { res.json({ ok: true, message: await testAri({ url: req.body.url || cfg.ari.url, user: req.body.user || cfg.ari.user, pass: req.body.pass || cfg.ari.pass }) }); }
  catch (e) { res.json({ ok: false, message: e.cause?.code || e.message }); }
});

router.post('/settings/apply-pjsip', async (req, res) => {
  try { req.flash('success', await applyPjsip(req.app.locals.engine.driver)); }
  catch (e) { req.flash('error', 'Failed: ' + e.message); }
  res.redirect('/admin/settings');
});

router.post('/settings/cron-key', (req, res) => {
  setSetting('cron_key', u.token(16));
  req.flash('success', 'New cron key generated; update your cron job.');
  res.redirect('/admin/settings');
});

module.exports = router;
