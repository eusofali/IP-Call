const path = require('path');
const express = require('express');
const session = require('express-session');
const cfg = require('./config');
const { db, getSetting, setSetting, isInstalled } = require('./db');
const util = require('./util');

// ---- session store in SQLite (works on shared hosting, survives restarts) ----
class SqliteStore extends session.Store {
  get(sid, cb) {
    try {
      const r = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
      cb(null, r && r.expires > Date.now() ? JSON.parse(r.data) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      db.prepare('INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires')
        .run(sid, JSON.stringify(sess), exp);
      cb?.(null);
    } catch (e) { cb?.(e); }
  }
  destroy(sid, cb) { try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb?.(null); } catch (e) { cb?.(e); } }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 3600000).unref();

function sessionSecret() {
  if (cfg.sessionSecret) return cfg.sessionSecret;
  let s = getSetting('session_secret');
  if (!s) { s = util.token(32); setSetting('session_secret', s); }
  return s;
}

function createApp(engine) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.locals.engine = engine;

  app.use('/public', express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d' }));
  app.use('/public/icons', express.static(path.join(__dirname, '..', 'node_modules', 'bootstrap-icons', 'font'), { maxAge: '30d' }));
  app.use(express.urlencoded({ extended: false, limit: '5mb' }));
  app.use(express.json({ limit: '5mb' }));

  // Public REST API + cron use their own auth (API key / cron key), no session.
  app.use('/api/v1', require('./routes/api'));
  app.get('/cron/tick', (req, res) => {
    const key = getSetting('cron_key');
    if (!key || req.query.key !== key) return res.status(403).json({ ok: false });
    engine.tick();
    res.json({ ok: true, active: engine.active.size, driver: engine.driver.name, at: util.now() });
  });
  // Signed voice-file URLs for a remote Asterisk server (see services/media.js).
  app.get('/media/vf:id-:sig.wav', (req, res) => {
    const media = require('./services/media');
    const id = Number(req.params.id);
    const sig = String(req.params.sig);
    const want = media.mediaSig(id);
    if (sig.length !== want.length || !require('crypto').timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return res.sendStatus(403);
    const vf = db.prepare('SELECT * FROM voice_files WHERE id = ?').get(id);
    if (!vf) return res.sendStatus(404);
    const fs = require('fs');
    const file = fs.existsSync(media.remoteWav(vf)) ? media.remoteWav(vf) : media.filePath(vf);
    res.type('audio/wav').sendFile(file);
  });
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use(session({
    store: new SqliteStore(), secret: sessionSecret(), resave: false, saveUninitialized: false, name: 'ipc.sid',
    // 'auto': Secure flag only on HTTPS requests (nginx sends X-Forwarded-Proto). A fixed `secure: true`
    // makes browsers drop the cookie on plain http://IP access, and every login then fails the CSRF check.
    cookie: { httpOnly: true, sameSite: 'lax', secure: cfg.secureCookies ? 'auto' : false, maxAge: 7 * 86400000 },
  }));

  // Locals, current user, flash messages, CSRF token.
  app.use((req, res, next) => {
    res.locals.cfg = cfg;
    res.locals.u = util;
    res.locals.path = req.path;
    res.locals.query = req.query;
    if (!req.session.csrf) req.session.csrf = util.token(16);
    res.locals.csrf = req.session.csrf;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    req.flash = (type, msg) => { req.session.flash = { type, msg }; };
    if (req.session.uid) {
      req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.uid) || null;
      if (!req.user || req.user.status !== 'active') { req.user = null; delete req.session.uid; }
    }
    res.locals.user = req.user || null;
    res.locals.impersonating = !!req.session.impersonator;
    res.locals.notice = getSetting('notice', '');
    next();
  });

  // CSRF check for form posts (multipart routes call csrfCheck themselves after parsing).
  app.use((req, res, next) => {
    if (req.method !== 'POST' || req.is('multipart/form-data')) return next();
    return csrfCheck(req, res, next);
  });

  // Until the setup wizard has run, everything goes to /install.
  app.use((req, res, next) => {
    if (!isInstalled() && !req.path.startsWith('/install')) return res.redirect('/install');
    next();
  });

  app.use('/install', require('./routes/install'));
  app.use(require('./routes/auth'));
  app.use(requireAuth);
  app.use(require('./routes/panel'));
  app.use(require('./routes/telephony'));
  app.use(require('./routes/account'));
  app.use('/admin', requireAdmin, require('./routes/admin'));

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'Page not found.' }));
  app.use((err, req, res, _next) => {
    console.error(err);
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large.' : 'Something went wrong.';
    if (req.path.startsWith('/api/')) return res.status(500).json({ error: msg });
    res.status(500).render('error', { title: 'Error', message: msg });
  });
  return app;
}

function csrfCheck(req, res, next) {
  const t = req.body?._csrf || req.get('x-csrf-token');
  if (!t || t !== req.session.csrf) {
    if (req.path === '/login' || req.path.startsWith('/install')) {
      // Usually the browser didn't keep the session cookie: show the form again instead of a dead end.
      req.flash('error', 'Your session expired or cookies are blocked. Please try again (and make sure cookies are allowed for this site).');
      return res.redirect(req.path === '/login' ? '/login' : '/install');
    }
    return res.status(403).render('error', { title: 'Session expired', message: 'Your session expired. Go back, refresh the page and try again.' });
  }
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return req.path === '/' ? res.redirect('/login') : res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).render('error', { title: 'Forbidden', message: 'Admins only.' });
  next();
}

module.exports = { createApp, csrfCheck };
