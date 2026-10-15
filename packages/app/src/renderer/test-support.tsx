import { vi } from 'vitest';
import {
  Prefs,
  type AdvpipeApi,
  type Preflight,
  type PrefsView,
  type PushChannel,
  type PushPayloads,
  type Result,
  type RoundViewData,
  type RunDetail,
  type StepViewData,
  type RunList,
  type RunRow,
  type UsageView,
  type WindowInfo,
} from '@advpipe/contracts';

// A typed fake of `window.advpipe` with a push emitter, for the page tests.

export const ok = <T,>(value: T): Result<T> => ({ ok: true, value });

export const row = (over: Partial<RunRow> = {}): RunRow => ({
  run_id: '20261015-100000-aaaaaa',
  status: 'complete',
  title: 'Add clamp',
  branch: 'advpipe/add-clamp',
  stage: 'DONE',
  cost_usd: 1.5,
  budget_usd: 8,
  started_at: new Date(Date.now() - 3.5 * 60_000).toISOString(),
  work_item_file: '',
  level: 'tests',
  ...over,
});

const quietUsageView: UsageView = {
  login: 'subscription',
  login_label: 'Claude subscription',
  cost_label: 'API-equivalent, not billed',
  console: false,
  warn: '',
  note: 'Not known yet: advpipe sees usage only when Claude reports a change.',
  meters: [],
};

/** A run's page data with nothing in its timeline; tests override what they look at. */
export const detailOf = (over: Partial<RunDetail> = {}): RunDetail => ({
  kind: 'run',
  row: row(),
  title: 'Add clamp',
  live: false,
  elapsed: '3m 07s',
  scan: false,
  dropped: [],
  worktree_kept: false,
  work_item_file: '',
  usage: quietUsageView,
  timeline: [],
  report_html: null,
  next_steps: [],
  decision_view: null,
  ...over,
});

export const roundOf = (over: Partial<RoundViewData> = {}): RoundViewData => ({
  key: 'code/round-1',
  title: 'Round 1',
  author_role: 'coder',
  author_html: null,
  diff: null,
  gates: [],
  critics: [],
  test_fix_html: null,
  expect_red: false,
  task_html: null,
  asked: [],
  notice: '',
  decision: null,
  outcome: '',
  ...over,
});

export const stepOf = (over: Partial<StepViewData> = {}): StepViewData => ({
  stage: 'CODE',
  label: 'CODE',
  state: 'current',
  summary: '',
  rounds: [],
  task_html: null,
  rulings: [],
  rulings_note: '',
  ...over,
});

export const listOf = (rows: RunRow[], unreadable: RunList['unreadable'] = []): RunList => ({
  rows,
  counts: {
    all: rows.length,
    running: rows.filter((r) => r.status === 'running').length,
    needs_you: rows.filter((r) => r.status === 'needs_human').length,
    complete: rows.filter((r) => r.status === 'complete').length,
  },
  unreadable,
});

export const prefsView = (over: Partial<PrefsView> = {}): PrefsView => ({
  ...{ theme: 'system', notifications: true, run_filter: 'all', recent: [] },
  ...over,
});

const goodPreflight: Preflight = {
  git: { ok: true, level: 'ok', version: '2.56.0', text: 'git 2.56.0 found' },
  repo: {
    ok: true,
    level: 'ok',
    is_git: true,
    has_commit: true,
    branch: 'main',
    dirty: 0,
    text: '~/proj is a git repo (branch main, no uncommitted files).',
  },
  claude: {
    ok: true,
    level: 'warn',
    login: 'unknown',
    version: '0.3.300',
    text: 'Claude Code found (SDK bundled).',
  },
  items_dir: {
    ok: true,
    level: 'warn',
    path: 'work-items',
    exists: false,
    text: 'No work-items/ yet.',
  },
};

const quietUsage: UsageView = {
  login: 'unknown',
  login_label: 'not known yet',
  cost_label: "API-equivalent if you're on a subscription",
  console: false,
  warn: '',
  note: '',
  meters: [],
};

export type Stub = {
  api: AdvpipeApi;
  emit: <C extends PushChannel>(channel: C, payload: PushPayloads[C]) => void;
  fns: {
    runsList: ReturnType<typeof vi.fn>;
    runsDetail: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
    prefsSet: ReturnType<typeof vi.fn>;
    pick: ReturnType<typeof vi.fn>;
  };
};

export function makeApi(
  over: {
    repo?: WindowInfo['repo'];
    list?: () => RunList;
    detail?: () => unknown;
    context?: () => unknown;
    detailError?: string;
    prefs?: PrefsView;
    preflight?: Preflight;
    usage?: UsageView;
  } = {},
): Stub {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const repo = over.repo === undefined ? { name: 'proj', path: '/home/me/proj' } : over.repo;
  const runsList = vi.fn(async () => ok((over.list ?? (() => listOf([])))()));
  const runsDetail = vi.fn(async () =>
    over.detailError !== undefined
      ? ({ ok: false, error: over.detailError } as const)
      : ok((over.detail ?? (() => null))()),
  );
  const subscribe = vi.fn(async () => ok({ ok: true }));
  const unsubscribe = vi.fn(async () => ok({ ok: true }));
  const prefsSet = vi.fn(async () => ok(over.prefs ?? prefsView()));
  const pick = vi.fn(async () => ok({ opened: false }));
  const api = {
    app: {
      window: { info: async () => ok({ repo }) },
      prefs: { get: async () => ok(over.prefs ?? prefsView()), set: prefsSet },
      repo: {
        pick,
        openRecent: async () => ok({ opened: true }),
        forgetRecent: async () => ok(over.prefs ?? prefsView()),
      },
      preflight: async () => ok(over.preflight ?? goodPreflight),
    },
    runs: {
      list: runsList,
      detail: runsDetail,
      context: async () => ok((over.context ?? (() => null))()),
      log: { subscribe, unsubscribe },
    },
    usage: { get: async () => ok(over.usage ?? quietUsage) },
    on: (channel: string, cb: (p: unknown) => void) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(cb);
      listeners.set(channel, set);
      return () => set.delete(cb);
    },
  } as unknown as AdvpipeApi;
  return {
    api,
    emit: (channel, payload) => listeners.get(channel)?.forEach((cb) => cb(payload)),
    fns: { runsList, runsDetail, subscribe, unsubscribe, prefsSet, pick },
  };
}

export { Prefs };
