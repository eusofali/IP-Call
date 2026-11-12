// End-to-end: boots the app with the simulator driver and runs a campaign through the REST API.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-api-')),
  ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'secret123', CALL_DRIVER: 'simulator', BILLING_ENABLED: '1', SIM_SPEED: '200', ENGINE_TICK_MS: '50',
});
const { db } = require('../src/db');
const { Engine } = require('../src/engine');
const { createDriver } = require('../src/drivers');
const { createApp } = require('../src/app');
const { adjust } = require('../src/services/billing');

let server, base, engine, key;
test.before(async () => {
  engine = new Engine(createDriver('simulator'));
  engine.start();
  server = createApp(engine).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const admin = db.prepare("SELECT * FROM users WHERE username = 'admin'").get();
  key = admin.api_key;
  adjust(admin.id, 20, 'topup', 'test');
  const ts = new Date().toISOString();
  db.prepare(`INSERT INTO ip_numbers (user_id, number, sip_server, max_concurrent, cps, is_main, created_at) VALUES (?, '09639000000', 'sip.test', 20, 20, 1, ?)`).run(admin.id, ts);
  db.prepare(`INSERT INTO voice_files (user_id, name, filename, created_at) VALUES (?, 'msg', 'x.wav', ?)`).run(admin.id, ts);
  db.prepare(`INSERT INTO contacts (user_id, phone, banned, created_at) VALUES (?, '8801700000009', 1, ?)`).run(admin.id, ts);
});
test.after(() => { engine.stop(); server.close(); });

const api = (p, opts = {}) => fetch(base + '/api/v1' + p, {
  ...opts, headers: { Authorization: `Bearer ${opts.key ?? key}`, 'Content-Type': 'application/json' },
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test('rejects bad API key', async () => {
  assert.strictEqual((await api('/balance', { key: 'nope' })).status, 401);
});

test('validates input', async () => {
  const r = await api('/calls', { method: 'POST', body: JSON.stringify({ numbers: ['123'], voice_file_id: 1 }) });
  assert.strictEqual(r.status, 422);
});

test('runs a campaign, skips banned numbers and bills answered calls', async () => {
  const numbers = Array.from({ length: 20 }, (_, i) => '0170000000' + (i % 10)).concat(['01700000009']);
  const r = await api('/calls', { method: 'POST', body: JSON.stringify({ numbers, voice_file_id: 1 }) });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.queued, 9); // 10 unique, 1 banned
  assert.strictEqual(r.body.skipped_banned, 1);

  let b;
  for (let i = 0; i < 200; i++) {
    b = (await api('/batches/' + r.body.batch_id)).body;
    if (b.status === 'completed') break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.strictEqual(b.status, 'completed');
  assert.strictEqual(b.completed + b.failed, 9);

  const spent = db.prepare("SELECT COALESCE(-SUM(amount),0) s FROM transactions WHERE type = 'call'").get().s;
  assert.ok(Math.abs(spent - b.cost) < 0.001, `ledger ${spent} == batch cost ${b.cost}`);
  const bal = (await api('/balance')).body.balance;
  assert.ok(Math.abs(bal - (20 - b.cost)) < 0.001);
});

test('web pages require login and render after login', async () => {
  const r = await fetch(base + '/calls', { redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  // log in with session cookie + csrf
  const loginPage = await fetch(base + '/login');
  const cookie = loginPage.headers.get('set-cookie').split(';')[0];
  const csrf = (await loginPage.text()).match(/name="_csrf" value="([^"]+)"/)[1];
  const lr = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, username: 'admin', password: 'secret123', next: '/' }) });
  assert.strictEqual(lr.status, 302);
  const sess = lr.headers.get('set-cookie')?.split(';')[0] || cookie;
  for (const p of ['/', '/contacts', '/groups', '/send-call', '/calls', '/batches', '/monitoring', '/voice-files', '/extensions', '/ip-numbers', '/ivr', '/ivr/new', '/billing', '/developers', '/tickets', '/tutorial', '/profile', '/admin/users', '/admin/settings']) {
    const pr = await fetch(base + p, { headers: { cookie: sess }, redirect: 'manual' });
    assert.strictEqual(pr.status, 200, p);
  }
  // CSRF is enforced
  const bad = await fetch(base + '/groups', { method: 'POST', headers: { cookie: sess, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=x' });
  assert.strictEqual(bad.status, 403);
});

test('with billing disabled, calls run with zero balance and are not charged', async () => {
  const cfg = require('../src/config');
  cfg.billing = false;
  try {
    db.prepare("UPDATE users SET balance = 0 WHERE username = 'admin'").run();
    const before = db.prepare('SELECT COUNT(*) n FROM transactions').get().n;
    const r = await api('/calls', { method: 'POST', body: JSON.stringify({ numbers: ['01811111111', '01811111112', '01811111113'], voice_file_id: 1 }) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    let b;
    for (let i = 0; i < 200; i++) {
      b = (await api('/batches/' + r.body.batch_id)).body;
      if (b.status === 'completed') break;
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.strictEqual(b.status, 'completed');
    assert.strictEqual(b.cost, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM transactions').get().n, before);
  } finally { cfg.billing = true; }
});
