import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type LoginKind, type RateLimitSnapshot, UsageCache } from '@advpipe/contracts';
import { writeFileAtomic } from './runlog.js';

// Which login the agents run under, and what Claude last said about usage windows (docs/02 §14,
// docs/06 §4/§6). advpipe never asks for, reads or stores a key or token: it keeps only what the
// SDK's stream reports. Wording lives in `@advpipe/contracts` (shared with the UI).

// Claude Code's `apiKeySource` values: where the credential used for requests came from. `oauth`
// is a `/login` with a Claude account (a subscription); the others are API keys, i.e. Console
// credits. `none` and `temporary` say nothing about which login it is, so they fall through.
const CONSOLE_KEY_SOURCES: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'apiKeyHelper',
  '/login managed key',
  'user',
  'project',
  'org',
]);
const SUBSCRIPTION_KEY_SOURCES: ReadonlySet<string> = new Set(['oauth']);

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Which login a call ran under, from the best evidence there is, in order: the init message's
 * `apiKeySource`; a rate-limit event arriving (those apply to subscription logins only);
 * `ANTHROPIC_API_KEY` set in the environment (Console). With none of those it is `unknown`,
 * never a guess: silence doesn't mean Console.
 */
export function detectLogin(
  apiKeySource: unknown,
  sawRateLimitEvent: boolean,
  env: Env = process.env,
): LoginKind {
  if (typeof apiKeySource === 'string') {
    if (CONSOLE_KEY_SOURCES.has(apiKeySource)) return 'console';
    if (SUBSCRIPTION_KEY_SOURCES.has(apiKeySource)) return 'subscription';
  }
  if (sawRateLimitEvent) return 'subscription';
  if (env['ANTHROPIC_API_KEY']) return 'console';
  return 'unknown';
}

/** The fields of the SDK's rate-limit info that are used here. */
export type RateLimitInfo = {
  status?: string | undefined;
  resetsAt?: number | undefined; // Unix epoch SECONDS (spike S2)
  rateLimitType?: string | undefined;
  utilization?: number | undefined;
};

/** The part of an SDK rate-limit event that is kept (never its raw object). */
export function snapshotOf(info: RateLimitInfo, now: Date = new Date()): RateLimitSnapshot {
  const status =
    info.status === 'allowed' || info.status === 'allowed_warning' || info.status === 'rejected'
      ? info.status
      : 'allowed';
  let resets: string | null = null;
  if (typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)) {
    const when = new Date(info.resetsAt * 1000);
    if (!Number.isNaN(when.getTime())) resets = when.toISOString();
  }
  return {
    window: info.rateLimitType || 'five_hour',
    status,
    utilization: typeof info.utilization === 'number' ? info.utilization : null,
    resets_at: resets,
    seen_at: now.toISOString(),
  };
}

/** The part of the SDK's `/usage` answer that is used here (experimental API: read defensively). */
export type UsageAnswer = {
  subscription_type?: string | null | undefined;
  rate_limits_available?: boolean | undefined;
  rate_limits?: Readonly<Record<string, unknown>> | null | undefined;
};

const USAGE_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const;
const WARN_AT = 0.8;

/**
 * Snapshots from the SDK's `/usage` answer: the real plan windows, percent used and reset time,
 * available before Claude has reported any change. Empty for API-key logins and on odd shapes.
 */
export function snapshotsFromUsage(
  answer: UsageAnswer,
  now: Date = new Date(),
): RateLimitSnapshot[] {
  if (!answer.rate_limits_available || !answer.rate_limits) return [];
  const out: RateLimitSnapshot[] = [];
  for (const window of USAGE_WINDOWS) {
    const w = answer.rate_limits[window] as
      { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) continue;
    const when = typeof w.resets_at === 'string' ? new Date(w.resets_at) : null;
    const used = w.utilization / 100;
    out.push({
      window,
      status: used >= WARN_AT ? 'allowed_warning' : 'allowed',
      utilization: used,
      resets_at: when && !Number.isNaN(when.getTime()) ? when.toISOString() : null,
      seen_at: now.toISOString(),
    });
  }
  return out;
}

/** Keep the latest snapshot per window. */
export function mergeSnapshots(
  into: Record<string, RateLimitSnapshot>,
  snapshots: Iterable<RateLimitSnapshot>,
): void {
  for (const snap of snapshots) into[snap.window] = snap;
}

// ── the repo-wide cache: .advpipe/usage.json ────────────────────────────────────────────────────

export const cachePath = (repo: string): string => path.join(repo, '.advpipe', 'usage.json');

/** The cache, or an empty one when it's missing or unreadable. */
export function loadCache(repo: string): UsageCache {
  try {
    return UsageCache.parse(JSON.parse(readFileSync(cachePath(repo), 'utf-8')));
  } catch {
    return UsageCache.parse({});
  }
}

/**
 * Update the cache with what a call reported (temp file + rename, like run.json). A cache that
 * can't be written is not worth stopping a run for.
 */
export function recordUsage(
  repo: string,
  login: LoginKind,
  snapshots: Iterable<RateLimitSnapshot>,
): void {
  const snaps = [...snapshots];
  if (login === 'unknown' && snaps.length === 0) return;
  const cache = loadCache(repo);
  if (login !== 'unknown') cache.login = login;
  mergeSnapshots(cache.windows, snaps);
  cache.updated_at = new Date().toISOString();
  try {
    writeFileAtomic(cachePath(repo), JSON.stringify(cache, null, 2));
  } catch {
    // never fail a run because the cache couldn't be written
  }
}

/**
 * Whether the next agent calls will probably spend Console credits: `ANTHROPIC_API_KEY` is set,
 * or the last known login was Console. Silence is not a reason to say yes.
 */
export function likelyConsole(repo: string, env: Env = process.env): boolean {
  return Boolean(env['ANTHROPIC_API_KEY']) || loadCache(repo).login === 'console';
}
