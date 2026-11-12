const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const router = require('express').Router();
const multer = require('multer');
const { db } = require('../db');
const { csrfCheck } = require('../app');
const u = require('../util');
const media = require('../services/media');
const { createBatch, setBatchStatus, UserError } = require('../services/batches');

const back = (req, res, fallback) => res.redirect(req.get('referer') || fallback);
const page = (req) => u.int(req.query.page, 1);

// ---------------- Dashboard ----------------
router.get('/', (req, res) => {
  const uid = req.user.id;
  const totals = db.prepare(`SELECT COUNT(*) total,
      SUM(status = 'completed') success, SUM(status = 'failed') failed,
      SUM(status IN ('queued','dialing','ringing','answered')) processing
    FROM calls WHERE user_id = ? AND direction = 'out'`).get(uid);
  const since = u.localDayToUtc(u.todayLocal());
  const today = db.prepare(`SELECT SUM(status = 'completed') success, SUM(status = 'failed') failed, COALESCE(SUM(cost),0) cost
    FROM calls WHERE user_id = ? AND initiated_at >= ?`).get(uid, since);
  const counts = {
    contacts: db.prepare('SELECT COUNT(*) n FROM contacts WHERE user_id = ?').get(uid).n,
    bannedContacts: db.prepare('SELECT COUNT(*) n FROM contacts WHERE user_id = ? AND banned = 1').get(uid).n,
    groups: db.prepare('SELECT COUNT(*) n FROM contact_groups WHERE user_id = ?').get(uid).n,
    bannedGroups: db.prepare('SELECT COUNT(*) n FROM contact_groups WHERE user_id = ? AND banned = 1').get(uid).n,
  };
  // last 14 days chart
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = u.fmtDate(new Date(Date.now() - i * 86400000).toISOString()).slice(0, 10);
    const r = db.prepare(`SELECT SUM(status='completed') s, SUM(status='failed') f FROM calls
                          WHERE user_id = ? AND initiated_at >= ? AND initiated_at <= ?`).get(uid, u.localDayToUtc(d), u.localDayToUtc(d, true));
    days.push({ d: d.slice(5), s: r.s || 0, f: r.f || 0 });
  }
  const batches = db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM calls c WHERE c.batch_id = b.id AND c.status IN ('completed','failed','cancelled')) done
                              FROM batches b WHERE user_id = ? ORDER BY id DESC LIMIT 5`).all(uid);
  const trunks = db.prepare('SELECT * FROM ip_numbers WHERE user_id = ? ORDER BY is_main DESC, id').all(uid);
  res.render('dashboard', { title: 'Dashboard', active: 'dashboard', totals, today, counts, days, batches, trunks });
});

router.get('/live', (req, res) => {
  const engine = req.app.locals.engine;
  const calls = engine.liveCalls(req.user.id).map((c) => ({
    id: c.id, direction: c.direction, from: u.fmtPhone(c.from_number), to: u.fmtPhone(c.to_number), status: c.status,
    since: c.answered_at || c.sent_at,
  }));
  const queued = db.prepare("SELECT COUNT(*) n FROM calls c JOIN batches b ON b.id=c.batch_id WHERE c.user_id = ? AND c.status = 'queued' AND b.status='running'").get(req.user.id).n;
  res.json({ calls, queued, balance: db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id).balance, serverTime: Date.now() });
});

router.post('/calls/:id/hangup', (req, res) => {
  const c = db.prepare('SELECT * FROM calls WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (c) req.app.locals.engine.hangup(c.id);
  res.json({ ok: !!c });
});

// ---------------- Contacts ----------------
router.get('/contacts', (req, res) => {
  const uid = req.user.id;
  const q = String(req.query.q || '').trim();
  const where = ['c.user_id = ?'];
  const args = [uid];
  if (q) { where.push('(c.phone LIKE ? OR c.name LIKE ?)'); args.push(`%${q.replace(/^\+|^0/, '')}%`, `%${q}%`); }
  if (req.query.banned === '1') where.push('c.banned = 1');
  if (req.query.group) { where.push('EXISTS (SELECT 1 FROM group_members gm WHERE gm.contact_id = c.id AND gm.group_id = ?)'); args.push(u.int(req.query.group)); }
  const total = db.prepare(`SELECT COUNT(*) n FROM contacts c WHERE ${where.join(' AND ')}`).get(...args).n;
  const pg = u.paginate(total, page(req), 50);
  const rows = db.prepare(`SELECT c.*, (SELECT GROUP_CONCAT(g.name, ', ') FROM group_members gm JOIN contact_groups g ON g.id = gm.group_id WHERE gm.contact_id = c.id) groups
                           FROM contacts c WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT ? OFFSET ?`).all(...args, pg.per, pg.offset);
  const groups = db.prepare('SELECT * FROM contact_groups WHERE user_id = ? ORDER BY name').all(uid);
  res.render('contacts', { title: 'Manage Contact', active: 'contacts', rows, pg, groups, q });
});

function addToGroup(uid, groupId, contactIds) {
  if (!groupId) return;
  const g = db.prepare('SELECT id FROM contact_groups WHERE id = ? AND user_id = ?').get(groupId, uid);
  if (!g) return;
  const ins = db.prepare('INSERT OR IGNORE INTO group_members (group_id, contact_id) VALUES (?, ?)');
  for (const id of contactIds) ins.run(g.id, id);
}

/** Insert or update contacts; returns { ids, added, invalid } */
const upsertContacts = db.transaction((uid, items) => {
  const ids = [];
  let added = 0, invalid = 0;
  const find = db.prepare('SELECT id FROM contacts WHERE user_id = ? AND phone = ?');
  const ins = db.prepare('INSERT INTO contacts (user_id, name, phone, created_at) VALUES (?, ?, ?, ?)');
  const upd = db.prepare("UPDATE contacts SET name = COALESCE(NULLIF(?, ''), name) WHERE id = ?");
  for (const it of items) {
    const phone = u.normalizePhone(it.phone);
    if (!phone) { invalid++; continue; }
    const ex = find.get(uid, phone);
    if (ex) { upd.run(it.name || '', ex.id); ids.push(ex.id); }
    else { ids.push(Number(ins.run(uid, it.name || null, phone, u.now()).lastInsertRowid)); added++; }
  }
  return { ids, added, invalid };
});

router.post('/contacts', (req, res) => {
  const { ids, added, invalid } = upsertContacts(req.user.id, [{ name: String(req.body.name || '').trim(), phone: req.body.phone }]);
  if (invalid) req.flash('error', 'Invalid phone number.');
  else { addToGroup(req.user.id, u.int(req.body.group_id), ids); req.flash('success', added ? 'Contact added.' : 'Contact already existed; updated.'); }
  back(req, res, '/contacts');
});

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.post('/contacts/import', csvUpload.single('file'), csrfCheck, (req, res) => {
  const text = req.file ? req.file.buffer.toString('utf8') : String(req.body.numbers || '');
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split(/[,;\t]/).map((s) => s.trim().replace(/^"|"$/g, ''));
    if (!cols.join('')) continue;
    // Accept "phone", "name,phone" or "phone,name": pick the column that looks like a number.
    const pi = cols.findIndex((c) => u.normalizePhone(c));
    if (pi === -1) { if (!/phone|mobile|number/i.test(line)) items.push({ phone: cols[0] }); continue; }
    items.push({ phone: cols[pi], name: cols.find((c, i) => i !== pi && c && !/^\d+$/.test(c)) || '' });
  }
  const r = upsertContacts(req.user.id, items);
  addToGroup(req.user.id, u.int(req.body.group_id), r.ids);
  req.flash(r.ids.length ? 'success' : 'error', `Imported ${r.ids.length} contacts (${r.added} new)${r.invalid ? `, ${r.invalid} invalid skipped` : ''}.`);
  res.redirect('/contacts');
});

router.post('/contacts/:id/update', (req, res) => {
  const phone = u.normalizePhone(req.body.phone);
  if (!phone) { req.flash('error', 'Invalid phone number.'); return back(req, res, '/contacts'); }
  try {
    db.prepare('UPDATE contacts SET name = ?, phone = ? WHERE id = ? AND user_id = ?').run(String(req.body.name || '').trim() || null, phone, req.params.id, req.user.id);
    req.flash('success', 'Contact updated.');
  } catch { req.flash('error', 'Another contact already has that number.'); }
  back(req, res, '/contacts');
});
router.post('/contacts/:id/ban', (req, res) => {
  db.prepare('UPDATE contacts SET banned = 1 - banned WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  back(req, res, '/contacts');
});
router.post('/contacts/:id/delete', (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  req.flash('success', 'Contact deleted.');
  back(req, res, '/contacts');
});
router.post('/contacts/bulk', (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  const action = req.body.action;
  const stmt = {
    delete: 'DELETE FROM contacts WHERE id = ? AND user_id = ?',
    ban: 'UPDATE contacts SET banned = 1 WHERE id = ? AND user_id = ?',
    unban: 'UPDATE contacts SET banned = 0 WHERE id = ? AND user_id = ?',
  }[action];
  if (stmt && ids.length) {
    db.transaction(() => { for (const id of ids) db.prepare(stmt).run(id, req.user.id); })();
    req.flash('success', `${ids.length} contacts updated.`);
  } else if (action === 'group' && ids.length) {
    addToGroup(req.user.id, u.int(req.body.group_id), ids);
    req.flash('success', `${ids.length} contacts added to group.`);
  }
  back(req, res, '/contacts');
});
router.get('/contacts/export.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
  res.write('name,phone,banned\n');
  for (const c of db.prepare('SELECT * FROM contacts WHERE user_id = ? ORDER BY id').iterate(req.user.id)) {
    res.write(`${u.csvEscape(c.name)},${c.phone},${c.banned}\n`);
  }
  res.end();
});

// ---------------- Groups ----------------
router.get('/groups', (req, res) => {
  const rows = db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) members
                           FROM contact_groups g WHERE g.user_id = ? ORDER BY g.id DESC`).all(req.user.id);
  res.render('groups', { title: 'Manage Group', active: 'groups', rows });
});
router.post('/groups', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) { req.flash('error', 'Group name is required.'); return res.redirect('/groups'); }
  const r = db.prepare('INSERT INTO contact_groups (user_id, name, created_at) VALUES (?, ?, ?)').run(req.user.id, name.slice(0, 80), u.now());
  if (req.body.numbers) {
    const items = u.parsePhoneList(req.body.numbers).valid.map((phone) => ({ phone }));
    addToGroup(req.user.id, Number(r.lastInsertRowid), upsertContacts(req.user.id, items).ids);
  }
  req.flash('success', 'Group created.');
  res.redirect('/groups');
});
router.post('/groups/:id/update', (req, res) => {
  db.prepare('UPDATE contact_groups SET name = ? WHERE id = ? AND user_id = ?').run(String(req.body.name || '').trim().slice(0, 80) || 'Group', req.params.id, req.user.id);
  if (req.body.numbers) {
    const items = u.parsePhoneList(req.body.numbers).valid.map((phone) => ({ phone }));
    addToGroup(req.user.id, u.int(req.params.id), upsertContacts(req.user.id, items).ids);
  }
  req.flash('success', 'Group updated.');
  back(req, res, '/groups');
});
router.post('/groups/:id/ban', (req, res) => {
  db.prepare('UPDATE contact_groups SET banned = 1 - banned WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  back(req, res, '/groups');
});
router.post('/groups/:id/delete', (req, res) => {
  db.prepare('DELETE FROM contact_groups WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  req.flash('success', 'Group deleted (contacts kept).');
  res.redirect('/groups');
});
router.post('/groups/:id/remove-member', (req, res) => {
  const g = db.prepare('SELECT id FROM contact_groups WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (g) db.prepare('DELETE FROM group_members WHERE group_id = ? AND contact_id = ?').run(g.id, u.int(req.body.contact_id));
  back(req, res, '/contacts');
});

// ---------------- Voice files ----------------
const AUDIO = /\.(mp3|wav|ogg|m4a|gsm|aac)$/i;
const audioUpload = multer({
  storage: multer.diskStorage({
    destination: media.uploadsDir,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, AUDIO.test(file.originalname)),
});

router.get('/voice-files', (req, res) => {
  const rows = db.prepare(`SELECT v.*, (SELECT COUNT(*) FROM batches b WHERE b.voice_file_id = v.id) used
                           FROM voice_files v WHERE user_id = ? ORDER BY id DESC`).all(req.user.id);
  res.render('voice_files', { title: 'Manage Voice File', active: 'voice', rows });
});
router.post('/voice-files', audioUpload.single('file'), csrfCheck, async (req, res) => {
  if (!req.file) { req.flash('error', 'Choose an audio file (mp3, wav, ogg, m4a, gsm).'); return res.redirect('/voice-files'); }
  const name = String(req.body.name || '').trim() || req.file.originalname.replace(AUDIO, '');
  const duration = await media.probeDuration(req.file.path);
  const r = db.prepare(`INSERT INTO voice_files (user_id, name, filename, original_name, mime, size, duration, created_at)
                        VALUES (?,?,?,?,?,?,?,?)`).run(req.user.id, name.slice(0, 80), req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, duration, u.now());
  const vf = db.prepare('SELECT * FROM voice_files WHERE id = ?').get(r.lastInsertRowid);
  if (require('../config').driver === 'asterisk') {
    const ok = await media.prepareForAsterisk(vf);
    db.prepare('UPDATE voice_files SET asterisk_ready = ? WHERE id = ?').run(ok ? 1 : 0, vf.id);
    if (!ok) { req.flash('error', 'Uploaded, but could not convert for Asterisk (install ffmpeg or upload 8kHz mono WAV).'); return res.redirect('/voice-files'); }
  }
  req.flash('success', 'Voice file uploaded.');
  res.redirect('/voice-files');
});
router.get('/voice-files/:id/play', (req, res) => {
  const vf = db.prepare(`SELECT * FROM voice_files WHERE id = ? ${req.user.role === 'admin' ? '' : 'AND user_id = ' + Number(req.user.id)}`).get(req.params.id);
  if (!vf || !fs.existsSync(media.filePath(vf))) return res.sendStatus(404);
  res.sendFile(media.filePath(vf));
});
router.post('/voice-files/:id/rename', (req, res) => {
  db.prepare('UPDATE voice_files SET name = ? WHERE id = ? AND user_id = ?').run(String(req.body.name || '').trim().slice(0, 80) || 'Voice', req.params.id, req.user.id);
  back(req, res, '/voice-files');
});
router.post('/voice-files/:id/delete', (req, res) => {
  const vf = db.prepare('SELECT * FROM voice_files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (vf) {
    const busy = db.prepare("SELECT 1 FROM batches WHERE voice_file_id = ? AND status IN ('running','scheduled','paused')").get(vf.id);
    if (busy) { req.flash('error', 'This file is used by an active batch.'); return res.redirect('/voice-files'); }
    db.prepare('DELETE FROM voice_files WHERE id = ?').run(vf.id);
    media.removeFiles(vf);
    req.flash('success', 'Voice file deleted.');
  }
  res.redirect('/voice-files');
});

// ---------------- Send voice call ----------------
function sendForm(req, res, extra = {}) {
  const uid = req.user.id;
  res.render('send_call', {
    title: 'Send Voice Call', active: 'send', form: {}, error: null, ...extra,
    voiceFiles: db.prepare('SELECT * FROM voice_files WHERE user_id = ? ORDER BY id DESC').all(uid),
    ivrs: db.prepare('SELECT * FROM ivrs WHERE user_id = ? ORDER BY name').all(uid),
    groups: db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) members FROM contact_groups g
                        WHERE user_id = ? AND banned = 0 ORDER BY name`).all(uid),
    trunks: db.prepare('SELECT * FROM ip_numbers WHERE user_id = ? AND enabled = 1 ORDER BY is_main DESC, id').all(uid),
  });
}
router.get('/send-call', (req, res) => sendForm(req, res, { form: { numbers: req.query.to || '' } }));
router.post('/send-call', csvUpload.single('file'), csrfCheck, (req, res) => {
  const b = req.body;
  let numbers = u.parsePhoneList(b.numbers).valid;
  if (req.file) numbers = numbers.concat(u.parsePhoneList(req.file.buffer.toString('utf8').replace(/"/g, ' ')).valid);
  try {
    const r = createBatch(req.user, {
      numbers, groupIds: [].concat(b.group_ids || []).map(Number).filter(Boolean),
      voiceFileId: u.int(b.voice_file_id), ivrId: u.int(b.ivr_id), ipNumberId: u.int(b.ip_number_id),
      name: String(b.name || '').trim().slice(0, 80), scheduledAt: b.schedule ? u.localDateTimeToUtc(b.scheduled_at) : null,
      maxAttempts: b.max_attempts, retryDelaySec: u.int(b.retry_delay_min, 5) * 60, source: 'web',
    });
    const extra = [r.invalid && `${r.invalid} invalid`, r.skippedBanned && `${r.skippedBanned} banned`].filter(Boolean).join(', ');
    req.flash('success', `Batch #${r.batchId} ${r.scheduled ? 'scheduled' : 'started'}: ${u.fmtNum(r.queued)} calls queued${extra ? ` (${extra} skipped)` : ''}.`);
    res.redirect('/calls?batch=' + r.batchId);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    sendForm(req, res, { form: b, error: e.message });
  }
});

// ---------------- Calls history ----------------
function callFilters(req) {
  const q = req.query;
  const where = ['c.user_id = ?'];
  const args = [req.user.id];
  if (q.mobile) { where.push('c.to_number LIKE ?'); args.push(`%${String(q.mobile).replace(/\D/g, '').replace(/^0/, '')}%`); }
  if (q.batch) { where.push('c.batch_id = ?'); args.push(u.int(q.batch)); }
  if (q.status === 'processing') where.push("c.status IN ('queued','dialing','ringing','answered')");
  else if (q.status) { where.push('c.status = ?'); args.push(String(q.status)); }
  if (q.direction) { where.push('c.direction = ?'); args.push(q.direction === 'in' ? 'in' : 'out'); }
  if (q.sender) { where.push('c.ip_number_id = ?'); args.push(u.int(q.sender)); }
  if (q.from) { where.push('c.initiated_at >= ?'); args.push(u.localDayToUtc(q.from)); }
  if (q.to) { where.push('c.initiated_at <= ?'); args.push(u.localDayToUtc(q.to, true)); }
  return { sql: where.join(' AND '), args };
}

router.get('/calls', (req, res) => {
  const f = callFilters(req);
  const stats = db.prepare(`SELECT COUNT(*) total, SUM(c.status='completed') success, SUM(c.status='failed') failed,
                              COALESCE(SUM(c.cost),0) cost, COALESCE(SUM(c.duration),0) duration
                            FROM calls c WHERE ${f.sql}`).get(...f.args);
  const pg = u.paginate(stats.total, page(req), 50);
  const sort = req.query.sort === 'asc' ? 'ASC' : 'DESC';
  const rows = db.prepare(`SELECT c.*, i.number trunk_number, b.source FROM calls c
                           LEFT JOIN ip_numbers i ON i.id = c.ip_number_id LEFT JOIN batches b ON b.id = c.batch_id
                           WHERE ${f.sql} ORDER BY COALESCE(c.sent_at, c.initiated_at) ${sort}, c.id ${sort} LIMIT ? OFFSET ?`)
    .all(...f.args, pg.per, pg.offset);
  const batches = db.prepare('SELECT id, name FROM batches WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(req.user.id);
  const trunks = db.prepare('SELECT id, number FROM ip_numbers WHERE user_id = ?').all(req.user.id);
  const batch = req.query.batch ? db.prepare('SELECT * FROM batches WHERE id = ? AND user_id = ?').get(u.int(req.query.batch), req.user.id) : null;
  res.render('calls', { title: 'Calls History', active: 'calls', rows, stats, pg, batches, trunks, batch });
});

router.get('/calls/export.csv', (req, res) => {
  const f = callFilters(req);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="calls-${u.todayLocal()}.csv"`);
  res.write('id,batch,direction,from,to,status,reason,dtmf,duration_sec,cost,attempts,initiated,sent,answered,ended\n');
  for (const c of db.prepare(`SELECT c.* FROM calls c WHERE ${f.sql} ORDER BY c.id`).iterate(...f.args)) {
    res.write([c.id, c.batch_id, c.direction, c.from_number, c.to_number, c.status, c.fail_reason, c.dtmf, c.duration, c.cost, c.attempts,
      u.fmtDate(c.initiated_at), c.sent_at && u.fmtDate(c.sent_at), c.answered_at && u.fmtDate(c.answered_at), c.ended_at && u.fmtDate(c.ended_at)]
      .map(u.csvEscape).join(',') + '\n');
  }
  res.end();
});

router.get('/calls/:id', (req, res) => {
  const c = db.prepare(`SELECT c.*, i.number trunk_number, b.name batch_name, v.name voice_name, v.id voice_id, iv.name ivr_name
                        FROM calls c LEFT JOIN ip_numbers i ON i.id = c.ip_number_id LEFT JOIN batches b ON b.id = c.batch_id
                        LEFT JOIN voice_files v ON v.id = b.voice_file_id LEFT JOIN ivrs iv ON iv.id = b.ivr_id
                        WHERE c.id = ? AND c.user_id = ?`).get(req.params.id, req.user.id);
  if (!c) return res.status(404).render('error', { title: 'Not found', message: 'Call not found.' });
  res.render('call_show', { title: `Call #${c.id}`, active: 'calls', c });
});

// ---------------- Batches (All Call Logs) ----------------
router.get('/batches', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) n FROM batches WHERE user_id = ?').get(req.user.id).n;
  const pg = u.paginate(total, page(req), 25);
  const rows = db.prepare(`SELECT b.*, v.name voice_name, iv.name ivr_name, i.number trunk_number,
        (SELECT COUNT(*) FROM calls c WHERE c.batch_id = b.id AND c.status = 'completed') success,
        (SELECT COUNT(*) FROM calls c WHERE c.batch_id = b.id AND c.status = 'failed') failed,
        (SELECT COUNT(*) FROM calls c WHERE c.batch_id = b.id AND c.status IN ('queued','dialing','ringing','answered')) pending,
        (SELECT COALESCE(SUM(cost),0) FROM calls c WHERE c.batch_id = b.id) cost
      FROM batches b LEFT JOIN voice_files v ON v.id = b.voice_file_id LEFT JOIN ivrs iv ON iv.id = b.ivr_id
      LEFT JOIN ip_numbers i ON i.id = b.ip_number_id
      WHERE b.user_id = ? ORDER BY b.id DESC LIMIT ? OFFSET ?`).all(req.user.id, pg.per, pg.offset);
  res.render('batches', { title: 'All Call Logs', active: 'batches', rows, pg });
});
router.post('/batches/:id/:action(pause|resume|cancel)', (req, res) => {
  try { setBatchStatus(req.user.id, u.int(req.params.id), req.params.action); req.flash('success', `Batch #${req.params.id}: ${req.params.action} done.`); }
  catch (e) { if (!(e instanceof UserError)) throw e; req.flash('error', e.message); }
  back(req, res, '/batches');
});

// ---------------- Call monitoring ----------------
router.get('/monitoring', (req, res) => {
  const trunks = db.prepare('SELECT * FROM ip_numbers WHERE user_id = ? ORDER BY is_main DESC, id').all(req.user.id);
  const since = new Date(Date.now() - 3600000).toISOString();
  const hour = db.prepare(`SELECT COUNT(*) total, SUM(status='completed') success, SUM(status='failed') failed, AVG(CASE WHEN status='completed' THEN duration END) acd
                           FROM calls WHERE user_id = ? AND sent_at >= ?`).get(req.user.id, since);
  const reasons = db.prepare(`SELECT COALESCE(fail_reason,'Unknown') reason, COUNT(*) n FROM calls
                              WHERE user_id = ? AND status = 'failed' AND sent_at >= ? GROUP BY 1 ORDER BY n DESC LIMIT 8`)
    .all(req.user.id, new Date(Date.now() - 86400000).toISOString());
  res.render('monitoring', { title: 'Call Monitoring', active: 'monitoring', trunks, hour, reasons });
});

module.exports = router;
