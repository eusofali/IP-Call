const { db } = require('../db');
const { now } = require('../util');

/** Cost of an answered call billed in pulses (e.g. 60s pulse = per-minute billing). */
function callCost(durationSec, ratePerMin, pulseSec) {
  if (!durationSec || durationSec <= 0) return 0;
  const pulse = Math.max(1, pulseSec || 60);
  const pulses = Math.ceil(durationSec / pulse);
  return Math.round(pulses * pulse / 60 * ratePerMin * 100) / 100;
}

/** Cost of the first pulse: the minimum balance needed to place one call. */
const pulseCost = (user) => callCost(1, user.rate_per_min, user.pulse_sec);

/** Adjust balance and write a ledger row atomically. amount > 0 credits, < 0 debits. */
const adjust = db.transaction((userId, amount, type, note, extra = {}) => {
  db.prepare('UPDATE users SET balance = ROUND(balance + ?, 4) WHERE id = ?').run(amount, userId);
  const { balance } = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
  db.prepare(`INSERT INTO transactions (user_id, type, amount, balance_after, note, call_id, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, type, amount, balance, note || null, extra.callId || null, extra.createdBy || null, now());
  return balance;
});

module.exports = { callCost, pulseCost, adjust };
