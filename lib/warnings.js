// Pace-aware quota warnings, adapted from @latentminds/pi-quotas (MIT).
// A window is risky when its usage, extrapolated linearly to the reset time,
// would overshoot the limit. Thresholds relax early in a window (little data)
// and tighten toward the end. Without a known window length, fall back to
// absolute usage thresholds (80/90/100% used).
export const SEVERITIES = ['none', 'warning', 'high', 'critical'];
const rank = severity => SEVERITIES.indexOf(severity);
const MIN_PACE = 5;
const T = { floor: [33, 8], warn: [260, 120], high: [320, 145], critical: [400, 170] };
const lerp = ([start, end], p) => start + (end - start) * Math.max(0, Math.min(1, p));

function absolute(used) {
  return used >= 100 ? 'critical' : used >= 90 ? 'high' : used >= 80 ? 'warning' : 'none';
}

export function assess(window, now = Date.now()) {
  const fraction = window?.remainingFraction;
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return { severity: 'none' };
  const used = Math.max(0, Math.min(100, (1 - fraction) * 100));
  const reset = Date.parse(window.resetAt);
  // A window past its reset time holds stale data; never alert on it.
  if (Number.isFinite(reset) && reset <= now) return { severity: 'none', used };
  const base = absolute(used);
  if (!(window.windowMs > 0) || !Number.isFinite(reset)) return { severity: base, used, projected: used };
  const progress = Math.max(0, Math.min(1, 1 - (reset - now) / window.windowMs));
  const projected = used / Math.max(MIN_PACE, progress * 100) * 100;
  let severity = 'none';
  if (used >= lerp(T.floor, progress)) {
    if (projected >= lerp(T.critical, progress)) severity = 'critical';
    else if (projected >= lerp(T.high, progress)) severity = 'high';
    else if (projected >= lerp(T.warn, progress)) severity = 'warning';
  }
  return { severity: rank(severity) > rank(base) ? severity : base, used, projected };
}

const COOLDOWN = { warning: 60 * 60_000, high: 15 * 60_000, critical: 15 * 60_000 };

/** Remembers what was already shown so each window toasts on escalation or after a cooldown. */
export class QuotaAlerts {
  constructor() { this.state = new Map(); }
  check(key, windows, now = Date.now()) {
    const out = [];
    for (const window of windows) {
      const result = assess(window, now);
      const id = `${key}:${window.id ?? window.label}`;
      const previous = this.state.get(id);
      if (result.severity === 'none') { this.state.delete(id); continue; }
      const escalated = !previous || rank(result.severity) > rank(previous.severity);
      if (!escalated && now - previous.at < COOLDOWN[result.severity]) continue;
      this.state.set(id, { severity: result.severity, at: now });
      out.push({ window, ...result });
    }
    return out;
  }
  clear() { this.state.clear(); }
}
