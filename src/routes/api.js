// Public REST API (Bearer API key). See the Developers page for docs.
const router = require('express').Router();
const { db } = require('../db');
const u = require('../util');
const { createBatch, setBatchStatus, UserError } = require('../services/batches');

router.use((req, res, next) => {
  const h = req.get('authorization') || '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : (req.get('x-api-key') || req.query.api_key);
  const user = key && db.prepare('SELECT * FROM users WHERE api_key = ?').get(String(key));
  if (!user) return res.status(401).json({ error: 'Invalid or missing API key' });
  if (user.status !== 'active') return res.status(403).json({ error: 'Account suspended' });
  req.user = user;
  next();
});

const callJson = (c) => ({
  id: c.id, batch_id: c.batch_id, direction: c.direction, from: c.from_number, to: c.to_number, status: c.status,
  reason: c.fail_reason, dtmf: c.dtmf, duration: c.duration, cost: c.cost, attempts: c.attempts,
  initiated_at: c.initiated_at, sent_at: c.sent_at, answered_at: c.answered_at, ended_at: c.ended_at,
});

router.get('/balance', (req, res) => res.json({ balance: req.user.balance, rate_per_min: req.user.rate_per_min, pulse_sec: req.user.pulse_sec }));

router.get('/voice-files', (req, res) => {
  res.json({ data: db.prepare('SELECT id, name, duration, created_at FROM voice_files WHERE user_id = ? ORDER BY id DESC').all(req.user.id) });
});
router.get('/ip-numbers', (req, res) => {
  res.json({ data: db.prepare('SELECT id, number, is_main, enabled, status FROM ip_numbers WHERE user_id = ?').all(req.user.id) });
});

/** POST /api/v1/calls { numbers: ["01712..."] | "017..,018..", voice_file_id, ivr_id?, ip_number_id?, name?, schedule_at?, max_attempts? } */
router.post('/calls', (req, res) => {
  const b = req.body || {};
  const numbers = Array.isArray(b.numbers) ? b.numbers.map(String) : u.parsePhoneList(b.numbers || b.number || b.to || '').valid;
  try {
    const r = createBatch(req.user, {
      numbers, groupIds: Array.isArray(b.group_ids) ? b.group_ids.map(Number) : [],
      voiceFileId: u.int(b.voice_file_id), ivrId: u.int(b.ivr_id), ipNumberId: u.int(b.ip_number_id),
      name: b.name ? String(b.name).slice(0, 80) : 'API', scheduledAt: b.schedule_at ? new Date(b.schedule_at).toISOString() : null,
      maxAttempts: b.max_attempts, retryDelaySec: b.retry_delay_sec, source: 'api',
    });
    res.status(201).json({ batch_id: r.batchId, queued: r.queued, invalid: r.invalid, skipped_banned: r.skippedBanned, scheduled: r.scheduled });
  } catch (e) {
    if (e instanceof UserError || e instanceof RangeError) return res.status(422).json({ error: e.message });
    throw e;
  }
});

router.get('/calls', (req, res) => {
  const limit = Math.min(u.int(req.query.limit, 50), 500);
  const where = ['user_id = ?'], args = [req.user.id];
  if (req.query.batch_id) { where.push('batch_id = ?'); args.push(u.int(req.query.batch_id)); }
  if (req.query.status) { where.push('status = ?'); args.push(String(req.query.status)); }
  if (req.query.after_id) { where.push('id > ?'); args.push(u.int(req.query.after_id)); }
  res.json({ data: db.prepare(`SELECT * FROM calls WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args, limit).map(callJson) });
});
router.get('/calls/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM calls WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(callJson(c));
});

router.get('/batches/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM batches WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  const s = db.prepare(`SELECT SUM(status='completed') completed, SUM(status='failed') failed, SUM(status='cancelled') cancelled,
                         SUM(status IN ('queued','dialing','ringing','answered')) pending, COALESCE(SUM(cost),0) cost
                        FROM calls WHERE batch_id = ?`).get(b.id);
  res.json({ id: b.id, name: b.name, status: b.status, pause_reason: b.pause_reason, total: b.total, ...s, created_at: b.created_at });
});
router.post('/batches/:id/:action(pause|resume|cancel)', (req, res) => {
  try { setBatchStatus(req.user.id, u.int(req.params.id), req.params.action); res.json({ ok: true }); }
  catch (e) { if (e instanceof UserError) return res.status(422).json({ error: e.message }); throw e; }
});

router.use((err, req, res, _next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });
router.use((req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

module.exports = router;
