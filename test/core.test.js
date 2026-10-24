import { test } from 'node:test';
import assert from 'node:assert/strict';
import { footer, details, countdown } from '../lib/format.js';
import { QuotaMonitor } from '../lib/monitor.js';
import { createCredentialReader } from '../lib/credentials.js';
import { apply, normalizeConfig } from '../lib/index.js';

const now = Date.parse('2026-10-25T00:00:00Z');
const snapshot = { provider: 'antigravity', kind: 'windows', status: 'ok', fetchedAt: new Date(now).toISOString(), windows: [
  { id: 'a', label: 'model-a', modelIds: ['model-a'], remainingFraction: 0.82, resetAt: new Date(now + 3600000).toISOString() },
  { id: 'b', label: 'model-b', modelIds: ['model-b'], remainingFraction: 0.1 },
] };
test('footer uses exact model, remaining percentages, conservative reset and unknowns', () => {
  assert.match(footer(snapshot, { model: 'model-a' }, now).text, /82% \(1h\)/);
  assert.equal(footer(snapshot, { model: 'model-b' }, now).tone, 'warning');
  assert.equal(footer(snapshot, { model: 'other' }, now).text, '额度未知');
  assert.equal(footer(snapshot, { model: 'model-a' }, now + 3600001).text, '额度待刷新');
  assert.equal(countdown('bad', now), undefined);
  assert.match(footer({ ...snapshot, stale: true }, { model: 'model-a' }, now).text, /^~/);
  assert.equal(footer({ ...snapshot, stale: true }, { model: 'model-a' }, now).tone, 'dim');
  assert.match(details([snapshot], now), /model-b/);
  assert.match(details([snapshot], now + 3600001), /待刷新/);
  assert.ok(!details([snapshot], now + 3600001).includes('剩余 82%'));
});
test('balance formatting preserves decimal strings; unknown is not zero', () => {
  assert.equal(footer({ kind: 'balance', balances: [{ currency: 'CNY', available: '42.50' }] }, {}).text, '¥42.50');
  assert.equal(footer({ kind: 'balance', balances: [] }, {}).text, '额度未知');
  assert.match(footer({ status: 'rate-limited' }, {}).text, /查询限流/);
});
test('monitor coalesces refresh, preserves stale values and obeys Retry-After', async () => {
  let calls = 0;
  let tick = now;
  let limited = false;
  const monitor = new QuotaMonitor([{ provider: 'ds', kind: 'deepseek-balance' }], {
    now: () => tick, readCredential: async () => 'fake-key',
    fetchImpl: async () => { calls++; return limited
      ? new Response('', { status: 429, headers: { 'Retry-After': '120' } })
      : new Response(JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '3.50' }] })); },
  });
  await Promise.all([monitor.refresh('ds'), monitor.refresh('ds')]);
  assert.equal(calls, 1);
  await monitor.refresh('ds'); assert.equal(calls, 1); // successful cache is reused
  await monitor.refresh('ds', { force: true }); assert.equal(calls, 1); // explicit refresh still throttled
  limited = true;
  tick += 10001;
  await monitor.refresh('ds', { force: true });
  assert.equal(monitor.get('ds').stale, true);
  assert.equal(monitor.get('ds').balances[0].available, '3.50');
  assert.equal(monitor.get('ds').status, 'rate-limited');
  await monitor.refresh('ds'); assert.equal(calls, 2);
  tick += 120001;
  await monitor.refresh('ds'); assert.equal(calls, 3);
  monitor.close();
});
test('credential reader only reads companion auth, rejects expiry and returns no refresh token', async () => {
  let path;
  const read = createCredentialReader({ env: { DSH_HOME: '/isolated', EXPLICIT_KEY: 'fake' }, now: () => now,
    readFileImpl: async value => { path = value; return JSON.stringify({ version: 1,
      credentials: { access: 'fake-access', refresh: 'must-not-return', expires: now + 10000, projectId: 'fake-project' } }); },
  });
  const credential = await read({ kind: 'antigravity' });
  assert.equal(path, '/isolated/plugins/antigravity/auth.json');
  assert.equal(credential.refresh, undefined);
  assert.equal(await read({ kind: 'deepseek-balance', keyEnv: 'EXPLICIT_KEY' }), 'fake');
  await assert.rejects(read({ kind: 'deepseek-balance', keyEnv: 'MISSING' }), { code: 'NEEDS_AUTH' });
  const expired = createCredentialReader({ env: {}, now: () => now, readFileImpl: async () => JSON.stringify({ version: 1, credentials: { access: 'fake', expires: now - 1 } }) });
  await assert.rejects(expired({ kind: 'antigravity' }), { code: 'NEEDS_AUTH' });
});
test('config refuses duplicates, inline secrets and custom origins', () => {
  assert.equal(normalizeConfig().sources[0].provider, 'antigravity');
  assert.throws(() => normalizeConfig({ sources: [{ kind: 'deepseek-balance', provider: 'ds' }] }));
  assert.throws(() => normalizeConfig({ sources: [{ kind: 'antigravity', provider: 'ag', url: 'https://evil.example' }] }));
  assert.throws(() => normalizeConfig({ sources: [{ kind: 'antigravity', provider: 'ag' }, { kind: 'antigravity', provider: 'ag' }] }));
});
test('plugin isolates focused session, observes routing without mutation, and cleans listeners', async () => {
  const listeners = new Map(); let onChanged, command, field, releaseCount = 0;
  const agent = { session: { id: 'main' }, options: { provider: 'antigravity', model: 'a' } };
  const context = {
    tuiStatus: { setField(key, text, options) { field = { key, text, options }; return () => { releaseCount++; }; } },
    commands: { register(value) { command = value; return () => releaseCount++; } },
    sessionProjections: { snapshot() { return { values: { modelSelection: { next: { provider: 'antigravity', model: 'a' } } } }; },
      onChanged(fn) { onChanged = fn; return () => releaseCount++; } },
    agents: { get() { return agent; } },
    on(name, fn) { listeners.set(name, fn); return () => { listeners.delete(name); releaseCount++; }; },
  };
  // No sources: this lifecycle test cannot read credentials or issue network I/O.
  const dispose = apply(context, { sources: [] });
  assert.match(field.text, /quota/);
  await command.handler({ rawInput: '', agent });
  const call = { provider: 'other', model: 'b' };
  assert.equal(await listeners.get('agent/request')({ agent: { session: { id: 'child' } } }, async () => call), call);
  onChanged({ id: 'child' }, 'modelSelection', { next: { provider: 'bad', model: 'bad' } });
  listeners.get('tui/session-switched')({ sessionId: 'main' });
  dispose();
  assert.equal(listeners.size, 0);
  assert.ok(releaseCount >= 4);
});
