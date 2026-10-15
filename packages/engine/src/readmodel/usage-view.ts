import {
  costLabel,
  describe,
  isStale,
  LOGIN_LABELS,
  percent,
  snapshotAge,
  WINDOW_LABELS,
  windowLabel,
  worstStatus,
  type LoginKind,
  type Meter,
  type RateLimitSnapshot,
  type UsageView,
} from '@advpipe/contracts';
import { likelyConsole, loadCache } from '../core/usage.js';

// The login and usage line next to the budget (docs/05 §5.1, §5.2.3). Claude reports usage only
// when it changes, so everything here is "last known, with its age", never a live gauge.
// Port of `ui/usage_view.py` (the repo-wide form; the per-run form arrives with M8).

function meters(windows: Readonly<Record<string, RateLimitSnapshot>>, now: Date): Meter[] {
  const order = Object.keys(WINDOW_LABELS);
  const rank = (w: string): number => (order.includes(w) ? order.indexOf(w) : order.length);
  return Object.keys(windows)
    .sort((a, b) => rank(a) - rank(b))
    .map((window) => {
      const snap = windows[window] as RateLimitSnapshot;
      const stale = isStale(snap, now);
      return {
        window,
        label: windowLabel(window),
        percent: stale ? null : percent(snap),
        text: describe(snap, now).split(': ').slice(1).join(': '),
        status: stale ? 'allowed' : snap.status,
        stale,
        seen: snapshotAge(snap, now),
      };
    });
}

export function buildUsageView(
  login: LoginKind,
  windows: Readonly<Record<string, RateLimitSnapshot>>,
  console: boolean,
  now: Date,
): UsageView {
  const warn =
    {
      rejected: 'A usage limit is reached: a run started now will pause until it resets.',
      allowed_warning: 'A usage window is nearly used up: a long run may pause at its limit.',
      allowed: '',
    }[worstStatus(windows, now)] ?? '';
  const isConsole = login === 'console' || console;
  return {
    login,
    login_label: LOGIN_LABELS[login],
    cost_label: costLabel(isConsole ? 'console' : login),
    console: isConsole,
    warn,
    note: isConsole
      ? 'Console credits have no usage windows: every call is billed.'
      : 'Not known yet: advpipe sees usage only when Claude reports a change.',
    meters: meters(windows, now),
  };
}

/** From the repo-wide cache: the last known login and usage, whatever run saw them. */
export function loadUsage(repo: string, now: Date = new Date()): UsageView {
  const cache = loadCache(repo);
  const console = cache.login === 'console' || (cache.login === 'unknown' && likelyConsole(repo));
  const login: LoginKind = console && cache.login === 'unknown' ? 'console' : cache.login;
  return buildUsageView(login, cache.windows, console, now);
}
