// Simulated telephony: lets you demo and test the whole panel without a SIP trunk.
// Outcomes are random but realistic; SIM_SPEED > 1 makes calls finish faster in real time.
const cfg = require('../config');

function createSimulator() {
  const timers = new Set();
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms / cfg.simSpeed); timers.add(t); return t; };
  const rnd = (a, b) => a + Math.random() * (b - a);

  return {
    name: 'simulator',
    start() {},
    stop() { for (const t of timers) clearTimeout(t); timers.clear(); },
    async syncEndpoints() {
      const { db } = require('../db');
      db.prepare("UPDATE ip_numbers SET status = 'connected', status_detail = 'Simulated', last_sync = ? WHERE enabled = 1").run(new Date().toISOString());
    },
    originate(ctx, h) {
      let done = false;
      const end = (info) => { if (!done) { done = true; h.ended(info); } };
      h.channel(`sim-${ctx.call.id}-${Date.now()}`);
      later(rnd(300, 1200), () => {
        if (done) return;
        const r = Math.random();
        if (r < 0.04) return end({ reason: 'Invalid number', cause: 1 });
        if (r < 0.08) return end({ reason: 'Network congestion', cause: 34 });
        h.ringing();
        later(rnd(2000, 9000), () => {
          if (done) return;
          if (r < 0.20) return end({ reason: 'User busy', cause: 17 });
          if (r < 0.34) return end({ reason: 'No answer', cause: 19 });
          if (r < 0.38) return end({ reason: 'Call rejected', cause: 21 });
          h.answered();
          const talk = Math.round(rnd(4, 75));
          const opts = ctx.ivr ? Object.keys(ctx.ivr.options) : [];
          if (opts.length && Math.random() < 0.5) later(rnd(2000, Math.min(talk * 1000, 8000)), () => !done && h.dtmf(opts[Math.floor(Math.random() * opts.length)]));
          later(talk * 1000, () => end({ reason: 'Normal clearing', cause: 16, duration: talk }));
        });
      });
      return { hangup: () => end({ reason: 'Hung up from panel', cause: 16 }) };
    },
  };
}

module.exports = { createSimulator };
