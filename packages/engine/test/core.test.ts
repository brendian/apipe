import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Budget,
  BudgetExceeded,
  ConfigError,
  detectLogin,
  emit,
  jsonAscii,
  listRuns,
  loadCache,
  loadConfig,
  loadWorkItem,
  recordUsage,
  RunLocked,
  RunLog,
  snapshotOf,
  snapshotsFromUsage,
} from '../src/index.js';

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'advpipe-core-'));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('config', () => {
  it('uses defaults, discovers <repo>/pipeline.toml, and remembers which keys were set', () => {
    expect(loadConfig({ repo }).config.limits.max_rounds_code).toBe(3);
    writeFileSync(
      path.join(repo, 'pipeline.toml'),
      '[limits]\nmax_rounds_code = 5\n[pipeline]\nlevel = 3\n',
    );
    const { config, explicit } = loadConfig({ repo });
    expect(config.limits.max_rounds_code).toBe(5);
    expect(config.pipeline.level).toBe('tests'); // a number is stored as the name
    expect(explicit['pipeline']?.has('level')).toBe(true);
    expect(explicit['pipeline']?.has('security_scan')).toBe(false);
  });

  it('refuses unknown keys and bad values, naming where', () => {
    const file = path.join(repo, 'bad.toml');
    writeFileSync(file, '[limits]\nmax_round_code = 5\n');
    expect(() => loadConfig({ file })).toThrow(ConfigError);
    expect(() => loadConfig({ file })).toThrow(/limits: .*max_round_code/);
    writeFileSync(file, '[pipeline]\nlevel = "huge"\n');
    expect(() => loadConfig({ file })).toThrow(/unknown level 'huge'/);
  });
});

describe('work-item files', () => {
  it('names the file in an error', () => {
    const file = path.join(repo, 'item.md');
    writeFileSync(file, '---\nname: x\ncolour: red\n---\nbody\n');
    expect(() => loadWorkItem(file)).toThrow(/item\.md:3: unknown key 'colour'/);
    expect(() => loadWorkItem(path.join(repo, 'missing.md'))).toThrow(/can't read work item/);
  });
});

describe('budget', () => {
  it('stops as soon as the limit is crossed, and counts calls per stage', () => {
    const b = new Budget(1.0);
    b.add(0.4, 'spec');
    b.add(0.4, 'spec');
    expect(b.remaining).toBeCloseTo(0.2);
    expect(() => b.add(0.4, 'solo')).toThrow(BudgetExceeded);
    expect(() => b.add(0.4, 'solo')).toThrow('budget exceeded: $1.60 spent, limit $1.00');
    expect(b.callsByStage['spec']).toBe(2);
    expect(b.remaining).toBe(0);
  });
});

describe('RunLog', () => {
  it('refuses run ids that are not safe path components', () => {
    for (const bad of [
      '',
      '..',
      'a/b',
      'a..b',
      '.hidden',
      '-x',
      'a'.repeat(101),
      'a\0b',
      'C:\\x',
    ]) {
      expect(() => RunLog.forRun(repo, bad), bad).toThrow('invalid run id');
    }
    expect(RunLog.forRun(repo, '20261008-091500-ab12cd').root).toContain('20261008-091500-ab12cd');
  });

  it('writes state atomically, with decisions beside it, and reads it back', () => {
    const log = RunLog.forRun(repo, 'r1');
    const s = newState();
    s.decisions.push(
      Object.assign(decision(), { explanation: 'The checks are still failing at CODE. x' }),
    );
    log.writeState(s);
    expect(log.readState()).toEqual(s);
    expect(JSON.parse(readFileSync(log.path('decisions/1.json'), 'utf-8')).kind).toBe('red_checks');
    expect(readdirSync(log.root).filter((f) => f.endsWith('.tmp'))).toEqual([]); // no temp left
  });

  it('writes non-ASCII as \\uXXXX in side files but real UTF-8 in run.json and events', () => {
    const log = RunLog.forRun(repo, 'r1');
    expect(jsonAscii({ s: 'café 😀' })).toBe('{\n  "s": "caf\\u00e9 \\ud83d\\ude00"\n}');
    log.writeJson('gates.json', [{ output: 'café' }]);
    expect(readFileSync(log.path('gates.json'), 'utf-8')).toContain('caf\\u00e9');
    const s = newState();
    s.work_item = 'café';
    log.writeState(s);
    expect(readFileSync(log.path('run.json'), 'utf-8')).toContain('café');
  });

  it('lock: a live holder blocks, this process may re-acquire, a dead pid never blocks', () => {
    const log = RunLog.forRun(repo, 'r1');
    expect(log.lockHolder()).toBeNull();
    log.acquireLock();
    expect(log.lockHolder()).toBe(process.pid);
    log.acquireLock(); // re-entrant for this process

    const child = spawnSync(process.execPath, ['-e', '']);
    expect(child.status).toBe(0);
    const dead = child.pid;
    writeFileSync(log.path('run.lock'), String(dead));
    expect(log.lockHolder()).toBeNull(); // stale lock ignored
    log.acquireLock();

    writeFileSync(log.path('run.lock'), String(process.ppid)); // another live process
    expect(() => log.acquireLock()).toThrow(RunLocked);
    expect(() => log.acquireLock()).toThrow(`run is being driven by pid ${process.ppid}`);
    log.acquireLock(process.ppid); // the host writing the child's pid on its behalf
    writeFileSync(log.path('run.lock'), 'garbage');
    expect(log.lockHolder()).toBeNull();
    log.releaseLock();
    expect(existsSync(log.path('run.lock'))).toBe(false);
  });

  it('lists runs oldest first and reports an unreadable one without failing', () => {
    expect(listRuns(repo)).toEqual({ runs: [], unreadable: [] });
    const a = RunLog.forRun(repo, 'a');
    const b = RunLog.forRun(repo, 'b');
    const sa = Object.assign(newState('a'), { started_at: '2026-10-02T00:00:00Z' });
    const sb = Object.assign(newState('b'), { started_at: '2026-10-01T00:00:00Z' });
    a.writeState(sa);
    b.writeState(sb);
    mkdirSync(path.join(repo, '.advpipe/runs/broken'), { recursive: true });
    writeFileSync(path.join(repo, '.advpipe/runs/broken/run.json'), '{not json');
    const { runs, unreadable } = listRuns(repo);
    expect(runs.map((r) => r.run_id)).toEqual(['b', 'a']);
    expect(unreadable.map((u) => u.run_id)).toEqual(['broken']);
  });

  it('events: one JSON line each, appended in order; echo=false is written into the event', () => {
    const log = RunLog.forRun(repo, 'r1');
    const s = newState();
    const printed: string[] = [];
    emit(log, s, (m) => printed.push(m), 'stage', '== SPEC', { passed: true });
    emit(log, s, (m) => printed.push(m), 'status', 'complete', { final: true }, false);
    expect(printed).toEqual(['== SPEC']);
    const events = readFileSync(log.path('events.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events[0]).toMatchObject({ kind: 'stage', stage: 'INIT', round: 0, passed: true });
    expect(events[0].ts).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    expect(events[0]).not.toHaveProperty('echo');
    expect(events[1]).toMatchObject({ final: true, echo: false });
  });
});

describe('usage', () => {
  it('detects the login in order, and never guesses Console from silence', () => {
    expect(detectLogin('ANTHROPIC_API_KEY', true, {})).toBe('console');
    expect(detectLogin('oauth', false, { ANTHROPIC_API_KEY: 'x' })).toBe('subscription');
    expect(detectLogin('none', true, { ANTHROPIC_API_KEY: 'x' })).toBe('subscription');
    expect(detectLogin('none', false, { ANTHROPIC_API_KEY: 'x' })).toBe('console');
    expect(detectLogin('none', false, {})).toBe('unknown');
    expect(detectLogin(undefined, false, {})).toBe('unknown');
  });

  it('turns the SDK /usage answer into 0-1 snapshots, and nothing for API-key logins', () => {
    const now = new Date('2026-10-08T00:00:00Z');
    const snaps = snapshotsFromUsage(
      {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 85, resets_at: '2026-10-08T03:00:00Z' },
          seven_day: { utilization: 10, resets_at: null },
          seven_day_opus: null,
        },
      },
      now,
    );
    expect(snaps.map((s) => [s.window, s.status, s.utilization])).toEqual([
      ['five_hour', 'allowed_warning', 0.85],
      ['seven_day', 'allowed', 0.1],
    ]);
    expect(snapshotsFromUsage({ rate_limits_available: false, rate_limits: null })).toEqual([]);
  });

  it('keeps only the known fields of a rate-limit event; resetsAt is epoch seconds', () => {
    const s = snapshotOf(
      { status: 'weird', resetsAt: 1_791_000_000, rateLimitType: 'seven_day', utilization: 0.3 },
      new Date('2026-10-08T00:00:00Z'),
    );
    expect(s).toEqual({
      window: 'seven_day',
      status: 'allowed',
      utilization: 0.3,
      resets_at: '2026-10-03T04:00:00.000Z',
      seen_at: '2026-10-08T00:00:00.000Z',
    });
    expect(snapshotOf({ status: 'rejected' }).window).toBe('five_hour');
  });

  it('records into .advpipe/usage.json, latest per window, and ignores empty news', () => {
    recordUsage(repo, 'unknown', []);
    expect(existsSync(path.join(repo, '.advpipe/usage.json'))).toBe(false);
    recordUsage(repo, 'subscription', [snapshotOf({ status: 'allowed', utilization: 0.1 })]);
    recordUsage(repo, 'unknown', [snapshotOf({ status: 'allowed_warning', utilization: 0.9 })]);
    const cache = loadCache(repo);
    expect(cache.login).toBe('subscription');
    expect(cache.windows['five_hour']?.status).toBe('allowed_warning');
    writeFileSync(path.join(repo, '.advpipe/usage.json'), 'junk');
    expect(loadCache(repo).windows).toEqual({});
  });
});

// ── helpers ────────────────────────────────────────────────────────────────────────────────────
import { newRunState, Decision } from '@advpipe/contracts';

function newState(id = 'r1') {
  return newRunState({ run_id: id, work_item: 'Add clamp.', repo });
}
function decision() {
  return Decision.parse({ kind: 'red_checks', stage: 'CODE', explanation: 'x' });
}
