const test = require('node:test');
const assert = require('node:assert');
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ipc-u-'));
const u = require('../src/util');
const { callCost } = require('../src/services/billing');

test('normalizes Bangladeshi numbers', () => {
  assert.strictEqual(u.normalizePhone('01729971705'), '8801729971705');
  assert.strictEqual(u.normalizePhone('+880 1729-971705'), '8801729971705');
  assert.strictEqual(u.normalizePhone('00-8801729971705'), '8801729971705');
  assert.strictEqual(u.normalizePhone('1729971705'), '8801729971705');
  assert.strictEqual(u.normalizePhone('01229971705'), null); // invalid operator prefix
  assert.strictEqual(u.normalizePhone('12345'), null);
  assert.strictEqual(u.normalizePhone('09639792313'), '8809639792313'); // 09 series
  assert.strictEqual(u.normalizePhone('0255012345'), '880255012345');   // Dhaka landline
  assert.strictEqual(u.normalizePhone('+447911123456'), '447911123456');
});

test('parses phone lists and removes duplicates', () => {
  const r = u.parsePhoneList('01711111111, 01711111111\n01811111111 bad');
  assert.deepStrictEqual(r.valid, ['8801711111111', '8801811111111']);
  assert.deepStrictEqual(r.invalid, ['bad']);
});

test('formats phone numbers', () => {
  assert.strictEqual(u.fmtPhone('8801711111111'), '+8801711111111');
  assert.strictEqual(u.fmtPhone('09639000000'), '09639000000');
});

test('bills in pulses', () => {
  assert.strictEqual(callCost(0, 0.35, 60), 0);
  assert.strictEqual(callCost(1, 0.35, 60), 0.35);
  assert.strictEqual(callCost(61, 0.35, 60), 0.7);
  assert.strictEqual(callCost(61, 0.6, 1), 0.61);
});

test('converts local day to UTC', () => {
  // Default display zone is Asia/Dhaka (UTC+6)
  assert.strictEqual(u.localDayToUtc('2026-11-10'), '2026-11-09T18:00:00.000Z');
  assert.strictEqual(u.fmtDuration(3725), '1:02:05');
});
