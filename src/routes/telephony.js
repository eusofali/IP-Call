const router = require('express').Router();
const crypto = require('crypto');
const cfg = require('../config');
const { db } = require('../db');
const u = require('../util');
const { applyPjsip } = require('../services/asterisk-config');

const back = (req, res, fallback) => res.redirect(req.get('referer') || fallback);
const genPass = () => crypto.randomBytes(9).toString('base64url');

/** After trunk/extension changes, regenerate Asterisk config when running with Asterisk. */
async function syncAsterisk(req) {
  if (cfg.driver !== 'asterisk' || !cfg.asterisk.pjsipFile) return;
  try {
    await applyPjsip(req.app.locals.engine.driver);
    req.app.locals.engine.lastSync = Date.now() - 22000; // re-check registration ~8s from now
  }
  catch (e) { req.flash('error', 'Saved, but Asterisk reload failed: ' + e.message); }
}

// ---------------- Extensions ----------------
router.get('/extensions', (req, res) => {
  const rows = db.prepare('SELECT * FROM extensions WHERE user_id = ? ORDER BY sip_number').all(req.user.id);
  res.render('extensions', { title: 'Manage Extension', active: 'extensions', rows, sipHost: cfg.asterisk.sipHost || req.hostname });
});

function nextExtensionNumber() {
  const r = db.prepare('SELECT MAX(CAST(sip_number AS INTEGER)) m FROM extensions').get();
  return String(Math.max(r.m || 0, 11220) + 1);
}

router.post('/extensions', async (req, res) => {
  const used = db.prepare('SELECT COUNT(*) n FROM extensions WHERE user_id = ?').get(req.user.id).n;
  if (used >= req.user.max_extensions) { req.flash('error', `Extension limit reached (${req.user.max_extensions}).`); return res.redirect('/extensions'); }
  const forward = req.body.forward_to ? u.normalizePhone(req.body.forward_to) : null;
  if (req.body.forward_to && !forward) { req.flash('error', 'Invalid call forwarding number.'); return res.redirect('/extensions'); }
  db.prepare(`INSERT INTO extensions (user_id, sip_number, password, agent_name, forward_to, created_at) VALUES (?,?,?,?,?,?)`)
    .run(req.user.id, nextExtensionNumber(), genPass(), String(req.body.agent_name || '').trim().slice(0, 60) || null, forward, u.now());
  await syncAsterisk(req);
  req.flash('success', 'Extension created.');
  res.redirect('/extensions');
});

router.post('/extensions/:id/update', async (req, res) => {
  const forward = req.body.forward_to ? u.normalizePhone(req.body.forward_to) : null;
  if (req.body.forward_to && !forward) { req.flash('error', 'Invalid call forwarding number.'); return back(req, res, '/extensions'); }
  db.prepare('UPDATE extensions SET agent_name = ?, forward_to = ? WHERE id = ? AND user_id = ?')
    .run(String(req.body.agent_name || '').trim().slice(0, 60) || null, forward, req.params.id, req.user.id);
  req.flash('success', 'Extension updated.');
  back(req, res, '/extensions');
});
router.post('/extensions/:id/reset-password', async (req, res) => {
  db.prepare('UPDATE extensions SET password = ? WHERE id = ? AND user_id = ?').run(genPass(), req.params.id, req.user.id);
  await syncAsterisk(req);
  req.flash('success', 'Password reset. Update it in the softphone.');
  back(req, res, '/extensions');
});
router.post('/extensions/:id/delete', async (req, res) => {
  db.prepare('DELETE FROM extensions WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  await syncAsterisk(req);
  req.flash('success', 'Extension deleted.');
  res.redirect('/extensions');
});

// ---------------- IP numbers (SIP trunks) ----------------
router.get('/ip-numbers', (req, res) => {
  const rows = db.prepare(`SELECT i.*, (SELECT COUNT(*) FROM calls c WHERE c.ip_number_id = i.id AND c.status IN ('dialing','ringing','answered')) live
                           FROM ip_numbers i WHERE user_id = ? ORDER BY is_main DESC, id`).all(req.user.id);
  res.render('ip_numbers', { title: 'Manage IP Number', active: 'ipnumbers', rows });
});

function trunkFields(b, isAdmin) {
  const f = {
    number: String(b.number || '').trim().slice(0, 30),
    username: String(b.username || '').trim().slice(0, 60) || null,
    password: String(b.password || ''),
    sip_server: String(b.sip_server || '').trim().slice(0, 120),
    port: Math.min(Math.max(u.int(b.port, 5060), 1), 65535),
    transport: b.transport === 'tcp' ? 'tcp' : 'udp',
    enabled: b.enabled ? 1 : 0,
  };
  // Capacity limits protect the trunk from burst failures; only admins can raise them above defaults.
  const mc = Math.min(Math.max(u.int(b.max_concurrent, 5), 1), isAdmin ? 500 : 30);
  const cps = Math.min(Math.max(u.int(b.cps, 1), 1), isAdmin ? 50 : 5);
  return { ...f, max_concurrent: mc, cps };
}
const validTrunk = (f) => (!f.number ? 'Number is required.' : !/^[a-z0-9.-]+$/i.test(f.sip_server) ? 'SIP server must be a hostname or IP.' : null);

router.post('/ip-numbers', async (req, res) => {
  const f = trunkFields(req.body, req.user.role === 'admin');
  const err = validTrunk(f);
  if (err) { req.flash('error', err); return res.redirect('/ip-numbers'); }
  const first = !db.prepare('SELECT 1 FROM ip_numbers WHERE user_id = ?').get(req.user.id);
  db.prepare(`INSERT INTO ip_numbers (user_id, number, username, password, sip_server, port, transport, enabled, max_concurrent, cps, is_main, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, f.number, f.username, f.password, f.sip_server, f.port, f.transport, f.enabled, f.max_concurrent, f.cps, first ? 1 : 0, u.now());
  await syncAsterisk(req);
  req.flash('success', 'IP number added.');
  res.redirect('/ip-numbers');
});
router.post('/ip-numbers/:id/update', async (req, res) => {
  const cur = db.prepare('SELECT * FROM ip_numbers WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!cur) return res.redirect('/ip-numbers');
  const f = trunkFields(req.body, req.user.role === 'admin');
  if (!f.password) f.password = cur.password; // blank = keep
  const err = validTrunk(f);
  if (err) { req.flash('error', err); return res.redirect('/ip-numbers'); }
  db.prepare(`UPDATE ip_numbers SET number=?, username=?, password=?, sip_server=?, port=?, transport=?, enabled=?, max_concurrent=?, cps=? WHERE id = ?`)
    .run(f.number, f.username, f.password, f.sip_server, f.port, f.transport, f.enabled, f.max_concurrent, f.cps, cur.id);
  await syncAsterisk(req);
  req.flash('success', 'IP number updated.');
  res.redirect('/ip-numbers');
});
router.post('/ip-numbers/:id/main', (req, res) => {
  db.transaction(() => {
    db.prepare('UPDATE ip_numbers SET is_main = 0 WHERE user_id = ?').run(req.user.id);
    db.prepare('UPDATE ip_numbers SET is_main = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  })();
  res.redirect('/ip-numbers');
});
router.post('/ip-numbers/:id/delete', async (req, res) => {
  const busy = db.prepare("SELECT 1 FROM calls WHERE ip_number_id = ? AND status IN ('queued','dialing','ringing','answered')").get(req.params.id);
  if (busy) { req.flash('error', 'This number has queued or active calls. Cancel those batches first.'); return res.redirect('/ip-numbers'); }
  db.prepare('DELETE FROM ip_numbers WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  await syncAsterisk(req);
  req.flash('success', 'IP number deleted.');
  res.redirect('/ip-numbers');
});

// ---------------- IVR ----------------
const ivrList = (uid) => db.prepare(`SELECT i.*, v.name prompt_name, (SELECT COUNT(*) FROM ivr_options o WHERE o.ivr_id = i.id) opts
                                     FROM ivrs i LEFT JOIN voice_files v ON v.id = i.prompt_file_id WHERE i.user_id = ? ORDER BY i.id`).all(uid);

router.get('/ivr', (req, res) => {
  const uid = req.user.id;
  const settings = db.prepare('SELECT * FROM ivr_settings WHERE user_id = ?').get(uid) || {};
  res.render('ivr', {
    title: 'IVR Management', active: 'ivr', settings, ivrs: ivrList(uid),
    voiceFiles: db.prepare('SELECT id, name FROM voice_files WHERE user_id = ? ORDER BY name').all(uid),
  });
});

const ownFile = (uid, id) => (id && db.prepare('SELECT id FROM voice_files WHERE id = ? AND user_id = ?').get(id, uid) ? id : null);
const ownIvr = (uid, id) => (id && db.prepare('SELECT id FROM ivrs WHERE id = ? AND user_id = ?').get(id, uid) ? id : null);

router.post('/ivr/settings', (req, res) => {
  const uid = req.user.id, b = req.body;
  const s = {
    welcome_enabled: b.welcome_enabled ? 1 : 0, welcome_file_id: ownFile(uid, u.int(b.welcome_file_id)),
    moh_enabled: b.moh_enabled ? 1 : 0, moh_file_id: ownFile(uid, u.int(b.moh_file_id)),
    ivr_enabled: b.ivr_enabled ? 1 : 0, ivr_id: ownIvr(uid, u.int(b.ivr_id)),
  };
  const warn = (s.welcome_enabled && !s.welcome_file_id && 'Welcome Voice is on but no file is selected.')
    || (s.ivr_enabled && !s.ivr_id && 'IVR is on but no IVR is selected.');
  db.prepare(`INSERT INTO ivr_settings (user_id, welcome_enabled, welcome_file_id, moh_enabled, moh_file_id, ivr_enabled, ivr_id)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET welcome_enabled=excluded.welcome_enabled, welcome_file_id=excluded.welcome_file_id,
                moh_enabled=excluded.moh_enabled, moh_file_id=excluded.moh_file_id, ivr_enabled=excluded.ivr_enabled, ivr_id=excluded.ivr_id`)
    .run(uid, s.welcome_enabled, s.welcome_file_id, s.moh_enabled, s.moh_file_id, s.ivr_enabled, s.ivr_id);
  if (req.get('accept')?.includes('json')) return res.json({ ok: true, warning: warn || null });
  req.flash(warn ? 'error' : 'success', warn || 'IVR settings saved.');
  res.redirect('/ivr');
});

router.get('/ivr/new', (req, res) => renderIvrEdit(req, res, { id: null, name: '', timeout_sec: 8, max_repeats: 2, options: [] }));
router.get('/ivr/:id', (req, res) => {
  const ivr = db.prepare('SELECT * FROM ivrs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!ivr) return res.redirect('/ivr');
  ivr.options = db.prepare('SELECT * FROM ivr_options WHERE ivr_id = ? ORDER BY digit').all(ivr.id);
  renderIvrEdit(req, res, ivr);
});
function renderIvrEdit(req, res, ivr, error = null) {
  const uid = req.user.id;
  res.render('ivr_edit', {
    title: ivr.id ? `Edit IVR: ${ivr.name}` : 'New IVR', active: 'ivr', ivr, error,
    voiceFiles: db.prepare('SELECT id, name FROM voice_files WHERE user_id = ? ORDER BY name').all(uid),
    extensions: db.prepare('SELECT sip_number, agent_name FROM extensions WHERE user_id = ? ORDER BY sip_number').all(uid),
  });
}

router.post('/ivr/save', (req, res) => {
  const uid = req.user.id, b = req.body;
  const id = u.int(b.id);
  if (id && !ownIvr(uid, id)) return res.redirect('/ivr');
  const name = String(b.name || '').trim().slice(0, 60);
  const options = [];
  const digits = [].concat(b.digit || []);
  digits.forEach((d, i) => {
    const action = [].concat(b.action || [])[i];
    let target = String([].concat(b.target || [])[i] || '').trim();
    if (!/^[0-9*#]$/.test(d) || !['play', 'extension', 'forward', 'repeat', 'hangup'].includes(action)) return;
    if (action === 'play') target = String(ownFile(uid, u.int(target)) || '');
    if (action === 'forward') target = u.normalizePhone(target) || '';
    if (action === 'extension' && !db.prepare('SELECT 1 FROM extensions WHERE sip_number = ? AND user_id = ?').get(target, uid)) target = '';
    if (['play', 'forward', 'extension'].includes(action) && !target) return;
    options.push({ digit: d, action, target, label: String([].concat(b.label || [])[i] || '').slice(0, 60) });
  });
  const draft = { id, name, prompt_file_id: u.int(b.prompt_file_id), timeout_sec: u.int(b.timeout_sec, 8), max_repeats: u.int(b.max_repeats, 2), options };
  if (!name) return renderIvrEdit(req, res, draft, 'Name is required.');
  if (!ownFile(uid, draft.prompt_file_id)) return renderIvrEdit(req, res, draft, 'Choose the menu prompt voice file.');
  if (new Set(options.map((o) => o.digit)).size !== options.length) return renderIvrEdit(req, res, draft, 'Each key can only be used once.');

  db.transaction(() => {
    const t = Math.min(Math.max(draft.timeout_sec, 3), 30), r = Math.min(Math.max(draft.max_repeats, 0), 5);
    let ivrId = id;
    if (id) db.prepare('UPDATE ivrs SET name=?, prompt_file_id=?, timeout_sec=?, max_repeats=? WHERE id = ?').run(name, draft.prompt_file_id, t, r, id);
    else ivrId = Number(db.prepare('INSERT INTO ivrs (user_id, name, prompt_file_id, timeout_sec, max_repeats, created_at) VALUES (?,?,?,?,?,?)')
      .run(uid, name, draft.prompt_file_id, t, r, u.now()).lastInsertRowid);
    db.prepare('DELETE FROM ivr_options WHERE ivr_id = ?').run(ivrId);
    const ins = db.prepare('INSERT INTO ivr_options (ivr_id, digit, action, target, label) VALUES (?,?,?,?,?)');
    for (const o of options) ins.run(ivrId, o.digit, o.action, o.target || null, o.label || null);
  })();
  req.flash('success', 'IVR saved.');
  res.redirect('/ivr');
});
router.post('/ivr/:id/delete', (req, res) => {
  db.prepare('DELETE FROM ivrs WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  req.flash('success', 'IVR deleted.');
  res.redirect('/ivr');
});

module.exports = router;
