import { QuotaMonitor } from './monitor.js';
import { createCredentialReader } from './credentials.js';
import { footer, details } from './format.js';

export const name = 'dsh-tui-quota';
export const inject = ['tuiStatus', 'commands', 'sessionProjections', 'agents'];
const DEFAULT_SOURCES = [{ provider: 'antigravity', kind: 'antigravity' }];
export function normalizeConfig(config = {}) {
  const sources = config.sources ?? DEFAULT_SOURCES;
  if (!Array.isArray(sources) || sources.length > 5) throw new Error('quota.sources must be an array of at most five sources');
  const providers = new Set();
  for (const source of sources) {
    if (!source || !['antigravity', 'deepseek-balance', 'moonshot-balance'].includes(source.kind)
      || typeof source.provider !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(source.provider)
      || providers.has(source.provider)) throw new Error('Invalid or duplicate quota source');
    if (source.kind !== 'antigravity' && (typeof source.keyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,99}$/.test(source.keyEnv))) {
      throw new Error('Balance sources require an explicit keyEnv');
    }
    if (source.apiKey || source.token || source.url) throw new Error('Quota config accepts no inline token or custom URL');
    providers.add(source.provider);
  }
  return { sources, refreshMs: Math.min(3600000, Math.max(60000, Number(config.refreshMs) || 300000)) };
}
export function apply(ctx, config = {}) {
  const { sources, refreshMs } = normalizeConfig(config);
  let disposed = false;
  let sessionId;
  let route;
  let releaseField = () => {};
  const cleanups = [];
  const monitor = new QuotaMonitor(sources, {
    readCredential: createCredentialReader(), onChange: render, cacheMs: refreshMs,
  });
  function render() {
    if (disposed) return;
    if (!route) {
      const old = releaseField;
      releaseField = ctx.tuiStatus.setField('quota:current', '额度 · /quota', {
        slot: 'left-tail', tone: 'dim', maxCells: 32,
        detail: '用 /quota 绑定当前会话；不猜测其他会话的模型。',
      }, ctx);
      old();
      return;
    }
    if (!sources.some(source => source.provider === route.provider)) {
      releaseField(); releaseField = () => {}; return;
    }
    const snapshot = monitor.get(route.provider);
    const view = footer(snapshot, route);
    const old = releaseField;
    releaseField = ctx.tuiStatus.setField('quota:current', view.text, {
      slot: 'left-tail', tone: view.tone, maxCells: 32,
      detail: `${route.provider} · 账户额度查询，非本次 token 用量 · /quota 查看数据时间与详情`,
    }, ctx);
    old();
  }
  function fromAgent(agent) {
    if (!agent?.session) return undefined;
    try {
      const value = ctx.sessionProjections.snapshot(agent.session, ['modelSelection']).values.modelSelection;
      return value?.next || value?.lastUsed || (agent.options?.provider && agent.options?.model
        ? { provider: agent.options.provider, model: agent.options.model } : undefined);
    } catch { return undefined; }
  }
  function setRoute(value) {
    route = value?.provider && value?.model ? { provider: value.provider, model: value.model } : undefined;
    render();
  }
  cleanups.push(ctx.commands.register({
    name: 'quota', description: '当前额度、全部详情与只读刷新', recordInput: false,
    handler: async invocation => {
      const verb = invocation.rawInput.trim();
      if (!['', 'all', 'refresh'].includes(verb)) return { kind: 'error', text: '用法：/quota [all|refresh]' };
      const invocationRoute = fromAgent(invocation.agent);
      sessionId = invocation.agent.session.id;
      setRoute(invocationRoute);
      if (verb === 'refresh') await monitor.refreshAll({ force: true });
      else if (verb === 'all') await monitor.refreshAll();
      else if (invocationRoute) await monitor.refresh(invocationRoute.provider);
      invocation.signal?.throwIfAborted();
      return { kind: 'success', text: details(verb === 'all' || verb === 'refresh'
        ? monitor.snapshots() : invocationRoute ? [monitor.get(invocationRoute.provider)].filter(Boolean) : []) };
    },
  }));
  cleanups.push(ctx.on('tui/session-switched', event => {
    sessionId = event.sessionId;
    setRoute(fromAgent(ctx.agents.get(sessionId)));
  }));
  cleanups.push(ctx.sessionProjections.onChanged((session, key, value) => {
    if (session.id === sessionId && key === 'modelSelection') setRoute(value?.next || value?.lastUsed);
  }));
  // Observe the final request configuration without changing the routing chain.
  cleanups.push(ctx.on('agent/request', async (payload, next) => {
    const call = await next();
    if (!disposed && payload.agent.session.id === sessionId) setRoute(call);
    return call;
  }));
  render();
  // Detached I/O: apply never awaits a network call or blocks first paint.
  void monitor.refreshAll();
  const refreshTimer = setInterval(() => { void monitor.refreshAll(); }, refreshMs);
  const renderTimer = setInterval(render, 60000);
  refreshTimer.unref?.(); renderTimer.unref?.();
  return () => {
    disposed = true;
    clearInterval(refreshTimer); clearInterval(renderTimer);
    monitor.close();
    releaseField();
    for (const cleanup of cleanups.reverse()) cleanup?.();
  };
}
