const { db } = require('../db');
const { now, normalizePhone } = require('../util');
const { pulseCost } = require('./billing');
const cfg = require('../config');

class UserError extends Error {}

/** Numbers that must never be called for this user: banned contacts and members of banned groups. */
function bannedSet(userId) {
  const rows = db.prepare(`
    SELECT phone FROM contacts WHERE user_id = ? AND banned = 1
    UNION
    SELECT c.phone FROM contacts c
      JOIN group_members gm ON gm.contact_id = c.id
      JOIN contact_groups g ON g.id = gm.group_id
     WHERE g.user_id = ? AND g.banned = 1`).all(userId, userId);
  return new Set(rows.map((r) => r.phone));
}

function groupNumbers(userId, groupIds) {
  if (!groupIds.length) return [];
  const q = db.prepare(`SELECT c.phone FROM contacts c JOIN group_members gm ON gm.contact_id = c.id
                        JOIN contact_groups g ON g.id = gm.group_id
                        WHERE g.id = ? AND g.user_id = ? AND g.banned = 0`);
  return groupIds.flatMap((gid) => q.all(gid, userId).map((r) => r.phone));
}

/**
 * Create a batch of outbound calls. Used by the web form and the REST API.
 * opts: { numbers: string[], groupIds: number[], voiceFileId, ivrId, ipNumberId, name,
 *         scheduledAt (ISO), maxAttempts, retryDelaySec, source }
 */
function createBatch(user, opts) {
  if (user.status !== 'active') throw new UserError('Your account is suspended.');

  const vf = db.prepare('SELECT * FROM voice_files WHERE id = ? AND user_id = ?').get(opts.voiceFileId, user.id);
  let ivr = null;
  if (opts.ivrId) {
    ivr = db.prepare('SELECT * FROM ivrs WHERE id = ? AND user_id = ?').get(opts.ivrId, user.id);
    if (!ivr) throw new UserError('IVR not found.');
  }
  if (!vf && !ivr) throw new UserError('Choose a voice file (or an IVR) to play.');

  const trunk = opts.ipNumberId
    ? db.prepare('SELECT * FROM ip_numbers WHERE id = ? AND user_id = ? AND enabled = 1').get(opts.ipNumberId, user.id)
    : db.prepare('SELECT * FROM ip_numbers WHERE user_id = ? AND enabled = 1 ORDER BY is_main DESC, id LIMIT 1').get(user.id);
  if (!trunk) throw new UserError('No active IP number (SIP trunk) found. Add one under Manage IP Number.');

  const banned = bannedSet(user.id);
  const seen = new Set();
  const numbers = [];
  let invalid = 0, skippedBanned = 0;
  for (const raw of [...(opts.numbers || []), ...groupNumbers(user.id, opts.groupIds || [])]) {
    const n = normalizePhone(raw);
    if (!n) { invalid++; continue; }
    if (seen.has(n)) continue;
    seen.add(n);
    if (banned.has(n)) { skippedBanned++; continue; }
    numbers.push(n);
  }
  if (!numbers.length) throw new UserError('No valid numbers to call' + (skippedBanned ? ` (${skippedBanned} banned numbers skipped).` : '.'));
  if (numbers.length > 100000) throw new UserError('Maximum 100,000 numbers per batch.');

  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const minCost = pulseCost(fresh);
  if (cfg.billing && fresh.balance < minCost) {
    throw new UserError(`Insufficient balance. You need at least ${minCost.toFixed(2)} to place a call; current balance is ${fresh.balance.toFixed(2)}.`);
  }

  const ts = now();
  const scheduled = opts.scheduledAt && opts.scheduledAt > ts ? opts.scheduledAt : null;
  const maxAttempts = Math.min(Math.max(parseInt(opts.maxAttempts, 10) || 1, 1), 5);
  const retryDelay = Math.min(Math.max(parseInt(opts.retryDelaySec, 10) || 300, 30), 86400);

  const batchId = db.transaction(() => {
    const r = db.prepare(`INSERT INTO batches (user_id, name, source, voice_file_id, ivr_id, ip_number_id, total, max_attempts,
                            retry_delay_sec, status, scheduled_at, started_at, created_at)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(user.id, opts.name || null, opts.source || 'web', vf ? vf.id : null, ivr ? ivr.id : null, trunk.id, numbers.length,
        maxAttempts, retryDelay, scheduled ? 'scheduled' : 'running', scheduled, scheduled ? null : ts, ts);
    const ins = db.prepare(`INSERT INTO calls (batch_id, user_id, ip_number_id, direction, from_number, to_number, status, initiated_at)
                            VALUES (?, ?, ?, 'out', ?, ?, 'queued', ?)`);
    for (const n of numbers) ins.run(r.lastInsertRowid, user.id, trunk.id, trunk.number, n, ts);
    return Number(r.lastInsertRowid);
  })();

  const estMinutes = numbers.length; // rough: 1 pulse each
  return { batchId, queued: numbers.length, invalid, skippedBanned, scheduled: !!scheduled, estMinCost: +(estMinutes * minCost).toFixed(2) };
}

function setBatchStatus(userId, batchId, action, isAdmin = false) {
  const b = db.prepare(`SELECT * FROM batches WHERE id = ? ${isAdmin ? '' : 'AND user_id = ?'}`).get(...(isAdmin ? [batchId] : [batchId, userId]));
  if (!b) throw new UserError('Batch not found.');
  if (action === 'pause' && ['running', 'scheduled'].includes(b.status)) {
    db.prepare("UPDATE batches SET status = 'paused', pause_reason = 'Paused by user' WHERE id = ?").run(b.id);
  } else if (action === 'resume' && b.status === 'paused') {
    db.prepare("UPDATE batches SET status = 'running', pause_reason = NULL, started_at = COALESCE(started_at, ?) WHERE id = ?").run(now(), b.id);
  } else if (action === 'cancel' && !['completed', 'cancelled'].includes(b.status)) {
    db.transaction(() => {
      db.prepare("UPDATE calls SET status = 'cancelled', fail_reason = 'Cancelled by user', ended_at = ? WHERE batch_id = ? AND status = 'queued'").run(now(), b.id);
      db.prepare("UPDATE batches SET status = 'cancelled', finished_at = ? WHERE id = ?").run(now(), b.id);
    })();
  } else {
    throw new UserError(`Cannot ${action} a ${b.status} batch.`);
  }
}

module.exports = { createBatch, setBatchStatus, bannedSet, UserError };
