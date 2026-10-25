// Read-only subscription usage parsers. All three endpoints are private /
// undocumented and may change; unknown shapes yield no windows (never zero).
// Codex:  https://github.com/V1ki/dsh-plugin-subscriptions/blob/a5b01068b7f0c0cdb6f38bafe700c345fdfee4ba/src/providers/codex.ts
// Claude: https://github.com/V1ki/dsh-plugin-subscriptions/blob/a5b01068b7f0c0cdb6f38bafe700c345fdfee4ba/src/providers/claude.ts
// Kimi:   https://github.com/PowerUserZ/OpenTokenUsage/blob/main/docs/providers/kimi.md

const HOUR = 3600;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const isoFromSeconds = value => finite(value) && value > 0 ? new Date(value * 1000).toISOString() : undefined;
const iso = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
  ? new Date(Date.parse(value)).toISOString() : undefined;
const headerSafe = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n]/.test(value);
const fromUsedPercent = used => finite(used) && used >= 0 && used <= 100
  ? Math.round((1 - used / 100) * 1e6) / 1e6 : undefined;

function durationLabel(seconds, fallback) {
  if (!finite(seconds) || seconds <= 0) return fallback;
  if (Math.abs(seconds - 5 * HOUR) <= 0.05 * 5 * HOUR) return '5h';
  if (Math.abs(seconds - 7 * 24 * HOUR) <= 0.05 * 7 * 24 * HOUR) return '7d';
  if (seconds % (24 * HOUR) === 0) return `${seconds / (24 * HOUR)}d`;
  if (seconds % HOUR === 0) return `${seconds / HOUR}h`;
  return `${Math.round(seconds / 60)}m`;
}

/** Codex account id: stored field first, else the access-token JWT claim. */
export function codexAccountId(credential) {
  if (headerSafe(credential?.accountId)) return credential.accountId;
  try {
    const payload = JSON.parse(Buffer.from(String(credential?.access).split('.')[1], 'base64url').toString('utf8'));
    const id = payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
    return headerSafe(id) ? id : undefined;
  } catch { return undefined; }
}

export const SUBSCRIPTION_REQUESTS = {
  'codex-subscription': credential => {
    const accountId = codexAccountId(credential);
    if (!accountId) throw Object.assign(new Error('Codex account id unavailable'), { code: 'NEEDS_AUTH' });
    return { url: 'https://chatgpt.com/backend-api/wham/usage',
      headers: { 'chatgpt-account-id': accountId, originator: 'codex_cli_rs' } };
  },
  'claude-subscription': () => ({ url: 'https://api.anthropic.com/api/oauth/usage',
    headers: { 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'claude-cli/2.1.283 (external, cli)' } }),
  'kimi-code': () => ({ url: 'https://api.kimi.com/coding/v1/usages', headers: {} }),
};

function codex(data) {
  const windows = [];
  for (const [slot, fallback] of [['primary_window', 'primary'], ['secondary_window', 'secondary']]) {
    const raw = data?.rate_limit?.[slot];
    const fraction = fromUsedPercent(raw?.used_percent);
    if (fraction === undefined) continue;
    const resetAt = isoFromSeconds(raw.reset_at)
      ?? (finite(raw.reset_after_seconds) && raw.reset_after_seconds > 0
        ? new Date(Date.now() + raw.reset_after_seconds * 1000).toISOString() : undefined);
    const label = durationLabel(raw.limit_window_seconds, fallback);
    windows.push({ id: `codex:${slot}`, label: `Codex ${label}`, remainingFraction: fraction,
      scope: 'account', ...(resetAt ? { resetAt } : {}),
      ...(finite(raw.limit_window_seconds) && raw.limit_window_seconds > 0 ? { windowMs: raw.limit_window_seconds * 1000 } : {}) });
  }
  return windows;
}

const WINDOW_MS = { '5h': 5 * HOUR * 1000, '7d': 7 * 24 * HOUR * 1000 };
const CLAUDE_KIND = { session: '5h', weekly_all: '7d', weekly_scoped: '7d' };
function claudeFamily(name) {
  const match = typeof name === 'string' && /\b(opus|sonnet|haiku|fable)\b/i.exec(name);
  return match ? match[1].toLowerCase() : undefined;
}
function claude(data) {
  const windows = [];
  if (Array.isArray(data?.limits)) data.limits.forEach((entry, index) => {
    const fraction = fromUsedPercent(entry?.percent);
    if (fraction === undefined) return;
    const scopeName = entry.scope?.model?.display_name;
    const family = claudeFamily(scopeName);
    // A scoped limit whose model family cannot be identified must not apply to every model.
    if (scopeName !== undefined && !family) return;
    const resetAt = iso(entry.resets_at);
    windows.push({ id: `claude:limit:${index}`, label: `Claude ${CLAUDE_KIND[entry.kind] ?? 'limit'}${family ? ` ${family}` : ''}`,
      remainingFraction: fraction, ...(family ? { scope: 'model-family', family } : { scope: 'account' }),
      ...(resetAt ? { resetAt } : {}), ...(WINDOW_MS[CLAUDE_KIND[entry.kind]] ? { windowMs: WINDOW_MS[CLAUDE_KIND[entry.kind]] } : {}) });
  });
  if (windows.length) return windows;
  for (const [key, label, family] of [['five_hour', '5h'], ['seven_day', '7d'],
    ['seven_day_opus', '7d', 'opus'], ['seven_day_sonnet', '7d', 'sonnet']]) {
    const fraction = fromUsedPercent(data?.[key]?.utilization);
    if (fraction === undefined) continue;
    const resetAt = iso(data[key].resets_at);
    windows.push({ id: `claude:${key}`, label: `Claude ${label}${family ? ` ${family}` : ''}`, remainingFraction: fraction,
      ...(family ? { scope: 'model-family', family } : { scope: 'account' }), ...(resetAt ? { resetAt } : {}),
      windowMs: WINDOW_MS[label] });
  }
  return windows;
}

const count = value => {
  const number = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
};
const UNIT_SECONDS = { TIME_UNIT_SECOND: 1, TIME_UNIT_MINUTE: 60, TIME_UNIT_HOUR: HOUR, TIME_UNIT_DAY: 24 * HOUR };
function kimiWindow(detail, id, label, windowMs) {
  const limit = count(detail?.limit); const remaining = count(detail?.remaining);
  if (!limit || remaining === undefined || remaining > limit) return undefined;
  const resetAt = iso(detail.resetTime);
  return { id, label, remainingFraction: remaining / limit, remaining, limit, scope: 'account', ...(resetAt ? { resetAt } : {}), ...(windowMs ? { windowMs } : {}) };
}
function kimi(data) {
  const windows = [];
  if (Array.isArray(data?.limits)) data.limits.forEach((entry, index) => {
    const unit = UNIT_SECONDS[entry?.window?.timeUnit];
    const duration = count(entry?.window?.duration);
    const label = unit && duration ? durationLabel(duration * unit, 'window') : 'window';
    const window = kimiWindow(entry?.detail, `kimi:limit:${index}`, `Kimi Code ${label}`, unit && duration ? duration * unit * 1000 : undefined);
    if (window) windows.push(window);
  });
  // The aggregate period is undisclosed; do not name it weekly/monthly.
  const total = kimiWindow(data?.usage, 'kimi:usage', 'Kimi Code 周期总量');
  if (total) windows.push(total);
  return windows;
}

export const SUBSCRIPTION_PARSERS = {
  'codex-subscription': codex,
  'claude-subscription': claude,
  'kimi-code': kimi,
};
