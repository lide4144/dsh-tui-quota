// Sources: https://api-docs.deepseek.com/api/get-user-balance/
// https://platform.kimi.com/docs/api/balance.md
// Undocumented AG contract (not a stable Google API):
// https://github.com/V1ki/dsh-plugin-subscriptions/blob/a5b01068b7f0c0cdb6f38bafe700c345fdfee4ba/src/providers/antigravity.ts
const AG_ORIGIN = 'https://daily-cloudcode-pa.googleapis.com';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const decimal = value => (typeof value === 'string' && value.length <= 128 && /^-?\d+(?:\.\d+)?$/.test(value))
  ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;

/** Read-only, explicit-source fetcher. Credentials are supplied by the caller, never disk. */
export async function fetchQuota(source, { fetchImpl = fetch, signal, readCredential } = {}) {
  if (!['antigravity', 'deepseek-balance', 'moonshot-balance'].includes(source.kind)) {
    throw new Error('Unsupported quota source');
  }
  signal?.throwIfAborted();
  const credential = await readCredential(source);
  const token = source.kind === 'antigravity' ? credential?.access : credential;
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
    throw new Error('Quota credential unavailable');
  }
  async function request(url, body) {
    const endpoints = source.kind === 'antigravity'
      ? [url, url.replace(AG_ORIGIN, 'https://cloudcode-pa.googleapis.com')] : [url];
    let response;
    for (const [index, endpoint] of endpoints.entries()) {
      signal?.throwIfAborted();
      try {
        response = await fetchImpl(endpoint, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json',
            ...(source.kind === 'antigravity' ? { 'user-agent': 'antigravity/1.104.0 dsh-tui-quota' } : {}),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          redirect: 'error', signal,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        signal?.throwIfAborted();
        if (index < endpoints.length - 1) continue;
        throw new Error('Quota network request failed');
      }
      if (index < endpoints.length - 1 && [404, 502, 503, 504].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        continue;
      }
      break;
    }
    if (!response.ok) {
      const error = new Error(`Quota HTTP ${response.status}`);
      error.status = response.status;
      if (response.status === 429) {
        const retry = response.headers?.get('retry-after');
        if (typeof retry === 'string' && retry.length <= 128) {
          const milliseconds = /^\d+(?:\.\d+)?$/.test(retry.trim())
            ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
          if (Number.isFinite(milliseconds)) error.retryAfterMs = Math.max(0, Math.min(86_400_000, milliseconds));
        }
      }
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    // Count bytes while streaming; never buffer an unbounded response via json().
    if (!response.body?.getReader) throw new Error('Invalid quota response stream');
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_048_576) {
          await reader.cancel().catch(() => {});
          throw new Error('Quota response exceeds 1 MiB');
        }
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      signal?.throwIfAborted();
      if (error.message === 'Quota response exceeds 1 MiB') throw error;
      throw new Error('Quota response read failed');
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new Error('Invalid quota JSON'); }
  }
  const base = { provider: source.provider, kind: source.kind === 'antigravity' ? 'windows' : 'balance',
    fetchedAt: new Date().toISOString(), status: 'unknown' };
  if (source.kind === 'deepseek-balance') {
    const data = await request('https://api.deepseek.com/user/balance');
    const rows = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
    const balances = rows.flatMap(row => {
      const available = decimal(row?.total_balance);
      return available !== undefined && ['CNY', 'USD'].includes(row?.currency)
        ? [{ currency: row.currency, available }] : [];
    });
    return { ...base, status: balances.length ? 'ok' : 'unknown', balances };
  }
  if (source.kind === 'moonshot-balance') {
    const data = await request('https://api.moonshot.cn/v1/users/me/balance');
    const available = decimal(data?.data?.available_balance);
    // Do not recompute: cash can be negative while available equals voucher.
    return data?.code === 0 && data?.status === true && available !== undefined
      ? { ...base, status: 'ok', balances: [{ currency: 'CNY', available }] } : { ...base, balances: [] };
  }
  // Never call discovery helpers: those may silently onboard accounts.
  const account = await request(`${AG_ORIGIN}/v1internal:loadCodeAssist`, {
    metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
  });
  const discovered = account?.cloudaicompanionProject;
  const projectId = credential?.projectId ?? (typeof discovered === 'string' ? discovered : discovered?.id);
  if (typeof projectId !== 'string' || !projectId.trim()) return { ...base, windows: [] };
  const data = await request(`${AG_ORIGIN}/v1internal:fetchAvailableModels`, { project: projectId });
  const windows = [];
  if (object(data?.models)) for (const [modelId, model] of Object.entries(data.models)) {
    if (!object(model) || modelId.length === 0 || modelId.length > 256) continue;
    for (const [kind, quota] of [['ordinary', model.quotaInfo], ['weekly', model.weeklyQuotaInfo ?? model.weeklyQuota]]) {
      const fraction = quota?.remainingFraction;
      if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      // Preserve model identity; identical fractions/reset times do not prove a shared pool.
      windows.push({ id: `${modelId}:${kind}`, label: `${modelId} (${kind})`,
        remainingFraction: fraction, modelIds: [modelId],
        ...(date(quota.resetTime) === undefined ? {} : { resetAt: date(quota.resetTime) }) });
    }
  }
  return { ...base, status: windows.length ? 'ok' : 'unknown', windows };
}
