import { vi } from 'vitest';
import {
  Prefs,
  type AdvpipeApi,
  type CleanInfoView,
  type HelpView,
  type DraftChecks,
  type DraftView,
  type ItemList,
  type RunPlan,
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
  actions: [],
  suggested_budget: 30,
  questions: [],
  asker: 'spec writer',
  bypass_on: false,
  open_findings: [],
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
  ...{
    theme: 'system',
    notifications: true,
    run_filter: 'all',
    items_dir: 'work-items',
    recent: [],
  },
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

export const itemList = (over: Partial<ItemList> = {}): ItemList => ({
  items_dir: 'work-items',
  folder_exists: true,
  groups: [],
  skipped: [],
  git_known: true,
  ...over,
});

export const draftOf = (over: Partial<DraftView> = {}): DraftView => ({
  rel: 'a.md',
  name: '',
  config: '',
  body: 'Add clamp',
  base: 'b'.repeat(64),
  problem: null,
  level: '',
  security_scan: '',
  scan_failures: '',
  bypass_questions: '',
  last_run: null,
  ...over,
});

export const checksOf = (over: Partial<DraftChecks> = {}): DraftChecks => ({
  checks: [],
  branch: 'advpipe/add-clamp',
  ok: true,
  preview_html: '<p>Add clamp</p>',
  ...over,
});

export const planOf = (over: Partial<RunPlan> = {}): RunPlan => ({
  errors: [],
  warnings: [],
  ok: true,
  budget: 15,
  budget_text: '15.00',
  config_label: 'pipeline.toml',
  branch: 'advpipe/add-clamp',
  item_name: '',
  item_config: '',
  level: 'tests',
  inherited_level: 'tests',
  level_source: 'pipeline.toml',
  scan: false,
  scan_default: false,
  scan_source: "the level's default",
  failures: 'ask',
  inherited_failures: 'ask',
  bypass: false,
  inherited_bypass: false,
  review: false,
  agents: 4,
  calls: [4, 11],
  dropped: ['No standards review'],
  shown_text: 'tests;off;ask;ask',
  ...over,
});

export const cleanInfoOf = (over: Partial<CleanInfoView> = {}): CleanInfoView => ({
  run_id: '20261015-100000-aaaaaa',
  title: 'Add clamp',
  status: 'stopped',
  refusal: null,
  worktree: '/home/me/proj/.advpipe/worktrees/20261015-100000-aaaaaa',
  branch: 'advpipe/add-clamp',
  unmerged_commits: 0,
  dirty_finished: false,
  base: 'abcdef123456',
  ...over,
});

export const helpOf = (): HelpView => ({
  levels: [
    {
      number: 1,
      name: 'basic',
      label: 'Basic',
      good_for: 'typos',
      description: 'One agent does it all.',
      agents: 1,
      steps: 'SOLO → FINAL CHECKS',
      calls: '1',
      scan: 'off',
      dropped: ['No security scan'],
    },
  ],
  level_labels: ['Basic'],
  rule_marks: [{ rule: '1. The orchestrator is code, not an agent', marks: ['✔'] }],
  step_states: [{ label: 'done', help: 'Finished.' }],
  roles: [
    {
      role: 'coder',
      job: 'Changes the code.',
      inputs: 'task.md',
      model: 'claude-opus-5-5',
      tools: ['Read', 'Edit'],
      writes: true,
    },
  ],
  checks: [{ name: 'test', help: 'the test suite' }],
  statuses: [
    {
      key: 'complete',
      label: 'complete',
      icon: '✔',
      help: 'Finished with all checks passing.',
      next: 'Merge it yourself.',
    },
  ],
  limits: {
    max_rounds_spec: 3,
    max_rounds_tests: 2,
    max_rounds_code: 3,
    max_fix_passes: 3,
    budget_usd_per_task: 15,
  },
});

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
    openLogs: ReturnType<typeof vi.fn>;
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
    /** Replacements for the work-items and new-run channels, by namespace. */
    items?: Record<string, unknown>;
    newrun?: Record<string, unknown>;
    /** Replacements for the action channels (`run.cancel`, `run.answer`, …). */
    run?: Record<string, unknown>;
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
  const openLogs = vi.fn(async () => ok({ ok: true }));
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
      help: async () => ok(helpOf()),
      about: async () =>
        ok({ name: 'advpipe', version: '0.0.0', electron: '44', chrome: '152', node: '24' }),
      logs: { open: openLogs },
    },
    runs: {
      list: runsList,
      detail: runsDetail,
      context: async () => ok((over.context ?? (() => null))()),
      log: { subscribe, unsubscribe },
    },
    usage: { get: async () => ok(over.usage ?? quietUsage) },
    items: {
      list: async () => ok(itemList()),
      read: async () => ok(draftOf()),
      check: async () => ok(checksOf()),
      create: async () => ok({ rel: 'a.md' }),
      save: async () => ok({ changed: true }),
      rename: async () => ok({ rel: 'b.md' }),
      deleteInfo: async () => ok({ rel: 'a.md', git: '', items_dir: 'work-items' }),
      delete: async () => ok({ deleted: 'a.md' }),
      ...over.items,
    },
    newrun: {
      plan: async () => ok(planOf()),
      start: async () => ok({ runId: '20261015-100000-abcdef' }),
      ...over.newrun,
    },
    run: {
      cancel: async () => ok({ runId: '20261015-100000-aaaaaa' }),
      resume: async () => ok({ runId: '20261015-100000-aaaaaa' }),
      answer: async () => ok({ runId: '20261015-100000-aaaaaa' }),
      decide: async () => ok({ runId: '20261015-100000-aaaaaa', resumed: true }),
      cleanInfo: async () => ok(cleanInfoOf()),
      clean: async () => ok({ lines: [] }),
      reveal: async () => ok({ ok: true }),
      openLink: async () => ok({ ok: true }),
      ...over.run,
    },
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
    fns: { runsList, runsDetail, subscribe, unsubscribe, prefsSet, pick, openLogs },
  };
}

export { Prefs };
