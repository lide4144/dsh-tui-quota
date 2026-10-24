import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchQuota } from '../lib/sources.js';

const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const source = kind => ({ kind, provider: 'fixture' });
const readCredential = async () => 'fake-token';

test('DeepSeek preserves decimal strings and currencies without arithmetic', async () => {
  const result = await fetchQuota(source('deepseek-balance'), { readCredential,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.deepseek.com/user/balance');
      assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
      return response({ balance_infos: [
        { currency: 'CNY', total_balance: '123456789012345.123456' },
        { currency: 'USD', total_balance: '0' },
      ] });
    } });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.balances, [{ currency: 'CNY', available: '123456789012345.123456' }, { currency: 'USD', available: '0' }]);
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
});

test('missing balances remain unknown, never zero', async () => {
  for (const kind of ['deepseek-balance', 'moonshot-balance']) {
    const result = await fetchQuota(source(kind), { readCredential, fetchImpl: async () => response({}) });
    assert.equal(result.status, 'unknown'); assert.deepEqual(result.balances, []);
  }
});

test('Moonshot uses official available balance and validates business success', async () => {
  const payload = { code: 0, status: true, data: { available_balance: 5, voucher_balance: 5, cash_balance: -2 } };
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://api.moonshot.cn/v1/users/me/balance'); assert.equal(init.method, 'GET');
    return response(payload);
  };
  assert.deepEqual((await fetchQuota(source('moonshot-balance'), { readCredential, fetchImpl })).balances,
    [{ currency: 'CNY', available: '5' }]);
  payload.status = false;
  assert.equal((await fetchQuota(source('moonshot-balance'), { readCredential, fetchImpl })).status, 'unknown');
});

test('AG only reads account and models, preserves per-model and weekly windows', async () => {
  const calls = []; const controller = new AbortController();
  const result = await fetchQuota(source('antigravity'), {
    readCredential: async () => ({ access: 'fake-ag' }), signal: controller.signal,
    fetchImpl: async (url, init) => {
      calls.push(url); assert.equal(init.method, 'POST'); assert.equal(init.signal, controller.signal);
      if (url.endsWith(':loadCodeAssist')) return response({ cloudaicompanionProject: { id: 'fake-project' } });
      assert.deepEqual(JSON.parse(init.body), { project: 'fake-project' });
      return response({ models: {
        alpha: { quotaInfo: { remainingFraction: 0, resetTime: '2026-01-01T00:00:00Z' }, weeklyQuotaInfo: { remainingFraction: 0.5 } },
        beta: { quotaInfo: { remainingFraction: 0 }, weeklyQuota: { remainingFraction: 1 } },
        missing: {}, invalid: { quotaInfo: { remainingFraction: -1 } },
      } });
    },
  });
  assert.equal(calls.length, 2); assert.ok(calls.every(url => !url.includes('onboard')));
  assert.equal(result.status, 'ok'); assert.equal(result.windows.length, 4);
  assert.deepEqual(result.windows[0].modelIds, ['alpha']);
  assert.equal(result.windows[0].remainingFraction, 0);
  assert.equal(result.windows[0].resetAt, '2026-01-01T00:00:00Z');
  assert.equal(result.windows[1].id, 'alpha:weekly');
});

test('AG no project or missing quota remains unknown without onboarding', async () => {
  for (const account of [{}, { cloudaicompanionProject: 'fake-project' }]) {
    const calls = [];
    const result = await fetchQuota(source('antigravity'), { readCredential: async () => ({ access: 'fake' }),
      fetchImpl: async url => { calls.push(url); return response(url.endsWith(':loadCodeAssist') ? account : { models: { alpha: {} } }); } });
    assert.equal(result.status, 'unknown'); assert.deepEqual(result.windows, []);
    assert.equal(calls.length, account.cloudaicompanionProject ? 2 : 1);
  }
});

test('HTTP and transport errors never include response body or credentials', async () => {
  await assert.rejects(fetchQuota(source('deepseek-balance'), { readCredential,
    fetchImpl: async () => ({ ok: false, status: 401, json: () => { throw Error('secret'); } }) }),
  { message: 'Quota HTTP 401' });
  await assert.rejects(fetchQuota(source('deepseek-balance'), { readCredential,
    fetchImpl: async () => { throw Error('fake-token secret URL'); } }), { message: 'Quota network request failed' });
});

test('stream response limit cancels oversized bodies', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1_048_577)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(fetchQuota(source('deepseek-balance'), { readCredential,
    fetchImpl: async () => new Response(body) }), /exceeds 1 MiB/);
  assert.equal(cancelled, true);
});

test('429 exposes only safe status and bounded Retry-After', async () => {
  for (const [retry, expected] of [['2', 2000], ['99999999', 86400000], ['invalid', undefined], [null, undefined]]) {
    await assert.rejects(fetchQuota(source('deepseek-balance'), { readCredential,
      fetchImpl: async () => new Response('secret', { status: 429, headers: retry === null ? {} : { 'retry-after': retry } }) }),
    error => error.status === 429 && error.retryAfterMs === expected && !error.message.includes('secret'));
  }
  const future = new Date(Date.now() + 60_000).toUTCString();
  await assert.rejects(fetchQuota(source('deepseek-balance'), { readCredential,
    fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': future } }) }),
  error => error.retryAfterMs > 58_000 && error.retryAfterMs <= 60_000);
});

test('AG falls back only on transport and selected endpoint failures', async () => {
  for (const status of ['transport', 404, 502, 503, 504, 401, 403, 429]) {
    const urls = [];
    const promise = fetchQuota({ ...source('antigravity'), url: 'https://evil.invalid/' }, {
      readCredential: async () => ({ access: 'fake' }),
      fetchImpl: async url => {
        urls.push(url);
        if (urls.length === 1) {
          if (status === 'transport') throw Error('private');
          return new Response('', { status });
        }
        return response({});
      },
    });
    if ([401, 403, 429].includes(status)) {
      await assert.rejects(promise, error => error.status === status);
      assert.equal(urls.length, 1);
    } else {
      assert.equal((await promise).status, 'unknown');
      assert.equal(urls.length, 2);
      assert.equal(new URL(urls[1]).origin, 'https://cloudcode-pa.googleapis.com');
    }
    assert.equal(new URL(urls[0]).origin, 'https://daily-cloudcode-pa.googleapis.com');
  }
});

test('oversized decimal and model identifiers are omitted rather than truncated', async () => {
  const balance = await fetchQuota(source('deepseek-balance'), { readCredential,
    fetchImpl: async () => response({ balance_infos: [{ currency: 'CNY', total_balance: '1'.repeat(129) }] }) });
  assert.equal(balance.status, 'unknown');
  const result = await fetchQuota(source('antigravity'), {
    readCredential: async () => ({ access: 'fake', projectId: 'fake-project' }),
    fetchImpl: async url => response(url.endsWith(':loadCodeAssist') ? {} : {
      models: { ['m'.repeat(257)]: { quotaInfo: { remainingFraction: 1 } } },
    }),
  });
  assert.equal(result.status, 'unknown');
});

test('unsupported sources never acquire credentials; pre-abort never fetches', async () => {
  const fail = () => { throw Error('must not execute'); };
  await assert.rejects(fetchQuota(source('http-json'), { readCredential: fail, fetchImpl: fail }), /Unsupported/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchQuota(source('deepseek-balance'), { signal: controller.signal, readCredential: fail, fetchImpl: fail }), { name: 'AbortError' });
});
