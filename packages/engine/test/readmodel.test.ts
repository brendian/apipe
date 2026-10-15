import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  Config,
  newRunState,
  type Decision,
  type DisplayStatus,
  type RunState,
} from '@advpipe/contracts';
import {
  displayStatus,
  loadDetail,
  loadRuns,
  loadStarting,
  loadUsage,
  preflight,
  recordUsage,
  RunLog,
  stageLabel,
  tailEvents,
} from '../src/index.js';
import { makeTargetRepo, scrubEnv } from './helpers/repo.js';

beforeEach(scrubEnv);

const scratchRepo = (): string => mkdtempSync(path.join(tmpdir(), 'advpipe-rm-'));

/** A run directory written directly, for statuses a finished fake run can't leave. */
function fakeRun(repo: string, runId: string, over: Partial<RunState> = {}): RunLog {
  const log = RunLog.forRun(repo, runId);
  log.writeState(newRunState({ run_id: runId, work_item: '# Add clamp\nbody', repo, ...over }));
  log.writeConfig(Config.parse({ limits: { budget_usd_per_task: 8, max_rounds_code: 3 } }));
  return log;
}

const decision = (over: Partial<Decision> = {}): Decision => ({
  kind: 'red_checks',
  stage: 'CODE',
  asked_at: '2026-10-15T10:00:00Z',
  explanation: 'x',
  findings: [],
  usage: null,
  billing: false,
  choice: '',
  note: '',
  decided_at: null,
  applied: false,
  ...over,
});

describe('displayStatus', () => {
  const table: [string, Partial<RunState>, DisplayStatus][] = [
    ['running with no process', { status: 'running' }, 'stopped'],
    ['complete', { status: 'complete' }, 'complete'],
    ['over budget', { status: 'budget_exceeded' }, 'budget_exceeded'],
    ['error', { status: 'error' }, 'error'],
    ['needs_human, nothing special', { status: 'needs_human' }, 'needs_human'],
    ['took over', { status: 'needs_human', ended_by: 'takeover' }, 'handed_over'],
    ['finished as is', { status: 'needs_human', ended_by: 'finish' }, 'finished'],
    ['stopped at Begin work', { status: 'needs_human', ended_by: 'stop' }, 'ended'],
    ['open decision', { status: 'needs_human', decisions: [decision()] }, 'needs_decision'],
    [
      'open usage limit',
      { status: 'needs_human', decisions: [decision({ kind: 'usage_limit' })] },
      'paused',
    ],
    [
      'a fix chosen but not applied',
      { status: 'needs_human', decisions: [decision({ choice: 'fix' })] },
      'stopped',
    ],
    [
      'unanswered blocking question',
      {
        status: 'needs_human',
        stage: 'SPEC',
        questions: [{ id: 'Q1', text: 'q?', asked_in: 1 }] as RunState['questions'],
      },
      'needs_answers',
    ],
  ];
  it.each(table)('%s', (_name, over, expected) => {
    const repo = scratchRepo();
    const log = fakeRun(repo, 'r1', over);
    expect(displayStatus(log.readState(), log)).toBe(expected);
  });

  it('a live process holding run.lock wins over everything', () => {
    const repo = scratchRepo();
    const log = fakeRun(repo, 'r1', { status: 'complete' });
    log.acquireLock(process.pid);
    expect(displayStatus(log.readState(), log)).toBe('running');
  });

  it('stageLabel adds the round and its cap, and says FINAL CHECKS', () => {
    const state = newRunState({ run_id: 'r', work_item: 'x', repo: '/r', stage: 'CODE', round: 2 });
    expect(stageLabel(state, Config.parse({ limits: { max_rounds_code: 3 } }))).toBe('CODE r2/3');
    expect(stageLabel(state, null)).toBe('CODE r2');
    expect(stageLabel({ ...state, stage: 'FINAL_GATES' }, null)).toBe('FINAL CHECKS');
  });
});

describe('loadRuns', () => {
  it('lists newest first, counts per filter, and reports unreadable runs', () => {
    const repo = scratchRepo();
    fakeRun(repo, 'a-old', { status: 'complete', started_at: '2026-10-01T00:00:00Z' });
    fakeRun(repo, 'b-new', {
      status: 'error',
      started_at: '2026-10-02T00:00:00Z',
      branch: 'advpipe/x',
    });
    const broken = path.join(repo, '.advpipe', 'runs', 'c-broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(path.join(broken, 'run.json'), '{nope');
    const all = loadRuns(repo);
    expect(all.rows.map((r) => r.run_id)).toEqual(['b-new', 'a-old']);
    expect(all.rows[0]).toMatchObject({ status: 'error', title: 'Add clamp', budget_usd: 8 });
    expect(all.counts).toEqual({ all: 2, running: 0, needs_you: 1, complete: 1 });
    expect(all.unreadable).toHaveLength(1);
    expect(all.unreadable[0]?.run_id).toBe('c-broken');
    expect(loadRuns(repo, 'complete').rows.map((r) => r.run_id)).toEqual(['a-old']);
    expect(loadRuns(scratchRepo()).rows).toEqual([]);
  });
});

describe('runs.detail plumbing', () => {
  it('tells a missing run, a starting run and a readable run apart', () => {
    const repo = scratchRepo();
    expect(loadDetail(repo, 'nope')).toBeNull();
    const dir = path.join(repo, '.advpipe', 'runs', 'starting');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'console.log'), 'line1\nline2\n');
    expect(loadStarting(repo, 'starting')).toMatchObject({
      kind: 'starting',
      alive: false,
      console_tail: 'line1\nline2',
    });
    fakeRun(repo, 'ready');
    expect(loadStarting(repo, 'ready')).toBeNull();
    expect(loadDetail(repo, 'ready')).toMatchObject({ kind: 'run' });
    expect(() => loadDetail(repo, '../x')).toThrow();
    writeFileSync(path.join(repo, '.advpipe', 'runs', 'ready', 'run.json'), '{nope');
    expect(() => loadDetail(repo, 'ready')).toThrow(); // "can't read", not "no such run"
  });
});

describe('tailEvents', () => {
  const ev = (message: string): string =>
    JSON.stringify({
      ts: '2026-10-15T10:00:00.000Z',
      kind: 'stage',
      stage: 'CODE',
      round: 1,
      message,
    }) + '\n';

  it('holds back a partial line, resumes mid-stream, and survives a bad line', () => {
    const repo = scratchRepo();
    const log = fakeRun(repo, 'r1');
    const file = log.path('events.jsonl');
    writeFileSync(file, ev('one') + 'not json\n' + ev('three').slice(0, 20));
    const first = tailEvents(repo, 'r1', 0);
    expect(first.lines.map((l) => l.message)).toEqual(['one', 'unreadable log line: not json']);
    expect(first.lines[1]?.kind).toBe('error');
    expect(first.ended).toBe(true); // no process, and only a partial line is left
    appendFileSync(file, ev('three').slice(20));
    const next = tailEvents(repo, 'r1', first.next_offset);
    expect(next.lines.map((l) => l.message)).toEqual(['three']);
    // An offset in the middle of a line moves to the next line start; one past the end clamps.
    expect(tailEvents(repo, 'r1', 5).lines.map((l) => l.message)).toEqual([
      'unreadable log line: not json',
      'three',
    ]);
    expect(tailEvents(repo, 'r1', 1e9).lines).toEqual([]);
  });

  it('is not ended while a live process holds the lock, and reads long lines', () => {
    const repo = scratchRepo();
    const log = fakeRun(repo, 'r1');
    writeFileSync(log.path('events.jsonl'), ev('x'.repeat(5000)));
    log.acquireLock(process.pid);
    const tail = tailEvents(repo, 'r1', 0, 100); // window smaller than the line
    expect(tail.lines[0]?.message).toHaveLength(5000);
    expect(tail.ended).toBe(false);
    expect(tailEvents(repo, 'missing-events', 0).lines).toEqual([]);
  });
});

describe('usage and preflight', () => {
  it('shows what is known, with the right labels', () => {
    const repo = scratchRepo();
    expect(loadUsage(repo)).toMatchObject({ login: 'unknown', meters: [], console: false });
    const now = new Date('2026-10-15T12:00:00Z');
    recordUsage(repo, 'subscription', [
      {
        window: 'five_hour',
        status: 'allowed_warning',
        utilization: 0.62,
        resets_at: '2026-10-15T14:00:00Z',
        seen_at: now.toISOString(),
      },
    ]);
    const view = loadUsage(repo, now);
    expect(view).toMatchObject({ login: 'subscription', cost_label: 'API-equivalent, not billed' });
    expect(view.meters[0]).toMatchObject({
      label: '5-hour',
      percent: 62,
      status: 'allowed_warning',
    });
    expect(view.warn).toMatch(/nearly used up/);
  });

  it('preflight: passes on a repo with a commit, and says what to do otherwise', async () => {
    const ok = await preflight(makeTargetRepo());
    expect(ok.git.ok && ok.repo.ok && ok.claude.ok).toBe(true);
    expect(ok.repo).toMatchObject({ is_git: true, has_commit: true, branch: 'main', dirty: 0 });
    expect(ok.items_dir).toMatchObject({ path: 'work-items', exists: false });
    const plain = await preflight(scratchRepo());
    expect(plain.repo).toMatchObject({ ok: false, level: 'bad', is_git: false });
    expect(plain.repo.text).toMatch(/git init/);
  });
});
