import { QuotaMonitor } from './monitor.js';
import { createCredentialReader } from './credentials.js';
import { footer, details, currentWindows, countdown } from './format.js';
import { QuotaAlerts } from './warnings.js';
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
  return { sources, refreshMs: Math.min(3600000, Math.max(60000, Number(config.refreshMs) || 300000)),
    warnings: config.warnings !== false };
}
export function apply(ctx, config = {}) {
  const { sources, refreshMs, warnings } = normalizeConfig(config);
  const sourceFor = provider => sources.find(source => source.provider === provider || source.routes?.includes(provider));
  let disposed = false;
  let sessionId;
  let route;
  let releaseField = () => {};
  const cleanups = [];
  // Resolved lazily: the credential service is optional and may mount late.
  const credentials = { resolve: ref => ctx.get?.('credentials')?.resolve(ref) };
  const monitor = new QuotaMonitor(sources, {
    readCredential: createCredentialReader({ credentials }), onChange: () => { render(); alert(); }, cacheMs: refreshMs,
  });
  const alerts = new QuotaAlerts();
  const SEVERITY_TEXT = { warning: '偏快', high: '告急', critical: '耗尽' };
  // Toast only for the bound route's own windows, and only on escalation or after a cooldown.
  function alert() {
    if (disposed || !warnings || !route) return;
    let toast;
    try { toast = ctx.get?.('tuiToast'); } catch { /* optional service */ }
    if (typeof toast?.show !== 'function') return;
    const source = sourceFor(route.provider);
    const snapshot = source && monitor.get(source.provider);
    if (!snapshot || snapshot.stale || snapshot.status !== 'ok') return;
    const hits = alerts.check(source.provider, currentWindows(snapshot, route));
    if (!hits.length) return;
    const worst = hits.some(hit => hit.severity !== 'warning') ? 'error' : 'warning';
    const text = hits.slice(0, 3).map(({ window, severity, used, projected }) => {
      const reset = countdown(window.resetAt);
      const pace = projected !== undefined && projected > used + 1 ? `，按当前速度预计 ${Math.round(Math.min(projected, 999))}%` : '';
      return `${String(window.label).slice(0, 40)} 已用 ${Math.round(used)}%${pace}（${SEVERITY_TEXT[severity]}）${reset ? `，${reset} 后重置` : ''}`;
    }).join('；');
    try { toast.show(`额度提醒：${text}`, { color: worst, timeoutMs: 10000 }); } catch { /* best effort */ }
  }
  function show(text, tone, detail) {
    const old = releaseField;
    releaseField = ctx.tuiStatus.setField('quota:current', text, { slot: 'left-tail', tone, maxCells: 32, detail }, ctx);
    old();
  }
  function render() {
    if (disposed) return;
    if (!route) return show('额度 · 待首次请求', 'dim', '发出第一条消息后自动跟随当前会话；也可用 /quota 立即绑定。');
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
  // Usage only moves when a model is used. While the session is active, refresh
  // the bound source ~20s after each request and at least once per gap; idle
  // sessions fall back to the slow background interval. Claude's usage
  // endpoint rate-limits aggressively, so it gets a longer gap (as pi-quotas).
  const AUTO_DELAY_MS = 20000; const ACTIVE_WINDOW_MS = 10 * 60000;
  const gapFor = source => source.kind === 'claude-subscription' ? 300000 : 60000;
  const autoTimers = new Map(); const lastAuto = new Map();
  let lastActivity = 0;
  function scheduleRefresh(provider) {
    const source = sourceFor(provider);
    if (!source || disposed || autoTimers.has(source.provider)) return;
    const due = Math.max(Date.now() + AUTO_DELAY_MS, (lastAuto.get(source.provider) ?? 0) + gapFor(source));
    const timer = setTimeout(() => {
      autoTimers.delete(source.provider);
      if (disposed) return;
      lastAuto.set(source.provider, Date.now());
      void monitor.refresh(source.provider, { force: true });
    }, due - Date.now());
    timer.unref?.();
    autoTimers.set(source.provider, timer);
  }
  // Subagent children run their own requests; only a top-level session can be the one on screen.
  function topLevel(agent) {
    try {
      const header = agent?.session?.header;
      return !(header?.origin === 'subagent' || header?.delegationDepth > 0);
    } catch { return false; }
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
  // Note: dsh-tui only delivers tui/* events to Components declaring
  // DecisionEvents; for plain plugins this is a harmless no-op, and binding
  // falls back to following top-level requests below.
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
    try {
      const id = payload.agent?.session?.id;
      // Follow the latest top-level session: dsh-tui exposes no "live session"
      // signal to plain plugins, so a request is the only reliable cue.
      if (!disposed && id && (id === sessionId || topLevel(payload.agent))) {
        if (id !== sessionId) alerts.clear();
        sessionId = id;
        lastActivity = Date.now();
        setRoute(call);
        scheduleRefresh(call?.provider);
      }
    } catch { /* observing must never break a request */ }
    return call;
  }, { prepend: true }));
  render();
  // Detached I/O: apply never awaits a network call or blocks first paint.
  void monitor.refreshAll();
  const refreshTimer = setInterval(() => { void monitor.refreshAll(); }, refreshMs);
  const renderTimer = setInterval(() => {
    render();
    if (route && Date.now() - lastActivity < ACTIVE_WINDOW_MS) scheduleRefresh(route.provider);
  }, 60000);
  refreshTimer.unref?.(); renderTimer.unref?.();
  return () => {
    disposed = true;
    clearInterval(refreshTimer); clearInterval(renderTimer);
    for (const timer of autoTimers.values()) clearTimeout(timer);
    autoTimers.clear();
    monitor.close();
    releaseField();
    for (const cleanup of cleanups.reverse()) cleanup?.();
  };
}
