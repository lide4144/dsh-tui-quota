// Rendering is pure: unknown is never converted to zero, tokens to requests,
// or one model's quota to another model's quota.
const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 100);
export function countdown(resetAt, now = Date.now()) {
  const reset = Date.parse(resetAt);
  if (!Number.isFinite(reset) || reset <= now) return undefined;
  const minutes = Math.ceil((reset - now) / 60000);
  return minutes < 60 ? `${minutes}m` : minutes < 1440
    ? `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ''}`
    : `${Math.floor(minutes / 1440)}d`;
}
export function bar(fraction) {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * 5);
  return '▰'.repeat(filled) + '▱'.repeat(5 - filled);
}
export function currentWindows(snapshot, model) {
  return (snapshot?.windows || []).filter(window => window.modelIds?.includes(model));
}
export function footer(snapshot, route, now = Date.now()) {
  if (!snapshot || !route) return { text: '额度未知', tone: 'dim' };
  const stale = snapshot.stale ? '~' : '';
  const cooling = countdown(snapshot.cooldownUntil, now);
  if (snapshot.status === 'rate-limited') return { text: cooling ? `查询限流 ${cooling}` : '额度查询限流', tone: 'warning' };
  if (snapshot.status === 'needs_auth') return { text: '额度需登录', tone: 'dim' };
  if (snapshot.kind === 'balance' && snapshot.balances?.length) {
    const item = snapshot.balances[0];
    const symbol = item.currency === 'CNY' ? '¥' : item.currency === 'USD' ? '$' : clean(item.currency);
    return { text: `${stale}${symbol}${clean(item.available)}`, tone: stale ? 'dim' : 'accent' };
  }
  const matches = currentWindows(snapshot, route.model);
  if (!matches.length) return { text: '额度未知', tone: 'dim' };
  // Show the tightest disclosed window for this exact model, not an invented pool.
  const window = matches.reduce((a, b) => a.remainingFraction <= b.remainingFraction ? a : b);
  const fraction = window.remainingFraction;
  const reset = countdown(window.resetAt, now);
  // Once reset time has passed, old fractions cannot be presented as live.
  const expired = window.resetAt && Date.parse(window.resetAt) <= now;
  if (expired) return { text: '额度待刷新', tone: 'dim' };
  return { text: `${stale}${bar(fraction)} ${Math.round(fraction * 100)}%${reset ? ` (${reset})` : ''}`,
    tone: stale ? 'dim' : fraction <= 0 ? 'error' : fraction < 0.3 ? 'warning' : 'accent' };
}
export function details(snapshots, now = Date.now()) {
  if (!snapshots.length) return '尚无额度数据；用 /quota refresh 刷新。仅显示已配置的数据源。';
  return snapshots.map(snapshot => {
    const lines = [`${clean(snapshot.provider)} · ${clean(snapshot.status)}${snapshot.stale ? ' · 缓存/上次成功' : ''}`];
    if (snapshot.fetchedAt) lines.push(`  数据时间：${clean(snapshot.fetchedAt)}`);
    for (const balance of snapshot.balances || []) lines.push(`  ${clean(balance.currency)} ${clean(balance.available)}`);
    for (const window of snapshot.windows || []) {
      const reset = countdown(window.resetAt, now);
      const expired = window.resetAt && Date.parse(window.resetAt) <= now;
      lines.push(`  ${clean(window.label)} · ${expired ? '重置时间已过，待刷新（旧值非当前额度）' : `剩余 ${Math.round(window.remainingFraction * 100)}%`}${reset ? ` · ${reset} 后重置` : ''}`);
    }
    if (snapshot.status === 'rate-limited') lines.push(`  额度查询限流${countdown(snapshot.cooldownUntil, now) ? `，${countdown(snapshot.cooldownUntil, now)} 后可重试` : '，未披露重试时间'}；不代表生成请求被限流。`);
    if (snapshot.status === 'unknown') lines.push('  上游未披露可用额度；不是零额度。');
    if (snapshot.stale) lines.push('  最近查询失败；旧值不代表当前可用额度。');
    return lines.join('\n');
  }).join('\n\n');
}
