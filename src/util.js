const crypto = require('crypto');
const cfg = require('./config');

const now = () => new Date().toISOString();
const token = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');

/** Normalise a phone number to digits-only international format (no +). Returns null if invalid. */
function normalizePhone(raw, country = cfg.country) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  s = s.replace(/[\s\-().]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('00')) s = s.slice(2);
  if (!/^\d+$/.test(s)) return null;
  if (country === 'BD') {
    if (/^1[3-9]\d{8}$/.test(s)) s = '880' + s;          // 17XXXXXXXX
    else if (/^0[1-9]\d{6,10}$/.test(s)) s = '880' + s.slice(1); // national format: 017..., 02..., 096...
    if (s.startsWith('8801')) return /^8801[3-9]\d{8}$/.test(s) ? s : null; // mobile: strict
    if (s.startsWith('880')) return /^880[2-9]\d{7,9}$/.test(s) ? s : null; // landline / 09 numbers
  }
  return /^\d{8,15}$/.test(s) ? s : null;
}

/** Split free text (newline / comma / space separated) into unique valid numbers. */
function parsePhoneList(text) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const tok of String(text || '').split(/[\s,;]+/)) {
    if (!tok) continue;
    const n = normalizePhone(tok);
    if (!n) invalid.push(tok);
    else if (!seen.has(n)) { seen.add(n); valid.push(n); }
  }
  return { valid, invalid };
}

// International numbers get a '+'; local-format numbers (leading 0, e.g. trunk 096...) are shown as-is.
const fmtPhone = (d) => (d ? (/^[1-9]\d{7,14}$/.test(d) ? '+' + d : d) : '—');

// Formatter is rebuilt if the display timezone changes in settings.
let _dtf = null, _dtfTz = null;
function dtf() {
  if (_dtfTz !== cfg.tz) {
    try {
      _dtf = new Intl.DateTimeFormat('sv-SE', { timeZone: cfg.tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    } catch { cfg.tz = 'UTC'; return dtf(); }
    _dtfTz = cfg.tz;
  }
  return _dtf;
}
const fmtDate = (iso) => (iso ? dtf().format(new Date(iso)) : '—');

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const future = s < 0;
  const a = Math.abs(s);
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, sec] of units) {
    if (a >= sec) { const n = Math.floor(a / sec); return future ? `in ${n} ${u}${n > 1 ? 's' : ''}` : `${n} ${u}${n > 1 ? 's' : ''} ago`; }
  }
  return 'just now';
}

function fmtDuration(sec) {
  if (sec == null) return '—';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
const fmtMoney = (n) => `${cfg.currency} ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '—');

/** Minutes the display timezone is ahead of UTC at a given instant. */
function tzOffsetMin(date) {
  const p = Object.fromEntries(dtf().formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}
/** 'YYYY-MM-DD' (display tz) -> UTC ISO at start or end of that day. */
function localDayToUtc(day, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return null;
  const [y, m, d] = day.split('-').map(Number);
  const guess = endOfDay ? Date.UTC(y, m - 1, d, 23, 59, 59, 999) : Date.UTC(y, m - 1, d);
  return new Date(guess - tzOffsetMin(new Date(guess)) * 60000).toISOString();
}
/** 'YYYY-MM-DDTHH:MM' (display tz, from <input type=datetime-local>) -> UTC ISO */
function localDateTimeToUtc(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || '');
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return new Date(guess - tzOffsetMin(new Date(guess)) * 60000).toISOString();
}
const todayLocal = () => fmtDate(now()).slice(0, 10);

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function paginate(total, page, per = 25) {
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(Math.max(1, parseInt(page, 10) || 1), pages);
  return { page: p, pages, per, total, offset: (p - 1) * per };
}

const int = (v, def = null) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; };
const num = (v, def = null) => { const n = parseFloat(v); return Number.isFinite(n) ? n : def; };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BADGES = {
  completed: 'b-green', answered: 'b-green', connected: 'b-green', active: 'b-green',
  failed: 'b-red', disconnected: 'b-red', suspended: 'b-red',
  ringing: 'b-amber', paused: 'b-amber', dialing: 'b-blue', running: 'b-blue', open: 'b-blue',
  scheduled: 'b-indigo', queued: 'b-gray', cancelled: 'b-gray', closed: 'b-gray', unknown: 'b-gray',
};
const badge = (status, label) => `<span class="badge ${BADGES[status] || 'b-gray'}">${esc(label || (status ? status[0].toUpperCase() + status.slice(1) : '—'))}</span>`;
/** Build a query string from the current query with overrides (null removes a key). */
function qs(query, over = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...query, ...over })) if (v !== null && v !== undefined && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
}

module.exports = {
  esc, badge, qs,
  now, token, normalizePhone, parsePhoneList, fmtPhone, fmtDate, timeAgo, fmtDuration, fmtNum,
  fmtMoney, pct, localDayToUtc, localDateTimeToUtc, todayLocal, csvEscape, paginate, int, num, tzOffsetMin,
};
