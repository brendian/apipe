import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  Config,
  newRunState,
  stepsFor,
  LEVEL_ORDER,
  type Level,
  type RunDetail,
  type RunState,
  type StepViewData,
} from '@advpipe/contracts';
import {
  decide,
  FakeAgentRunner,
  loadContext,
  loadDetail,
  markdown,
  nextSteps,
  Orchestrator,
  quote,
  RunLog,
  seenByFor,
  taskMarkdown,
  writes,
  type Scripts,
} from '../src/index.js';
import { git, makeTargetRepo, scrubEnv, testConfig } from './helpers/repo.js';
import { happyScripts, IMPL_OK, SOLO_OK, SOLO_WRONG, TASK_MD_BLOCKING } from './helpers/samples.js';

beforeEach(scrubEnv);

const at = (level: Level): Config => {
  const c = testConfig();
  return { ...c, pipeline: { ...c.pipeline, level } };
};

async function orchestrate(repo: string, level: Level, scripts: Scripts, runId = 'r1') {
  const state = await new Orchestrator(at(level), new FakeAgentRunner(scripts), repo, 'add clamp', {
    runId,
    name: runId,
  }).run();
  return state;
}

const detail = (repo: string, id = 'r1'): RunDetail => {
  const d = loadDetail(repo, id);
  if (d === null || d.kind !== 'run') throw new Error('expected a run');
  return d;
};
const states = (steps: StepViewData[]): Record<string, string> =>
  Object.fromEntries(steps.map((s) => [s.stage, s.state]));

describe('the timeline of a finished run, at every level', () => {
  const scripts: Record<Level, Scripts> = {
    basic: { solo: [SOLO_OK] },
    reviewer: {
      solo: [SOLO_OK],
      'code-critic': [JSON.stringify({ verdict: 'PASS', findings: [] })],
    },
    tests: happyScripts(),
    adversarial: happyScripts(),
    full: happyScripts(),
  };
  it.each(LEVEL_ORDER)('%s: its own steps, all done, no arbiter used', async (level) => {
    const repo = makeTargetRepo();
    const s = await orchestrate(repo, level, scripts[level]);
    expect(s.status, s.notes.join('; ')).toBe('complete');
    const d = detail(repo);
    expect(d.timeline.map((t) => t.stage)).toEqual(stepsFor(level));
    const expected = Object.fromEntries(
      stepsFor(level).map((st) => [st, st === 'ARBITER' ? 'not_needed' : 'done']),
    );
    expect(states(d.timeline)).toEqual(expected);
    expect(d.row.status).toBe('complete');
    expect(d.report_html).toContain('advpipe run');
    expect(d.next_steps.map((n) => n.label)).toContain('Merge it, from the branch you want it on');
    expect(d.next_steps.some((n) => n.command.includes('advpipe '))).toBe(false);
  });

  it('full: rounds carry the diff, checks and verdicts; a missing critic says why at tests', async () => {
    const repo = makeTargetRepo();
    await orchestrate(repo, 'full', happyScripts());
    const code = detail(repo).timeline.find((t) => t.stage === 'CODE');
    const round = code?.rounds[0];
    expect(code?.summary).toBe('1 of 3 rounds');
    expect(round?.title).toBe('Round 1');
    expect(round?.diff?.lines.some((l) => l.kind === 'add')).toBe(true);
    expect(round?.gates[0]?.view.passed).toBe(true);
    expect(round?.critics[0]?.verdict?.verdict).toBe('PASS');
    expect(round?.outcome).toBe('code critic: PASS');

    const repo2 = makeTargetRepo();
    await orchestrate(repo2, 'tests', happyScripts());
    const tests = detail(repo2).timeline.find((t) => t.stage === 'TESTS');
    expect(tests?.rounds[0]?.notice).toBe('No critic at this level: the checks decide.');
  });

  it('solo levels title passes and fix passes, and show the person’s decisions', async () => {
    const repo = makeTargetRepo();
    await orchestrate(repo, 'basic', { solo: [SOLO_WRONG] });
    let d = detail(repo);
    expect(d.row.status).toBe('needs_decision');
    expect(d.decision_view?.choices).toEqual(['fix', 'takeover']);
    expect(d.decision_view?.fix_pass).toBe(1);
    expect(states(d.timeline)).toEqual({ SOLO: 'stopped', FINAL_GATES: 'pending' });
    await decide(repo, 'r1', 'fix', 'try harder');
    const orch = await Orchestrator.resume(
      new FakeAgentRunner({ solo: [writes(IMPL_OK, 'fixed')] }),
      repo,
      'r1',
    );
    await orch.run();
    d = detail(repo);
    const solo = d.timeline[0];
    expect(solo?.rounds.map((r) => r.title)).toEqual([
      'Pass 1',
      'Fix pass 1 (you asked)',
      'Decision 1: The checks are still failing',
    ]);
    expect(solo?.summary).toBe('1 pass');
    expect(solo?.rounds.at(-1)?.outcome).toBe('you chose fix');
  });
});

describe('the timeline from files alone', () => {
  function fake(repo: string, over: Partial<RunState>): RunLog {
    const log = RunLog.forRun(repo, 'r-t');
    log.writeState(newRunState({ run_id: 'r-t', work_item: 'x', repo, ...over }));
    log.writeConfig(Config.parse({ limits: { max_rounds_code: 3 } }));
    return log;
  }
  const scratch = (): string => mkdtempSync(path.join(tmpdir(), 'advpipe-rd-'));

  it('numeric round order, the current step, and "not yet" for what is still to come', () => {
    const repo = scratch();
    const log = fake(repo, {
      status: 'running',
      stage: 'CODE',
      round: 2,
      commits: { spec: 'a', tests: 'b' },
    });
    for (const n of [1, 2, 10]) log.writeText(`stage-code/round-${n}/author.txt`, `reply ${n}`);
    log.acquireLock(process.pid); // this process is alive: the run is live
    const d = detail(repo, 'r-t');
    const code = d.timeline.find((t) => t.stage === 'CODE');
    expect(code?.rounds.map((r) => r.title)).toEqual(['Round 1', 'Round 2', 'Round 10']);
    expect(code?.state).toBe('current');
    expect(code?.summary).toBe('3 of 3 rounds');
    expect(d.timeline.find((t) => t.stage === 'REVIEW')?.state).toBe('pending');
    expect(d.timeline.find((t) => t.stage === 'ARBITER')?.state).toBe('if_needed');
  });

  it('an interrupted run is stopped at its step; an ended one reaches nothing after it', () => {
    const repo = scratch();
    fake(repo, { status: 'running', stage: 'CODE', commits: { spec: 'a', tests: 'b' } });
    const stopped = detail(repo, 'r-t');
    expect(stopped.row.status).toBe('stopped');
    expect(stopped.timeline.find((t) => t.stage === 'CODE')?.state).toBe('stopped');

    const repo2 = scratch();
    fake(repo2, { status: 'needs_human', ended_by: 'stop', stage: 'SPEC' });
    expect(states(detail(repo2, 'r-t').timeline)).toMatchObject({
      SPEC: 'stopped',
      TESTS: 'not_reached',
      ARBITER: 'not_reached',
    });
  });

  it('missing, damaged and hostile files never fail the page', () => {
    const repo = scratch();
    const log = fake(repo, { status: 'error', stage: 'CODE', commits: { spec: 'a' } });
    log.writeText('stage-code/round-1/gates.json', '{not json');
    log.writeText(
      'stage-code/round-1/critic.json',
      'I refuse to answer in JSON <img src=x onerror=1>',
    );
    log.writeText('stage-code/round-1/author.txt', '<script>window.__pwned=1</script>');
    log.writeText('stage-code/round-2', 'a file where a directory belongs');
    const round = detail(repo, 'r-t').timeline.find((t) => t.stage === 'CODE')?.rounds[0];
    expect(round?.gates[0]?.view.readable).toBe(false);
    expect(round?.critics[0]?.verdict).toBeNull();
    expect(round?.outcome).toBe('critic output unreadable');
    expect(round?.author_html).not.toContain('<script');
  });

  it('"no such run" is null, a damaged run.json throws, a run with no run.json is starting', () => {
    const repo = scratch();
    expect(loadDetail(repo, 'nope')).toBeNull();
    mkdirSync(path.join(repo, '.advpipe/runs/starting'), { recursive: true });
    expect(loadDetail(repo, 'starting')).toMatchObject({ kind: 'starting' });
    fake(repo, {});
    writeFileSync(path.join(repo, '.advpipe/runs/r-t/run.json'), '{broken');
    expect(() => loadDetail(repo, 'r-t')).toThrow();
    expect(() => loadDetail(repo, '../x')).toThrow();
  });
});

describe('next steps', () => {
  const state = (over: Partial<RunState>): RunState =>
    newRunState({
      run_id: 'r',
      work_item: 'x',
      repo: '/r',
      branch: 'advpipe/x',
      base_commit: 'a'.repeat(40),
      worktree: '/r/.advpipe/worktrees/r',
      ...over,
    });

  it('are git commands only, quoted for a POSIX shell', () => {
    const steps = nextSteps(state({}), 'complete', '/home/me/my repo', 'posix');
    expect(steps.map((s) => s.command)).toEqual([
      "git -C '/home/me/my repo' log -p --reverse aaaaaaaaaaaa..advpipe/x",
      "git -C '/home/me/my repo' diff --stat aaaaaaaaaaaa...advpipe/x",
      "git -C '/home/me/my repo' merge advpipe/x",
      "git -C '/home/me/my repo' branch -d advpipe/x",
      "git -C '/home/me/my repo' worktree remove /r/.advpipe/worktrees/r",
    ]);
    expect(nextSteps(state({}), 'running', '/r', 'posix')).toEqual([]);
    expect(nextSteps(state({}), 'handed_over', '/r', 'posix').map((s) => s.command)[0]).toBe(
      'git -C /r switch advpipe/x',
    );
  });

  it('quote hostile values so a shell reads them back as one word', () => {
    for (const evil of ['a b', "it's", '$(rm -rf ~)', '`id`', 'x\ny', '; reboot', '', '-n']) {
      expect(quote(evil, 'posix')).toMatch(/^(?:'(?:[^']|'"'"')*'|[\w@%+=:,./-]+)$/u);
    }
    expect(quote("it's", 'posix')).toBe(`'it'"'"'s'`);
    expect(quote("it's $x", 'powershell')).toBe("'it''s $x'");
    const steps = nextSteps(state({ branch: 'b; rm -rf /' }), 'complete', '/r', 'posix');
    expect(steps[2]?.command).toBe("git -C /r merge 'b; rm -rf /'");
  });
});

describe('the Spec & context tab', () => {
  it('shows every block of a finished run; who sees what depends on the level', async () => {
    const repo = makeTargetRepo();
    await orchestrate(repo, 'full', happyScripts());
    const c = await loadContext(repo, 'r1');
    expect(c?.work_item.html).toContain('add clamp');
    expect(c?.task).toMatchObject({ criteria: 3, questions: 0, blocking: 0 });
    expect(c?.task?.sections).toEqual(['ac', 'oq']);
    expect(c?.config.config?.limits.budget_usd_per_task).toBe(5);
    expect(c?.checks.map((k) => k.name)).toEqual(['test', 'types', 'lint', 'security']);
    expect(c?.checks[1]?.command).toBe('');
    expect(c?.standards.source).toBe("on the run's branch advpipe/r1");
    expect(c?.roles.map((r) => r.role)).not.toContain('solo');
    expect(c?.roles.find((r) => r.role === 'code-critic')).toMatchObject({
      model: 'claude-sonnet-5-5',
      read_only: true,
    });
    expect(c?.roles.find((r) => r.role === 'coder')?.read_only).toBe(false);
    expect(seenByFor('basic').work_item).toContain('solo agent only');
    expect(seenByFor('basic').standards).toContain("there's no standards reviewer");
    expect(seenByFor('full').task_md).toContain('test critic');
  });

  it('falls back to the base commit when the branch is gone, and never leaves the repo', async () => {
    const repo = makeTargetRepo();
    const s = await orchestrate(repo, 'full', happyScripts());
    git(repo, 'branch', '-D', s.branch);
    const c = await loadContext(repo, 'r1');
    expect(c?.standards.source).toBe(
      `at the commit the run started from (${s.base_commit.slice(0, 12)})`,
    );
    // A hostile standards path or revision is refused, never passed to git as an option.
    const log = RunLog.forRun(repo, 'r1');
    for (const standards_doc of ['../outside.md', '/etc/passwd', '--output=x', 'a/../../b']) {
      log.writeConfig(Config.parse({ paths: { standards_doc } }));
      expect((await loadContext(repo, 'r1'))?.standards).toMatchObject({
        html: null,
        source: "its path isn't inside the repo",
      });
    }
    log.writeState({ ...log.readState(), branch: '--upload-pack=evil', base_commit: '-x' });
    log.writeConfig(Config.parse({}));
    expect((await loadContext(repo, 'r1'))?.standards.source).toBe('in the repo now');
  });

  it('missing and unreadable files are shown as such; an invalid config is shown raw', async () => {
    const repo = makeTargetRepo();
    const log = RunLog.forRun(repo, 'r2');
    log.writeState(newRunState({ run_id: 'r2', work_item: '', repo }));
    let c = await loadContext(repo, 'r2');
    expect(c).toMatchObject({ task: null, work_item: { html: null }, config: { raw: null } });
    expect(c?.checks).toEqual([]);
    log.writeText('config.json', '{"limits": {"budget_usd_per_task": "lots"}}');
    c = await loadContext(repo, 'r2');
    expect(c?.config.config).toBeNull();
    expect(c?.config.raw).toContain('lots');
    expect(c?.config.error).toMatch(/problem/);
    expect(await loadContext(repo, 'nope')).toBeNull();
  });
});

describe('markdown for untrusted text', () => {
  it('escapes raw HTML, drops unsafe links and images, turns alignment into classes', () => {
    const html = markdown(
      '<img src=x onerror=alert(1)>\n\n[a](javascript:alert(1)) [b](https://ok.example) ![i](x.png)\n\n' +
        '| a |\n|:-:|\n| 1 |\n',
    );
    expect(html).not.toMatch(/<img|<script|href="javascript/i);
    expect(html).toContain('&lt;img');
    expect(html).toContain('href="https://ok.example"');
    expect(html).toContain('class="align-center"');
    expect(html).not.toContain('style=');
  });

  it('marks acceptance criteria, open questions and BLOCKING ones, and counts them', () => {
    const t = taskMarkdown(TASK_MD_BLOCKING);
    expect(t).toMatchObject({ criteria: 3, questions: 1, blocking: 1 });
    expect(t.html).toContain('<h2 class="task-ac">Acceptance criteria</h2>');
    expect(t.html).toMatch(/<li class="oq blocking">BLOCKING:/);
    expect(taskMarkdown('## Open questions\n- None\n')).toMatchObject({ questions: 0 });
    expect(taskMarkdown('<script>x</script>').html).not.toContain('<script');
  });
});
