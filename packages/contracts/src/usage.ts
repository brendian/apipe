import type { LoginKind } from './primitives.js';
import type { RateLimitSnapshot } from './runstate.js';

// What to say about logins, usage windows and limits (docs/02 §14). Pure wording, shared by the
// engine (run notes, decisions, report) and the UI. Everything here is "last known, with its age",
// never a live gauge: Claude reports usage only when a status changes.

/** Fixed links for the "add usage or credits" step. Constants, never built from run data. */
export const ADD_USAGE_URL = 'https://claude.ai/settings/usage';
export const ADD_CREDITS_URL = 'https://platform.claude.com/settings/billing';

export const WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly (Opus)',
  seven_day_sonnet: 'weekly (Sonnet)',
  overage: 'extra usage',
};

/** Where the window's limit is explained to a person who hit it. */
export const WINDOW_NOUNS: Readonly<Record<string, string>> = {
  five_hour: '5-hour usage limit',
  seven_day: 'weekly usage limit',
  seven_day_opus: 'weekly Opus usage limit',
  seven_day_sonnet: 'weekly Sonnet usage limit',
  overage: 'extra-usage limit',
};

export const LOGIN_LABELS: Readonly<Record<LoginKind, string>> = {
  console: 'Anthropic Console credits (real money)',
  subscription: 'Claude subscription',
  unknown: 'not known yet',
};

const lookup = (table: Readonly<Record<string, string>>, key: string): string | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

export function windowLabel(window: string): string {
  return lookup(WINDOW_LABELS, window) ?? window.replaceAll('_', ' ');
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
const pad = (n: number): string => String(n).padStart(2, '0');

/** A date given as an ISO string or a Date (state files hold strings). */
const toDate = (when: string | Date): Date => (typeof when === 'string' ? new Date(when) : when);

/**
 * A reset time for a person, in the machine's local time: `14:00` today, `Mon 14:00` within the
 * week, else `Oct 21 14:00`.
 */
export function formatReset(when: string | Date, now: string | Date = new Date()): string {
  const at = toDate(when);
  const today = toDate(now);
  const days = Math.round(
    (Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) -
      Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) /
      86_400_000,
  );
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (days === 0) return time;
  if (days > 0 && days < 7) return `${WEEKDAYS[at.getDay()]} ${time}`;
  return `${MONTHS[at.getMonth()]} ${pad(at.getDate())} ${time}`;
}

/** The window has reset since the snapshot was taken, so its usage is unknown now. */
export function isStale(snap: RateLimitSnapshot, now: string | Date = new Date()): boolean {
  return snap.resets_at !== null && toDate(snap.resets_at) <= toDate(now);
}

/** How old a snapshot is: `just now`, `5 min ago`, `3 h ago`, `2 d ago`. */
export function snapshotAge(snap: RateLimitSnapshot, now: string | Date = new Date()): string {
  const seconds = Math.trunc((toDate(now).getTime() - toDate(snap.seen_at).getTime()) / 1000);
  if (seconds < 90) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

export function percent(snap: RateLimitSnapshot): number | null {
  return snap.utilization === null ? null : Math.round(snap.utilization * 100);
}

/** `5-hour: 62% used, resets 14:00` (or `5-hour: reset since; usage unknown`). */
export function describe(snap: RateLimitSnapshot, now: string | Date = new Date()): string {
  const label = windowLabel(snap.window);
  if (isStale(snap, now)) return `${label}: reset since; usage unknown`;
  const pct = percent(snap);
  const used =
    pct !== null
      ? `${pct}% used`
      : snap.status === 'rejected'
        ? 'limit reached'
        : 'no usage figure';
  const resets = snap.resets_at ? `, resets ${formatReset(snap.resets_at, now)}` : '';
  return `${label}: ${used}${resets}`;
}

export function describeAll(
  windows: Readonly<Record<string, RateLimitSnapshot>>,
  now: string | Date = new Date(),
): string[] {
  const order = Object.keys(WINDOW_LABELS);
  const rank = (w: string): number => (order.includes(w) ? order.indexOf(w) : order.length);
  return Object.keys(windows)
    .sort((a, b) => rank(a) - rank(b))
    .map((w) => describe(windows[w] as RateLimitSnapshot, now));
}

/** `rejected` or `allowed_warning` if a window that hasn't reset since says so, else `allowed`. */
export function worstStatus(
  windows: Readonly<Record<string, RateLimitSnapshot>>,
  now: string | Date = new Date(),
): RateLimitSnapshot['status'] {
  let worst: RateLimitSnapshot['status'] = 'allowed';
  for (const snap of Object.values(windows)) {
    if (isStale(snap, now)) continue;
    if (snap.status === 'rejected') return 'rejected';
    if (snap.status === 'allowed_warning') worst = 'allowed_warning';
  }
  return worst;
}

/** The plain-words explanation shown at a `usage_limit` decision point. */
export function limitExplanation(
  stage: string,
  snap: RateLimitSnapshot | null,
  billing: boolean,
): string {
  const tail =
    'Or finish the run as it is: the work so far stays in the worktree, uncommitted, for ' +
    'you to do with as you please.';
  if (billing) {
    return (
      `Your Anthropic Console credit balance ran out during the ${stage} step. Add ` +
      `credits (${ADD_CREDITS_URL}), then press Try again. ${tail}`
    );
  }
  if (snap !== null) {
    const noun = lookup(WINDOW_NOUNS, snap.window) ?? `${windowLabel(snap.window)} limit`;
    const reset = snap.resets_at ? ` It resets at ${formatReset(snap.resets_at)}.` : '';
    return (
      `Your Claude subscription's ${noun} was reached during the ${stage} step.${reset} ` +
      `Add extra usage to your plan (${ADD_USAGE_URL}), or wait for the reset, then press ` +
      `Try again. ${tail}`
    );
  }
  return (
    `Claude reported a usage limit during the ${stage} step (no details were given). If ` +
    `you're on a subscription, wait for the window to reset or add extra usage ` +
    `(${ADD_USAGE_URL}); with Console credits, check the balance (${ADD_CREDITS_URL}). Then ` +
    `press Try again. ${tail}`
  );
}

/** What *Try again* says about a limit that may still be in force. */
export function retryWarning(snap: RateLimitSnapshot | null): string {
  const base = 'If the limit is still in force, the run will pause again.';
  if (snap !== null && snap.resets_at !== null && !isStale(snap)) {
    return `${base} The limit resets at ${formatReset(snap.resets_at)}.`;
  }
  return base;
}

/**
 * The warning for a run that spends Console credits (real money). The original said "change it
 * with --budget"; there is no such command here, so it points at resuming (docs/02 §19).
 */
export function consoleWarning(budgetUsd: number, runs = 1): string {
  if (runs > 1) {
    return (
      `Warning: these ${runs} runs use Anthropic Console credits, which is real money. ` +
      `They can spend up to $${budgetUsd.toFixed(2)} in total (the budgets; change each when ` +
      'you resume the run).'
    );
  }
  return (
    'Warning: this run uses Anthropic Console credits, which is real money. It can spend up ' +
    `to $${budgetUsd.toFixed(2)} (the budget; change it when you resume the run).`
  );
}

/** How the dollar figures are labelled for this login. */
export function costLabel(auth: LoginKind): string {
  return {
    console: 'real money',
    subscription: 'API-equivalent, not billed',
    unknown: "API-equivalent if you're on a subscription",
  }[auth];
}
