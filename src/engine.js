// Dialer engine: pulls queued calls, respects per-trunk concurrency + calls-per-second,
// hands them to the telephony driver, and records results + billing.
const EventEmitter = require('events');
const { db } = require('./db');
const cfg = require('./config');
const { now } = require('./util');
const { callCost, pulseCost, adjust } = require('./services/billing');
const { asteriskMedia } = require('./services/media');

const ACTIVE = "('dialing','ringing','answered')";
const RETRYABLE = /busy|no answer|congest|unavailable/i;

class Engine extends EventEmitter {
  constructor(driver) {
    super();
    this.driver = driver;
    this.active = new Map(); // callId -> { trunkId, userId, answeredAt, handle }
    this.timer = null;
    this.lastTick = null;
    this.lastSync = 0;
  }

  start() {
    // Calls that were in progress when the server stopped can never finish: close them out.
    const r = db.prepare(`UPDATE calls SET status = 'failed', fail_reason = 'Interrupted (server restart)', ended_at = ?
                          WHERE status IN ${ACTIVE}`).run(now());
    if (r.changes) console.log(`[engine] closed ${r.changes} interrupted calls`);
    this.driver.start?.(this);
    this.timer = setInterval(() => this.tick(), cfg.tickMs);
    this.timer.unref?.();
    console.log(`[engine] started with driver "${this.driver.name}"`);
  }

  stop() { clearInterval(this.timer); this.driver.stop?.(); }

  async setDriver(driver) {
    if (this.active.size) throw new Error('Cannot switch driver while calls are active');
    this.driver.stop?.();
    this.driver = driver;
    this.driver.start?.(this);
    console.log(`[engine] switched to driver "${driver.name}"`);
  }

  tick() {
    this.lastTick = Date.now();
    try {
      const ts = now();
      db.prepare("UPDATE batches SET status = 'running', started_at = ? WHERE status = 'scheduled' AND scheduled_at <= ?").run(ts, ts);

      let globalFree = cfg.maxConcurrent - this.active.size;
      const trunks = db.prepare('SELECT * FROM ip_numbers WHERE enabled = 1').all();
      for (const trunk of trunks) {
        if (globalFree <= 0) break;
        const busy = [...this.active.values()].filter((a) => a.trunkId === trunk.id).length;
        const n = Math.min(trunk.max_concurrent - busy, trunk.cps, globalFree);
        if (n <= 0) continue;
        const calls = db.prepare(`SELECT c.* FROM calls c JOIN batches b ON b.id = c.batch_id
                                  WHERE c.status = 'queued' AND b.status = 'running' AND c.ip_number_id = ?
                                    AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= ?)
                                  ORDER BY c.id LIMIT ?`).all(trunk.id, ts, n);
        for (const call of calls) {
          if (this.dial(call, trunk)) globalFree--;
        }
      }

      // Batches with nothing left to do are complete.
      db.prepare(`UPDATE batches SET status = 'completed', finished_at = ?
                  WHERE status = 'running' AND NOT EXISTS (
                    SELECT 1 FROM calls c WHERE c.batch_id = batches.id AND c.status IN ('queued','dialing','ringing','answered'))`).run(ts);

      if (Date.now() - this.lastSync > 30000 && this.driver.syncEndpoints) {
        this.lastSync = Date.now();
        this.driver.syncEndpoints().catch((e) => console.warn('[engine] endpoint sync failed:', e.message));
      }
    } catch (e) {
      console.error('[engine] tick error', e);
    }
  }

  /** Everything a driver needs to run a call: media to play, IVR menu, welcome/MOH. */
  buildContext(userId, { voiceFileId, ivrId, inbound = false }) {
    const settings = db.prepare('SELECT * FROM ivr_settings WHERE user_id = ?').get(userId) || {};
    if (inbound && settings.ivr_enabled && settings.ivr_id) ivrId = settings.ivr_id;
    let ivr = null;
    if (ivrId) {
      ivr = db.prepare('SELECT * FROM ivrs WHERE id = ? AND user_id = ?').get(ivrId, userId);
      if (ivr) ivr.options = db.prepare('SELECT * FROM ivr_options WHERE ivr_id = ? ORDER BY digit').all(ivr.id);
    }
    const media = (id) => (id ? asteriskMedia(id) : null);
    return {
      welcome: inbound && settings.welcome_enabled ? media(settings.welcome_file_id) : null, // greeting is for callers, not campaigns
      moh: settings.moh_enabled ? media(settings.moh_file_id) : null,
      main: ivr ? media(ivr.prompt_file_id) : media(voiceFileId),
      ivr: ivr && {
        timeoutSec: ivr.timeout_sec, maxRepeats: ivr.max_repeats,
        options: Object.fromEntries(ivr.options.map((o) => [o.digit, {
          action: o.action,
          target: o.action === 'play' ? media(Number(o.target)) : o.target,
        }])),
      },
    };
  }

  dial(call, trunk) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(call.user_id);
    const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(call.batch_id);
    if (!user || user.status !== 'active') {
      db.prepare("UPDATE batches SET status = 'paused', pause_reason = 'Account suspended' WHERE id = ?").run(call.batch_id);
      return false;
    }
    // Reserve one pulse for each call already in flight so concurrent calls can't overdraw much.
    const inFlight = [...this.active.values()].filter((a) => a.userId === user.id).length;
    if (cfg.billing && user.balance < pulseCost(user) * (inFlight + 1)) {
      if (inFlight === 0) {
        db.prepare("UPDATE batches SET status = 'paused', pause_reason = 'Insufficient balance' WHERE id = ? AND status = 'running'").run(call.batch_id);
      }
      return false;
    }

    const ts = now();
    db.prepare(`UPDATE calls SET status = 'dialing', sent_at = ?, attempts = attempts + 1, next_attempt_at = NULL,
                fail_reason = NULL, answered_at = NULL, ended_at = NULL WHERE id = ?`).run(ts, call.id);
    const state = { trunkId: trunk.id, userId: user.id, batchId: call.batch_id, answeredAt: null, ended: false };
    this.active.set(call.id, state);

    const ctx = {
      call: { ...call, status: 'dialing' },
      trunk,
      ...this.buildContext(user.id, { voiceFileId: batch?.voice_file_id, ivrId: batch?.ivr_id }),
    };
    try {
      state.handle = this.driver.originate(ctx, this.handlers(call.id));
    } catch (e) {
      this.handlers(call.id).ended({ reason: 'Originate failed: ' + e.message });
    }
    return true;
  }

  /** Inbound call arriving on a trunk (Asterisk driver). Returns { ctx, handlers } or null. */
  registerInbound({ trunkId, from, to, channelId }) {
    const trunk = db.prepare('SELECT * FROM ip_numbers WHERE id = ?').get(trunkId);
    if (!trunk) return null;
    const r = db.prepare(`INSERT INTO calls (user_id, ip_number_id, direction, from_number, to_number, status, channel_id,
                            initiated_at, sent_at, attempts) VALUES (?, ?, 'in', ?, ?, 'ringing', ?, ?, ?, 1)`)
      .run(trunk.user_id, trunk.id, from || 'unknown', to || trunk.number, channelId || null, now(), now());
    const callId = Number(r.lastInsertRowid);
    this.active.set(callId, { trunkId: trunk.id, userId: trunk.user_id, answeredAt: null, ended: false, inbound: true });
    return { callId, ctx: { trunk, ...this.buildContext(trunk.user_id, { inbound: true }) }, handlers: this.handlers(callId) };
  }

  handlers(callId) {
    const st = () => this.active.get(callId);
    const emit = () => this.emit('change', callId);
    return {
      channel: (channelId) => db.prepare('UPDATE calls SET channel_id = ? WHERE id = ?').run(channelId, callId),
      ringing: () => {
        if (!st() || st().ended) return;
        db.prepare("UPDATE calls SET status = 'ringing' WHERE id = ? AND status = 'dialing'").run(callId); emit();
      },
      answered: () => {
        const s = st(); if (!s || s.ended || s.answeredAt) return;
        s.answeredAt = Date.now();
        db.prepare("UPDATE calls SET status = 'answered', answered_at = ? WHERE id = ?").run(now(), callId); emit();
      },
      dtmf: (digit) => {
        if (!st() || st().ended) return;
        db.prepare("UPDATE calls SET dtmf = COALESCE(dtmf, '') || ? WHERE id = ?").run(String(digit).slice(0, 1), callId); emit();
      },
      ended: (info = {}) => this.finish(callId, info),
    };
  }

  /** info: { reason, cause, duration (optional, seconds; else measured from answer) } */
  finish(callId, info) {
    const s = this.active.get(callId);
    if (!s || s.ended) return;
    s.ended = true;
    this.active.delete(callId);
    const ts = now();
    const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
    if (!call) return;

    if (s.answeredAt) {
      const duration = Math.max(1, Math.round(info.duration ?? (Date.now() - s.answeredAt) / 1000));
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(call.user_id);
      const cost = cfg.billing && call.direction === 'out' ? callCost(duration, user.rate_per_min, user.pulse_sec) : 0;
      db.transaction(() => {
        db.prepare(`UPDATE calls SET status = 'completed', duration = ?, cost = ?, hangup_cause = ?, ended_at = ? WHERE id = ?`)
          .run(duration, cost, info.cause ?? null, ts, callId);
        if (cost > 0) adjust(call.user_id, -cost, 'call', `Call to +${call.to_number} (${duration}s)`, { callId });
      })();
    } else {
      const reason = info.reason || 'Failed';
      const batch = call.batch_id && db.prepare('SELECT * FROM batches WHERE id = ?').get(call.batch_id);
      if (batch && RETRYABLE.test(reason) && call.attempts < batch.max_attempts && batch.status !== 'cancelled') {
        const next = new Date(Date.now() + batch.retry_delay_sec * 1000).toISOString();
        db.prepare(`UPDATE calls SET status = 'queued', fail_reason = ?, hangup_cause = ?, next_attempt_at = ? WHERE id = ?`)
          .run(`${reason} (attempt ${call.attempts}, will retry)`, info.cause ?? null, next, callId);
      } else {
        db.prepare(`UPDATE calls SET status = 'failed', fail_reason = ?, hangup_cause = ?, ended_at = ? WHERE id = ?`)
          .run(reason, info.cause ?? null, ts, callId);
      }
    }
    this.emit('change', callId);
  }

  hangup(callId) {
    const s = this.active.get(callId);
    if (s?.handle?.hangup) s.handle.hangup();
  }

  liveCalls(userId = null) {
    const ids = [...this.active.entries()].filter(([, s]) => userId == null || s.userId === userId).map(([id]) => id);
    if (!ids.length) return [];
    return db.prepare(`SELECT id, direction, from_number, to_number, status, answered_at, sent_at, user_id, batch_id
                       FROM calls WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);
  }
}

module.exports = { Engine };
