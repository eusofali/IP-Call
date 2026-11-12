// Asterisk REST Interface (ARI) driver.
// Outbound: originates PJSIP/<number>@trunk<ID> into the Stasis app, plays welcome + message / IVR menu,
//           collects DTMF, and bridges to an extension or external number for IVR "transfer" options.
// Inbound:  calls entering Stasis with args "in,<trunkId>" (see asterisk/extensions_ipcall.conf) run the
//           user's Welcome Voice + IVR settings.
const WebSocket = require('ws');
const cfg = require('../config');

const CAUSES = {
  1: 'Invalid number', 3: 'No route', 16: 'Normal clearing', 17: 'User busy', 18: 'No answer', 19: 'No answer',
  20: 'Subscriber absent', 21: 'Call rejected', 22: 'Number changed', 27: 'Destination out of order',
  28: 'Invalid number format', 31: 'Normal, unspecified', 34: 'Network congestion', 38: 'Network out of order',
  41: 'Temporary failure', 42: 'Switch congestion', 47: 'Resource unavailable', 58: 'Bearer capability not available',
  102: 'Recovery on timer expire', 127: 'Interworking error',
};

function createAsteriskDriver() {
  const sessions = new Map(); // channelId -> session
  let ws = null, engine = null, stopped = false, retry = 1000;
  const base = () => cfg.ari.url.replace(/\/+$/, '');
  const auth = () => 'Basic ' + Buffer.from(`${cfg.ari.user}:${cfg.ari.pass}`).toString('base64');

  async function ari(method, path, query = {}, body) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString();
    const res = await fetch(`${base()}/ari${path}${qs ? '?' + qs : ''}`, {
      method, headers: { Authorization: auth(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ARI ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  const quiet = (p) => p.catch(() => {});

  function connect() {
    if (stopped) return;
    const url = base().replace(/^http/, 'ws') + `/ari/events?app=${encodeURIComponent(cfg.ari.app)}&subscribeAll=false`;
    ws = new WebSocket(url, { headers: { Authorization: auth() } });
    ws.on('open', () => { retry = 1000; console.log('[ari] connected to', base()); });
    ws.on('message', (m) => {
      try {
        const ev = JSON.parse(m);
        if (process.env.ARI_DEBUG) console.log('[ari:event]', ev.type, ev.channel?.id || ev.playback?.id || '', ev.channel?.state || '', ev.args || '', ev.cause ?? '');
        onEvent(ev);
      } catch (e) { console.error('[ari] event error', e); } });
    ws.on('error', (e) => console.warn('[ari] websocket error:', e.message));
    ws.on('close', () => {
      if (stopped) return;
      // Calls we were tracking can no longer be controlled.
      for (const s of new Set(sessions.values())) if (s.role === 'main') s.h.ended({ reason: 'Lost connection to Asterisk' });
      sessions.clear();
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30000);
    });
  }

  const endpointFor = (trunk, number) => `PJSIP/${number}@trunk${trunk.id}`;

  // ---- call flow ----
  async function play(s, media) {
    if (!media || s.gone) return false;
    const id = `pb-${s.channelId}-${Date.now()}`;
    s.playbackId = id;
    sessions.set(id, s);
    await ari('POST', `/channels/${s.channelId}/play/${id}`, { media });
    return true;
  }

  async function runQueue(s) {
    while (s.queue.length && !s.gone) {
      const media = s.queue.shift();
      try { if (await play(s, media)) return; } catch (e) { console.warn('[ari] play failed', e.message); }
    }
    if (s.gone) return;
    if (s.ivr && !s.transferred) {
      // Menu prompt finished: wait for a digit, repeat, or give up.
      clearTimeout(s.menuTimer);
      s.menuTimer = setTimeout(() => {
        if (s.gone || s.transferred) return;
        if (s.repeats < s.ivr.maxRepeats && s.menuMedia) { s.repeats++; s.queue.push(s.menuMedia); runQueue(s); }
        else hangup(s);
      }, s.ivr.timeoutSec * 1000);
    } else if (!s.transferred) {
      hangup(s);
    }
  }

  function hangup(s) { if (!s.gone) quiet(ari('DELETE', `/channels/${s.channelId}`)); }

  async function onDigit(s, digit) {
    s.h.dtmf(digit);
    if (!s.ivr || s.transferred) return;
    const opt = s.ivr.options[digit];
    if (!opt) return;
    clearTimeout(s.menuTimer);
    if (s.playbackId) quiet(ari('DELETE', `/playbacks/${s.playbackId}`));
    s.queue = [];
    switch (opt.action) {
      case 'play': s.ivr = null; s.queue.push(opt.target); return runQueue(s);
      case 'repeat': s.queue.push(s.menuMedia); return runQueue(s);
      case 'hangup': return hangup(s);
      case 'extension': return transfer(s, `PJSIP/${opt.target}`);
      case 'forward': return transfer(s, endpointFor(s.trunk, opt.target));
    }
  }

  async function transfer(s, endpoint) {
    s.transferred = true;
    try {
      const bridge = await ari('POST', '/bridges', { type: 'mixing' });
      s.bridgeId = bridge.id;
      await ari('POST', `/bridges/${bridge.id}/addChannel`, { channel: s.channelId });
      if (s.moh) await quiet(ari('POST', `/channels/${s.channelId}/moh`, { mohClass: cfg.asterisk.mohClass }));
      else await quiet(ari('POST', `/channels/${s.channelId}/ring`));
      const legId = `leg-${s.channelId}`;
      s.legId = legId;
      sessions.set(legId, { role: 'leg', parent: s, channelId: legId });
      await ari('POST', `/channels/${legId}`, {
        endpoint, app: cfg.ari.app, appArgs: 'leg', callerId: s.callerId || s.trunk.number, timeout: 30,
      });
    } catch (e) {
      console.warn('[ari] transfer failed', e.message);
      hangup(s);
    }
  }

  function onEvent(ev) {
    const ch = ev.channel;
    switch (ev.type) {
      case 'StasisStart': {
        const args = ev.args || [];
        if (args[0] === 'leg') {
          const leg = sessions.get(ch.id);
          if (!leg) return quiet(ari('DELETE', `/channels/${ch.id}`));
          const p = leg.parent;
          quiet(ari('DELETE', `/channels/${p.channelId}/moh`));
          quiet(ari('DELETE', `/channels/${p.channelId}/ring`));
          quiet(ari('POST', `/bridges/${p.bridgeId}/addChannel`, { channel: ch.id }));
          return;
        }
        if (args[0] === 'in') return startInbound(ch, args);
        const s = sessions.get(ch.id);
        if (!s) return;
        s.h.answered();
        runQueue(s);
        return;
      }
      case 'ChannelStateChange': {
        const s = sessions.get(ch.id);
        if (s?.role === 'main' && ch.state === 'Ringing') s.h.ringing();
        return;
      }
      case 'ChannelDtmfReceived': {
        const s = sessions.get(ch.id);
        if (s?.role === 'main') onDigit(s, ev.digit);
        return;
      }
      case 'PlaybackFinished': {
        const s = sessions.get(ev.playback.id);
        sessions.delete(ev.playback.id);
        if (s && s.playbackId === ev.playback.id) { s.playbackId = null; runQueue(s); }
        return;
      }
      case 'ChannelHangupRequest': {
        const s = sessions.get(ch.id);
        if (s && ev.cause != null) s.lastCause = ev.cause;
        return;
      }
      case 'StasisEnd': // a channel that leaves the app (e.g. inbound returning to dialplan) may never send ChannelDestroyed to us
      case 'ChannelDestroyed': {
        const s = sessions.get(ch.id);
        if (!s) return;
        if (ev.type === 'StasisEnd' && !s.inbound) return; // outbound calls and legs report their real cause in ChannelDestroyed
        sessions.delete(ch.id);
        if (s.role === 'leg') { // transfer target hung up or never answered -> end the caller too
          const p = s.parent;
          if (!p.gone) hangup(p);
          return;
        }
        s.gone = true;
        clearTimeout(s.menuTimer);
        if (s.legId) quiet(ari('DELETE', `/channels/${s.legId}`));
        if (s.bridgeId) quiet(ari('DELETE', `/bridges/${s.bridgeId}`));
        const cause = ev.cause ?? s.lastCause ?? 16;
        s.h.ended({ cause, reason: CAUSES[cause] || ev.cause_txt || `Hangup cause ${cause}` });
        return;
      }
    }
  }

  function newSession(channelId, ctx, h) {
    const s = {
      role: 'main', channelId, ctx, h, trunk: ctx.trunk, ivr: ctx.ivr, moh: ctx.moh, repeats: 0,
      menuMedia: ctx.ivr ? ctx.main : null, queue: [ctx.welcome, ctx.main].filter(Boolean),
    };
    sessions.set(channelId, s);
    return s;
  }

  async function startInbound(ch, args) {
    const trunkId = Number(args[1]);
    const reg = engine.registerInbound({ trunkId, from: ch.caller?.number, to: ch.dialplan?.exten, channelId: ch.id });
    if (!reg) return quiet(ari('DELETE', `/channels/${ch.id}`));
    const s = newSession(ch.id, reg.ctx, reg.handlers);
    s.callerId = ch.caller?.number;
    s.inbound = true;
    try { await ari('POST', `/channels/${ch.id}/answer`); } catch { return; }
    reg.handlers.answered();
    if (!s.queue.length) return hangup(s);
    runQueue(s);
  }

  return {
    name: 'asterisk',
    start(e) { engine = e; stopped = false; connect(); },
    stop() { stopped = true; ws?.close(); },
    ari,
    originate(ctx, h) {
      const channelId = `ipc-${ctx.call.id}-${Date.now()}`;
      newSession(channelId, ctx, h);
      h.channel(channelId);
      ari('POST', `/channels/${channelId}`, {
        endpoint: endpointFor(ctx.trunk, ctx.call.to_number), app: cfg.ari.app, appArgs: 'out',
        callerId: ctx.trunk.number, timeout: 45,
      }).catch((e) => {
        sessions.delete(channelId);
        h.ended({ reason: 'Originate failed: ' + e.message.slice(0, 150) });
      });
      return { hangup: () => quiet(ari('DELETE', `/channels/${channelId}`)) };
    },
    /** Update extension + trunk registration status from Asterisk. */
    async syncEndpoints() {
      const { db } = require('../db');
      // Asterisk answers 404 when no PJSIP endpoints exist yet.
      const list = await ari('GET', '/endpoints/PJSIP').catch((e) => { if (/-> 404/.test(e.message)) return []; throw e; });
      const ts = new Date().toISOString();
      const byName = new Map(list.map((e) => [e.resource, e.state]));
      for (const x of db.prepare('SELECT id, sip_number FROM extensions').all()) {
        const st = byName.get(x.sip_number);
        db.prepare('UPDATE extensions SET status = ?, last_sync = ? WHERE id = ?')
          .run(st === 'online' ? 'connected' : st ? 'disconnected' : 'unknown', ts, x.id);
      }
      for (const t of db.prepare('SELECT id FROM ip_numbers').all()) {
        const st = byName.get(`trunk${t.id}`);
        db.prepare('UPDATE ip_numbers SET status = ?, last_sync = ? WHERE id = ?')
          .run(st === 'online' ? 'connected' : st ? 'disconnected' : 'unknown', ts, t.id);
      }
    },
  };
}

/** Quick connectivity check used by the setup wizard and settings page. */
async function testAri({ url, user, pass }) {
  const res = await fetch(`${url.replace(/\/+$/, '')}/ari/asterisk/info`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') },
    signal: AbortSignal.timeout(6000),
  });
  if (res.status === 401) throw new Error('Asterisk rejected the ARI username/password (401)');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const info = await res.json();
  return `Connected: Asterisk ${info.system?.version || ''}`.trim();
}

module.exports = { createAsteriskDriver, testAri, CAUSES };
