const router = require('express').Router();
const bcrypt = require('bcryptjs');
const cfg = require('../config');
const { db } = require('../db');
const { now, token } = require('../util');

// Basic brute-force protection: 10 failed logins per IP per 15 minutes.
const fails = new Map();
const limited = (ip) => { const f = fails.get(ip); return f && f.n >= 10 && Date.now() - f.t < 900000; };
const fail = (ip) => { const f = fails.get(ip); fails.set(ip, f && Date.now() - f.t < 900000 ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() }); };

const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)/.test(n) ? n : '/');

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Login', error: res.locals.flash?.msg || null, next: req.query.next || '' });
});

router.post('/login', (req, res) => {
  const ip = req.ip;
  const next = safeNext(req.body.next);
  if (limited(ip)) return res.status(429).render('login', { title: 'Login', error: 'Too many attempts. Try again in 15 minutes.', next });
  const u = db.prepare('SELECT * FROM users WHERE username = ? OR (email IS NOT NULL AND email = ?)').get(req.body.username || '', req.body.username || '');
  if (!u || !bcrypt.compareSync(req.body.password || '', u.password_hash)) {
    fail(ip);
    return res.status(401).render('login', { title: 'Login', error: 'Wrong username or password.', next });
  }
  if (u.status !== 'active') return res.status(403).render('login', { title: 'Login', error: 'This account is suspended. Contact support.', next });
  fails.delete(ip);
  req.session.regenerate(() => { req.session.uid = u.id; res.redirect(next); });
});

router.get('/register', (req, res) => {
  if (!cfg.allowRegister) return res.redirect('/login');
  res.render('register', { title: 'Register', error: null, form: {} });
});

router.post('/register', (req, res) => {
  if (!cfg.allowRegister) return res.redirect('/login');
  const b = req.body;
  const username = String(b.username || '').trim();
  const err = !String(b.name || '').trim() ? 'Name is required.'
    : !/^[a-zA-Z0-9_.-]{3,32}$/.test(username) ? 'Username: 3-32 letters, numbers, . _ -'
    : String(b.password || '').length < 8 ? 'Password must be at least 8 characters.'
    : db.prepare('SELECT 1 FROM users WHERE username = ?').get(username) ? 'That username is taken.' : null;
  if (err) return res.render('register', { title: 'Register', error: err, form: b });
  const r = db.prepare(`INSERT INTO users (name, username, email, phone, password_hash, api_key, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(b.name.trim(), username, b.email || null, b.phone || null, bcrypt.hashSync(b.password, 10), token(24), now());
  req.session.regenerate(() => { req.session.uid = Number(r.lastInsertRowid); res.redirect('/'); });
});

router.post('/logout', (req, res) => {
  const adminId = req.session.impersonator;
  if (adminId) { req.session.uid = adminId; delete req.session.impersonator; return res.redirect('/admin/users'); }
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
