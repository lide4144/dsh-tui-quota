import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess, QuotaAlerts } from '../lib/warnings.js';
import { shortLabel } from '../lib/format.js';

const now = Date.parse('2026-10-25T00:00:00Z');
const H = 3600000;
const win = (remainingFraction, resetInMs, windowMs, extra = {}) => ({ id: 'w', label: 'Codex 5h', remainingFraction,
  ...(resetInMs === undefined ? {} : { resetAt: new Date(now + resetInMs).toISOString() }), ...(windowMs ? { windowMs } : {}), ...extra });

test('pace projection flags fast burn early, tolerates normal pace', () => {
  // 1h into a 5h window with 60% used -> projected 300%.
  assert.equal(assess(win(0.4, 4 * H, 5 * H), now).severity, 'high');
  // 4h into 5h with 50% used -> on track.
  assert.equal(assess(win(0.5, 1 * H, 5 * H), now).severity, 'none');
  // Early-window noise below the used floor never alerts.
  assert.equal(assess(win(0.9, 4.9 * H, 5 * H), now).severity, 'none');
});
test('absolute fallback without window length, and expired windows never alert', () => {
  assert.equal(assess(win(0.15), now).severity, 'warning');
  assert.equal(assess(win(0.05), now).severity, 'high');
  assert.equal(assess(win(0), now).severity, 'critical');
  assert.equal(assess(win(0.5), now).severity, 'none');
  assert.equal(assess(win(0, -1, 5 * H), now).severity, 'none');
});
test('alerts fire once, re-fire on escalation or after cooldown, reset when safe', () => {
  const alerts = new QuotaAlerts();
  assert.equal(alerts.check('p', [win(0.15)], now).length, 1);
  assert.equal(alerts.check('p', [win(0.15)], now + 60000).length, 0);
  assert.equal(alerts.check('p', [win(0.05)], now + 120000).length, 1); // escalated
  assert.equal(alerts.check('p', [win(0.05)], now + 180000).length, 0);
  assert.equal(alerts.check('p', [win(0.05)], now + 18 * 60000).length, 1); // cooldown passed
  assert.equal(alerts.check('p', [win(0.6)], now + 19 * 60000).length, 0);
  assert.equal(alerts.check('p', [win(0.15)], now + 20 * 60000).length, 1); // fresh after recovery
});
test('footer short labels', () => {
  assert.equal(shortLabel({ label: 'Codex 5h' }), '5h');
  assert.equal(shortLabel({ label: 'Claude 7d opus' }), '7d');
  assert.equal(shortLabel({ label: 'gemini-3.8-flash-low (weekly)' }), '周');
  assert.equal(shortLabel({ label: 'gemini-3.8-flash-low (ordinary)' }), '');
});
