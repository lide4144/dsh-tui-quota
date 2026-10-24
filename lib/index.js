import { QuotaMonitor } from './monitor.js';
import { createCredentialReader } from './credentials.js';
import { footer, details } from './format.js';
import { SOURCE_KINDS } from './sources.js';

export const name = 'dsh-tui-quota';
export const inject = ['tuiStatus', 'commands', 'sessionProjections', 'agents'];
// Defaults target stock route ids: dsh-tui `/auth` (openai-codex, anthropic),
// the Antigravity companion, and API-key routes with explicit credential refs.
export const DEFAULT_SOURCES = [
  { provider: 'antigravity', kind: 'antigravity' },
  { provider: 'openai-codex', kind: 'codex-subscription' },
  { provider: 'anthropic', kind: 'claude-subscription' },
  { provider: 'kimi-coding', kind: 'kimi-code', keyEnv: 'KIMI_CODING_API_KEY' },
  { provider: 'deepseek', kind: 'deepseek-balance', keyEnv: 'DEEPSEEK_API_KEY', routes: ['deepseek-official'] },
];
const KEY_KINDS = new Set(['deepseek-balance', 'moonshot-balance', 'kimi-code']);
const ROUTE_ID = /^[a-zA-Z0-9_.-]{1,64}$/;
export function normalizeConfig(config = {}) {
  const sources = config.sources ?? DEFAULT_SOURCES;
  if (!Array.isArray(sources) || sources.length > 8) throw new Error('quota.sources must be an array of at most eight sources');
  const routes = new Set();
  for (const source of sources) {
    const ids = [source?.provider, ...(Array.isArray(source?.routes) ? source.routes : [])];
    if (!source || !SOURCE_KINDS.includes(source.kind) || (source.routes !== undefined && !Array.isArray(source.routes))
      || ids.length > 9 || ids.some(id => typeof id !== 'string' || !ROUTE_ID.test(id) || routes.has(id))) {
      throw new Error('Invalid or duplicate quota source');
    }
    if (KEY_KINDS.has(source.kind) && (typeof source.keyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,99}$/.test(source.keyEnv))) {
      throw new Error('API-key sources require an explicit keyEnv credential reference');
    }
    if (source.apiKey || source.token || source.url) throw new Error('Quota config accepts no inline token or custom URL');
    for (const id of ids) routes.add(id);
  }
  return { sources, refreshMs: Math.min(3600000, Math.max(60000, Number(config.refreshMs) || 300000)) };
}
export function apply(ctx, config = {}) {
  const { sources, refreshMs } = normalizeConfig(config);
  const sourceFor = provider => sources.find(source => source.provider === provider || source.routes?.includes(provider));
  let disposed = false;
  let sessionId;
  let route;
  let releaseField = () => {};
  const cleanups = [];
  // Resolved lazily: the credential service is optional and may mount late.
  const credentials = { resolve: ref => ctx.get?.('credentials')?.resolve(ref) };
  const monitor = new QuotaMonitor(sources, {
    readCredential: createCredentialReader({ credentials }), onChange: render, cacheMs: refreshMs,
  });
  function show(text, tone, detail) {
    const old = releaseField;
    releaseField = ctx.tuiStatus.setField('quota:current', text, { slot: 'left-tail', tone, maxCells: 32, detail }, ctx);
    old();
  }
  function render() {
    if (disposed) return;
    if (!route) return show('额度 · /quota', 'dim', '用 /quota 绑定当前会话；不猜测其他会话的模型。');
    const source = sourceFor(route.provider);
    if (!source) return show('额度未配置', 'dim', `${route.provider} 尚未配置额度来源；/quota 查看说明。`);
    const view = footer(monitor.get(source.provider), route);
    show(view.text, view.tone, `${route.provider} · 账户额度查询，非本次 token 用量 · /quota 查看数据时间与详情`);
  }
  const pick = value => value?.provider && value?.model
    ? { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: String(value.reasoningEffort) } : {}) }
    : undefined;
  // dsh-tui keeps `/model` choices in memory and rewrites the route inside the
  // agent's own `agent/request` waterfall, so the durable projection can lag.
  // The session request header records the route the last request actually used.
  function fromAgent(agent) {
    if (!agent?.session) return undefined;
    let header;
    try { header = agent.session.requestHeader?.()?.config; } catch { /* older hosts */ }
    let projection;
    try { projection = ctx.sessionProjections.snapshot(agent.session, ['modelSelection']).values.modelSelection; } catch { /* absent */ }
    return pick(header) || pick(projection?.next) || pick(projection?.lastUsed) || pick(agent.options);
  }
  // Usage only moves when a model is used: refresh the active source shortly
  // after each request instead of polling aggressively.
  const AUTO_DELAY_MS = 20000; const AUTO_MIN_GAP_MS = 30000;
  const autoTimers = new Map(); const lastAuto = new Map();
  function scheduleRefresh(provider) {
    const source = sourceFor(provider);
    if (!source || disposed) return;
    clearTimeout(autoTimers.get(source.provider));
    const timer = setTimeout(() => {
      autoTimers.delete(source.provider);
      if (disposed || Date.now() - (lastAuto.get(source.provider) ?? 0) < AUTO_MIN_GAP_MS) return;
      lastAuto.set(source.provider, Date.now());
      void monitor.refresh(source.provider, { force: true });
    }, AUTO_DELAY_MS);
    timer.unref?.();
    autoTimers.set(source.provider, timer);
  }
  function setRoute(value) { route = pick(value); render(); }
  cleanups.push(ctx.commands.register({
    name: 'quota', description: '当前额度、全部详情与只读刷新', recordInput: false,
    handler: async invocation => {
      const verb = invocation.rawInput.trim();
      if (!['', 'all', 'refresh'].includes(verb)) return { kind: 'error', text: '用法：/quota [all|refresh]' };
      const invocationRoute = fromAgent(invocation.agent);
      const source = invocationRoute && sourceFor(invocationRoute.provider);
      sessionId = invocation.agent.session.id;
      setRoute(invocationRoute);
      if (verb === 'refresh') await monitor.refreshAll({ force: true });
      else if (verb === 'all') await monitor.refreshAll();
      else if (source) await monitor.refresh(source.provider);
      invocation.signal?.throwIfAborted();
      if (verb === '' && invocationRoute && !source) {
        return { kind: 'success', text: `当前路由：${invocationRoute.provider}/${invocationRoute.model}\n尚未为该路由配置额度来源。已配置：${sources.map(item => item.provider).join('、') || '无'}。\n若这是同一订阅的别名路由，在 tui-quota 配置的对应 source 中加入 routes: [${invocationRoute.provider}]。` };
      }
      return { kind: 'success', text: details(verb === 'all' || verb === 'refresh'
        ? monitor.snapshots() : source ? [monitor.get(source.provider)].filter(Boolean) : []) };
    },
  }));
  cleanups.push(ctx.on('tui/session-switched', event => {
    sessionId = event.sessionId;
    setRoute(fromAgent(ctx.agents.get(sessionId)));
  }));
  // Only an explicit pending choice; `lastUsed` may predate an in-memory TUI switch.
  cleanups.push(ctx.sessionProjections.onChanged((session, key, value) => {
    if (session.id === sessionId && key === 'modelSelection' && pick(value?.next)) setRoute(value.next);
  }));
  // Outermost (prepend) so `next()` already includes the TUI's own route rewrite.
  // Observes only; the returned config is passed through unchanged.
  cleanups.push(ctx.on('agent/request', async (payload, next) => {
    const call = await next();
    if (!disposed && payload.agent.session.id === sessionId) {
      setRoute(call);
      scheduleRefresh(call?.provider);
    }
    return call;
  }, { prepend: true }));
  render();
  // Detached I/O: apply never awaits a network call or blocks first paint.
  void monitor.refreshAll();
  const refreshTimer = setInterval(() => { void monitor.refreshAll(); }, refreshMs);
  const renderTimer = setInterval(render, 60000);
  refreshTimer.unref?.(); renderTimer.unref?.();
  return () => {
    disposed = true;
    clearInterval(refreshTimer); clearInterval(renderTimer);
    for (const timer of autoTimers.values()) clearTimeout(timer);
    monitor.close();
    releaseField();
    for (const cleanup of cleanups.reverse()) cleanup?.();
  };
}
