const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const u = require('../util');
const { pulseCost } = require('../services/billing');

// ---------------- Billing ----------------
router.get('/billing', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) n FROM transactions WHERE user_id = ?').get(req.user.id).n;
  const pg = u.paginate(total, u.int(req.query.page, 1), 50);
  const rows = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(req.user.id, pg.per, pg.offset);
  const month = db.prepare(`SELECT COALESCE(-SUM(amount),0) spent FROM transactions WHERE user_id = ? AND type = 'call' AND created_at >= ?`)
    .get(req.user.id, u.localDayToUtc(u.todayLocal().slice(0, 8) + '01')).spent;
  res.render('billing', { title: 'Billing', active: 'billing', rows, pg, month, minCost: pulseCost(req.user) });
});

// ---------------- Developers / API ----------------
router.get('/developers', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const sample = {
    voiceFile: db.prepare('SELECT id FROM voice_files WHERE user_id = ? ORDER BY id DESC').get(req.user.id)?.id || 1,
  };
  res.render('developers', { title: 'Developers', active: 'developers', base, sample });
});
router.post('/developers/regenerate', (req, res) => {
  db.prepare('UPDATE users SET api_key = ? WHERE id = ?').run(u.token(24), req.user.id);
  req.flash('success', 'New API key generated. The old key no longer works.');
  res.redirect('/developers');
});

// ---------------- Support tickets ----------------
router.get('/tickets', (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const rows = db.prepare(`SELECT t.*, us.username, (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) msgs
                           FROM tickets t JOIN users us ON us.id = t.user_id ${isAdmin ? '' : 'WHERE t.user_id = ?'}
                           ORDER BY (t.status = 'closed'), t.updated_at DESC LIMIT 200`).all(...(isAdmin ? [] : [req.user.id]));
  res.render('tickets', { title: 'Support Ticket', active: 'tickets', rows });
});
router.post('/tickets', (req, res) => {
  const subject = String(req.body.subject || '').trim().slice(0, 140);
  const body = String(req.body.body || '').trim().slice(0, 5000);
  if (!subject || !body) { req.flash('error', 'Subject and message are required.'); return res.redirect('/tickets'); }
  const ts = u.now();
  const id = db.transaction(() => {
    const r = db.prepare('INSERT INTO tickets (user_id, subject, priority, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(req.user.id, subject, ['low', 'normal', 'high'].includes(req.body.priority) ? req.body.priority : 'normal', ts, ts);
    db.prepare('INSERT INTO ticket_messages (ticket_id, user_id, body, created_at) VALUES (?,?,?,?)').run(r.lastInsertRowid, req.user.id, body, ts);
    return r.lastInsertRowid;
  })();
  res.redirect('/tickets/' + id);
});
const findTicket = (req) => db.prepare(`SELECT t.*, us.username FROM tickets t JOIN users us ON us.id = t.user_id WHERE t.id = ? ${req.user.role === 'admin' ? '' : 'AND t.user_id = ' + Number(req.user.id)}`).get(req.params.id);
router.get('/tickets/:id', (req, res) => {
  const t = findTicket(req);
  if (!t) return res.redirect('/tickets');
  const msgs = db.prepare(`SELECT m.*, us.name, us.role FROM ticket_messages m JOIN users us ON us.id = m.user_id WHERE ticket_id = ? ORDER BY m.id`).all(t.id);
  res.render('ticket_show', { title: `Ticket #${t.id}`, active: 'tickets', t, msgs });
});
router.post('/tickets/:id/reply', (req, res) => {
  const t = findTicket(req);
  const body = String(req.body.body || '').trim().slice(0, 5000);
  if (t && body) {
    db.prepare('INSERT INTO ticket_messages (ticket_id, user_id, body, created_at) VALUES (?,?,?,?)').run(t.id, req.user.id, body, u.now());
    const status = req.user.role === 'admin' && t.user_id !== req.user.id ? 'answered' : 'open';
    db.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?').run(status, u.now(), t.id);
  }
  res.redirect('/tickets/' + req.params.id);
});
router.post('/tickets/:id/close', (req, res) => {
  const t = findTicket(req);
  if (t) db.prepare("UPDATE tickets SET status = 'closed', updated_at = ? WHERE id = ?").run(u.now(), t.id);
  res.redirect('/tickets/' + req.params.id);
});

// ---------------- Tutorial & profile ----------------
router.get('/tutorial', (req, res) => res.render('tutorial', { title: 'Tutorial', active: 'tutorial' }));

router.get('/profile', (req, res) => res.render('profile', { title: 'Profile', active: '' }));
router.post('/profile', (req, res) => {
  const b = req.body;
  db.prepare('UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?')
    .run(String(b.name || '').trim().slice(0, 60) || req.user.name, String(b.email || '').trim() || null, String(b.phone || '').trim() || null, req.user.id);
  if (b.new_password) {
    if (!bcrypt.compareSync(b.current_password || '', req.user.password_hash)) { req.flash('error', 'Current password is wrong.'); return res.redirect('/profile'); }
    if (b.new_password.length < 8) { req.flash('error', 'New password must be at least 8 characters.'); return res.redirect('/profile'); }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(b.new_password, 10), req.user.id);
  }
  req.flash('success', 'Profile saved.');
  res.redirect('/profile');
});

module.exports = router;
