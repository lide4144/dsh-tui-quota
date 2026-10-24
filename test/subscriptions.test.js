import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchQuota } from '../lib/sources.js';
import { codexAccountId } from '../lib/subscriptions.js';
import { footer, currentWindows } from '../lib/format.js';
import { createCredentialReader } from '../lib/credentials.js';

const json = (body, init) => new Response(JSON.stringify(body), init);
function recorder(body, init) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => { calls.push({ url, options }); return json(body, init); } };
}
const now = Date.parse('2026-10-25T00:00:00Z');
const later = seconds => new Date(Date.now() + seconds * 1000).toISOString();

test('Codex reads wham/usage with account header and labels windows by duration', async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 3600;
  const { calls, fetchImpl } = recorder({ rate_limit: {
    primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: resetAt },
    secondary_window: { used_percent: 90, limit_window_seconds: 604800, reset_after_seconds: 7200 } } });
  const snap = await fetchQuota({ provider: 'openai-codex', kind: 'codex-subscription' },
    { fetchImpl, readCredential: async () => ({ access: 'fake-access', accountId: 'acct-1' }) });
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['chatgpt-account-id'], 'acct-1');
  assert.deepEqual(snap.windows.map(w => [w.label, w.remainingFraction, w.scope]),
    [['Codex 5h', 0.75, 'account'], ['Codex 7d', 0.1, 'account']]);
  assert.match(footer(snap, { provider: 'openai-codex', model: 'gpt-5.6-sol' }).text, /10%/);
});

test('Codex account id falls back to JWT claim; missing id needs auth without network', async () => {
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-jwt' } })).toString('base64url');
  assert.equal(codexAccountId({ access: `x.${payload}.y` }), 'acct-jwt');
  assert.equal(codexAccountId({ access: 'opaque', accountId: 'bad\nid' }), undefined);
  let fetched = false;
  await assert.rejects(fetchQuota({ provider: 'c', kind: 'codex-subscription' },
    { fetchImpl: async () => { fetched = true; }, readCredential: async () => ({ access: 'opaque' }) }), { code: 'NEEDS_AUTH' });
  assert.equal(fetched, false);
});

test('Claude modern limits keep model-family scope; unknown scoped families are dropped', async () => {
  const { calls, fetchImpl } = recorder({ limits: [
    { kind: 'session', percent: 40, resets_at: later(3600) },
    { kind: 'weekly_scoped', percent: 95, scope: { model: { display_name: 'Claude Opus' } } },
    { kind: 'weekly_scoped', percent: 99, scope: { model: { display_name: 'Mystery' } } },
  ] });
  const snap = await fetchQuota({ provider: 'anthropic', kind: 'claude-subscription' },
    { fetchImpl, readCredential: async () => ({ access: 'fake' }) });
  assert.equal(calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(snap.windows.length, 2);
  assert.equal(currentWindows(snap, { model: 'claude-sonnet-5' }).length, 1);
  assert.equal(currentWindows(snap, { model: 'claude-opus-5-5' }).length, 2);
  assert.match(footer(snap, { model: 'claude-opus-5-5' }).text, /5%/);
  assert.match(footer(snap, { model: 'claude-sonnet-5' }).text, /60%/);
});

test('Claude legacy buckets parse; out-of-range utilisation is unknown, not zero', async () => {
  const { fetchImpl } = recorder({ five_hour: { utilization: 10 }, seven_day: { utilization: 150 },
    seven_day_sonnet: { utilization: 50 } });
  const snap = await fetchQuota({ provider: 'anthropic', kind: 'claude-subscription' },
    { fetchImpl, readCredential: async () => ({ access: 'fake' }) });
  assert.deepEqual(snap.windows.map(w => w.id), ['claude:five_hour', 'claude:seven_day_sonnet']);
});

test('Kimi Code string counts become remaining/limit; malformed windows dropped', async () => {
  const { calls, fetchImpl } = recorder({
    usage: { limit: '100', remaining: '74', resetTime: later(86400) },
    limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '85', resetTime: later(600) } },
      { window: {}, detail: { limit: '0', remaining: '0' } }, { detail: { limit: '10', remaining: '11' } }] });
  const snap = await fetchQuota({ provider: 'kimi-coding', kind: 'kimi-code', keyEnv: 'K' },
    { fetchImpl, readCredential: async () => 'sk-fake' });
  assert.equal(calls[0].url, 'https://api.kimi.com/coding/v1/usages');
  assert.equal(calls[0].options.headers.authorization, 'Bearer sk-fake');
  assert.deepEqual(snap.windows.map(w => w.label), ['Kimi Code 5h', 'Kimi Code 周期总量']);
  assert.match(footer(snap, { model: 'kimi-for-coding' }).text, /74\/100/);
});

test('subscription errors are status-only and 401 maps to safe error', async () => {
  for (const kind of ['codex-subscription', 'claude-subscription', 'kimi-code']) {
    const fetchImpl = async () => new Response('token=sk-secret leaked', { status: 401 });
    const error = await fetchQuota({ provider: 'p', kind, keyEnv: 'K' },
      { fetchImpl, readCredential: async () => kind === 'kimi-code' ? 'sk-x' : { access: 'a', accountId: 'b' } }).catch(e => e);
    assert.equal(error.status, 401);
    assert.ok(!String(error.message).includes('secret'));
  }
});

test('Antigravity footer maps public route ids to runtime quota keys by effort', () => {
  const snap = { kind: 'windows', status: 'ok', windows: [
    { id: '1', modelIds: ['gemini-3.8-flash-low'], remainingFraction: 0.9 },
    { id: '2', modelIds: ['gemini-3.8-flash-high'], remainingFraction: 0.4 },
    { id: '3', modelIds: ['gemini-pro-agent'], remainingFraction: 0.2 },
    { id: '4', modelIds: ['gemini-3.1-pro-low'], remainingFraction: 0.7 },
    { id: '5', modelIds: ['claude-opus-4-6-thinking'], remainingFraction: 0.5 },
    { id: '6', modelIds: ['gemini-3.7-flash-low'], remainingFraction: 0.01 },
  ] };
  assert.match(footer(snap, { model: 'gemini-3.8-flash', reasoningEffort: 'high' }).text, /40%/);
  assert.match(footer(snap, { model: 'gemini-3.8-flash', reasoningEffort: 'minimal' }).text, /90%/);
  assert.match(footer(snap, { model: 'gemini-3.8-flash' }).text, /90%/); // default routes to -low
  assert.match(footer(snap, { model: 'gemini-3.1-pro', reasoningEffort: 'high' }).text, /20%/);
  assert.match(footer(snap, { model: 'gemini-3.1-pro', reasoningEffort: 'low' }).text, /70%/);
  assert.match(footer(snap, { model: 'claude-opus-4-6' }).text, /50%/);
  // Sibling generations never leak into each other.
  assert.equal(currentWindows(snap, { model: 'gemini-3.8-flash' }).some(w => w.id === '6'), false);
  assert.equal(footer(snap, { model: 'unknown-model' }).text, '额度未知');
});

test('credential reader uses dsh /auth store read-only and DSH credential service for keys', async () => {
  const files = {};
  const store = { version: 1, providers: {
    'openai-codex': { type: 'oauth', access: 'codex-access', refresh: 'never-return', expires: now + 60000, accountId: 'acct' },
    anthropic: { type: 'oauth', access: 'old', refresh: 'r', expires: now - 1 } } };
  const read = createCredentialReader({ env: { DSH_HOME: '/iso' }, now: () => now,
    readFileImpl: async path => { files[path] = true; return JSON.stringify(store); },
    credentials: { resolve: async ref => ref === 'KIMI_CODING_API_KEY' ? { value: 'sk-kimi', source: 'file' } : undefined } });
  assert.deepEqual(await read({ kind: 'codex-subscription' }), { access: 'codex-access', accountId: 'acct' });
  assert.ok(files['/iso/dsh-auth/credentials.json']);
  await assert.rejects(read({ kind: 'claude-subscription' }), { code: 'NEEDS_AUTH' }); // expired: no refresh attempt
  assert.equal(await read({ kind: 'kimi-code', keyEnv: 'KIMI_CODING_API_KEY' }), 'sk-kimi');
  await assert.rejects(read({ kind: 'deepseek-balance', keyEnv: 'MISSING' }), { code: 'NEEDS_AUTH' });
});
