const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cfg = require('./config');

fs.mkdirSync(cfg.dataDir, { recursive: true });
fs.mkdirSync(path.join(cfg.dataDir, 'uploads'), { recursive: true });

const db = require('./sqlite').open(path.join(cfg.dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  balance REAL NOT NULL DEFAULT 0,
  rate_per_min REAL NOT NULL DEFAULT 0.35,
  pulse_sec INTEGER NOT NULL DEFAULT 60,
  max_extensions INTEGER NOT NULL DEFAULT 10,
  api_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  phone TEXT NOT NULL,
  banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, phone)
);

CREATE TABLE IF NOT EXISTS contact_groups (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, contact_id)
);

CREATE TABLE IF NOT EXISTS voice_files (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT,
  mime TEXT,
  size INTEGER,
  duration REAL,
  asterisk_ready INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ip_numbers (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  username TEXT,
  password TEXT,
  sip_server TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 5060,
  transport TEXT NOT NULL DEFAULT 'udp',
  is_main INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  max_concurrent INTEGER NOT NULL DEFAULT 5,
  cps INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_sync TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS extensions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sip_number TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  agent_name TEXT,
  forward_to TEXT,
  reg_ip TEXT,
  device_info TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_sync TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ivrs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt_file_id INTEGER REFERENCES voice_files(id) ON DELETE SET NULL,
  timeout_sec INTEGER NOT NULL DEFAULT 8,
  max_repeats INTEGER NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ivr_options (
  id INTEGER PRIMARY KEY,
  ivr_id INTEGER NOT NULL REFERENCES ivrs(id) ON DELETE CASCADE,
  digit TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('play','extension','forward','repeat','hangup')),
  target TEXT,
  label TEXT,
  UNIQUE (ivr_id, digit)
);

CREATE TABLE IF NOT EXISTS ivr_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  welcome_enabled INTEGER NOT NULL DEFAULT 0,
  welcome_file_id INTEGER REFERENCES voice_files(id) ON DELETE SET NULL,
  moh_enabled INTEGER NOT NULL DEFAULT 0,
  moh_file_id INTEGER REFERENCES voice_files(id) ON DELETE SET NULL,
  ivr_enabled INTEGER NOT NULL DEFAULT 0,
  ivr_id INTEGER REFERENCES ivrs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  source TEXT NOT NULL DEFAULT 'web',
  voice_file_id INTEGER REFERENCES voice_files(id) ON DELETE SET NULL,
  ivr_id INTEGER REFERENCES ivrs(id) ON DELETE SET NULL,
  ip_number_id INTEGER REFERENCES ip_numbers(id) ON DELETE SET NULL,
  total INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  retry_delay_sec INTEGER NOT NULL DEFAULT 300,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('scheduled','running','paused','completed','cancelled')),
  pause_reason TEXT,
  scheduled_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER REFERENCES batches(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_number_id INTEGER REFERENCES ip_numbers(id) ON DELETE SET NULL,
  direction TEXT NOT NULL DEFAULT 'out' CHECK (direction IN ('out','in')),
  from_number TEXT,
  to_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','dialing','ringing','answered','completed','failed','cancelled')),
  fail_reason TEXT,
  hangup_cause INTEGER,
  dtmf TEXT,
  duration INTEGER,
  cost REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  channel_id TEXT,
  initiated_at TEXT NOT NULL,
  sent_at TEXT,
  answered_at TEXT,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_user ON calls(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status, ip_number_id);
CREATE INDEX IF NOT EXISTS idx_calls_batch ON calls(batch_id);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('topup','call','refund','adjust')),
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  note TEXT,
  call_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, id DESC);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

// ---- small migrations for databases created by older versions ----
function addColumn(table, column, ddl) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumn('ip_numbers', 'status_detail', 'status_detail TEXT');

const getSetting = (key, def = '') => {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : def;
};
const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));

// Apply settings saved by the setup wizard on top of .env values.
cfg.applyOverrides(Object.fromEntries(db.prepare("SELECT key, value FROM settings WHERE key LIKE 'cfg:%'").all()
  .map((r) => [r.key.slice(4), r.value])));

const isInstalled = () => getSetting('installed') === '1';

/** Headless install: if ADMIN_USERNAME and ADMIN_PASSWORD are set, skip the web wizard. */
function headlessInstall() {
  if (isInstalled() || !process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) return;
  if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
    db.prepare(`INSERT INTO users (name, username, password_hash, role, api_key, created_at)
                VALUES ('Administrator', ?, ?, 'admin', ?, ?)`)
      .run(process.env.ADMIN_USERNAME, bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10), crypto.randomBytes(24).toString('hex'), new Date().toISOString());
  }
  setSetting('installed', '1');
  console.log(`[setup] Headless install done; admin user "${process.env.ADMIN_USERNAME}"`);
}
headlessInstall();

function saveConfig(map) {
  for (const [k, v] of Object.entries(map)) if (cfg.EDITABLE.includes(k)) setSetting('cfg:' + k, v ?? '');
  cfg.applyOverrides(map);
}

module.exports = { db, getSetting, setSetting, isInstalled, saveConfig };
