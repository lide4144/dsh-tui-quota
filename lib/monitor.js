import { fetchQuota } from './sources.js';

export class QuotaMonitor {
  constructor(sources, { readCredential, fetchImpl, now = Date.now, onChange = () => {}, timeoutMs = 10000, cacheMs = 300000, minRefreshMs = 10000 } = {}) {
    this.sources = sources;
    this.readCredential = readCredential;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.onChange = onChange;
    this.timeoutMs = timeoutMs;
    this.cacheMs = cacheMs;
    this.minRefreshMs = minRefreshMs;
    this.lastAttempt = new Map();
    this.lastSuccess = new Map();
    this.values = new Map();
    this.inflight = new Map();
    this.retryAt = new Map();
    this.abort = new AbortController();
  }
  get(provider) { return this.values.get(provider); }
  snapshots() { return [...this.values.values()]; }
  refresh(provider, { force = false } = {}) {
    if (this.abort.signal.aborted) return Promise.resolve();
    const source = this.sources.find(item => item.provider === provider);
    if (!source) return Promise.resolve();
    if (this.inflight.has(provider)) return this.inflight.get(provider);
    if ((this.retryAt.get(provider) || 0) > this.now()) return Promise.resolve();
    if (this.lastAttempt.has(provider) && this.now() - this.lastAttempt.get(provider) < this.minRefreshMs) return Promise.resolve();
    if (!force && !this.values.get(provider)?.stale && this.lastSuccess.has(provider)
      && this.now() - this.lastSuccess.get(provider) < this.cacheMs) return Promise.resolve();
    this.lastAttempt.set(provider, this.now());
    const promise = this.fetchOne(source).finally(() => this.inflight.delete(provider));
    this.inflight.set(provider, promise);
    return promise;
  }
  async fetchOne(source) {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      const snapshot = await fetchQuota(source, { signal, readCredential: this.readCredential, fetchImpl: this.fetchImpl });
      if (this.abort.signal.aborted) return;
      this.values.set(source.provider, snapshot);
      this.lastSuccess.set(source.provider, this.now());
      this.retryAt.delete(source.provider);
    } catch (error) {
      if (this.abort.signal.aborted) return;
      const previous = this.values.get(source.provider);
      const limited = error.status === 429;
      // Local retry scheduling is not a claim about account or generation quota.
      const retryMs = limited && error.retryAfterMs > 0 ? error.retryAfterMs : 60000;
      this.retryAt.set(source.provider, this.now() + retryMs);
      this.values.set(source.provider, {
        ...(previous || { provider: source.provider }),
        status: limited ? 'rate-limited' : error.code === 'NEEDS_AUTH' || error.status === 401 ? 'needs_auth' : 'error',
        ...(previous ? { stale: true } : {}),
        ...(limited && error.retryAfterMs > 0 ? { cooldownUntil: new Date(this.now() + error.retryAfterMs).toISOString() } : {}),
      });
    }
    this.onChange();
  }
  async refreshAll(options) { await Promise.all(this.sources.map(source => this.refresh(source.provider, options))); }
  close() { this.abort.abort(); }
}
