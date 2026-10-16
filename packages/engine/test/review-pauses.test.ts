import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Config } from '@advpipe/contracts';
import { decide, FakeAgentRunner, Orchestrator, RunLog, writes } from '../src/index.js';
import { git, makeTargetRepo, scrubEnv, testConfig } from './helpers/repo.js';
import { happyScripts, IMPL_OK, TASK_MD } from './helpers/samples.js';

beforeEach(scrubEnv);

const reviewing = (): Config => {
  const c = testConfig();
  return { ...c, pipeline: { ...c.pipeline, review_pauses: true } };
};
const logOf = (repo: string): RunLog => RunLog.forRun(repo, 'r1');

async function resume(repo: string, config: Config, scripts = happyScripts()) {
  const runner = new FakeAgentRunner(scripts);
  const orch = await Orchestrator.resume(runner, repo, 'r1', { config });
  return { state: await orch.run(), runner };
}

describe('review pauses', () => {
  it('stop after the spec, the tests and the code, and carry on only when approved', async () => {
    const repo = makeTargetRepo();
    const config = reviewing();
    const first = await new Orchestrator(
      config,
      new FakeAgentRunner(happyScripts()),
      repo,
      'add clamp',
      { runId: 'r1', name: 'r1' },
    ).run();

    // The spec: written, not committed, waiting for the person to read and edit it.
    let d = first.decisions.at(-1);
    expect([first.status, d?.kind, d?.stage]).toEqual(['needs_human', 'review_step', 'SPEC']);
    expect('spec' in first.commits).toBe(false);
    const edited = TASK_MD.replace('# Task: Add clamp', '# Task: Add clamp (edited by me)');
    await decide(repo, 'r1', 'approve', '', edited);

    // The tests: committed, the diff written for review.
    let { state } = await resume(repo, config);
    d = state.decisions.at(-1);
    expect([state.status, d?.kind, d?.stage]).toEqual(['needs_human', 'review_step', 'TESTS']);
    expect(git(repo, 'show', 'advpipe/r1:task.md')).toContain('edited by me');
    expect(readFileSync(logOf(repo).path('human-review/tests.patch'), 'utf-8')).toContain(
      'clamp.test.js',
    );
    await decide(repo, 'r1', 'approve');

    // The code: send notes back once, and it stops at the code again.
    ({ state } = await resume(repo, config));
    d = state.decisions.at(-1);
    expect([state.status, d?.kind, d?.stage]).toEqual(['needs_human', 'review_step', 'CODE']);
    expect(existsSync(logOf(repo).path('human-review/code.patch'))).toBe(true);
    await decide(repo, 'r1', 'revise', 'also handle NaN');
    const revised = await resume(repo, config, { coder: [writes(IMPL_OK, 'revised')] });
    state = revised.state;
    expect(revised.runner.callsFor('coder')[0]?.prompt).toContain('also handle NaN');
    d = state.decisions.at(-1);
    expect([state.status, d?.kind, d?.stage, d?.choice]).toEqual([
      'needs_human',
      'review_step',
      'CODE',
      '',
    ]);

    await decide(repo, 'r1', 'approve');
    ({ state } = await resume(repo, config));
    expect(state.status, state.notes.join('; ')).toBe('complete');
  });

  it('only the spec can be edited, and a note needs Send my notes back', async () => {
    const repo = makeTargetRepo();
    await new Orchestrator(reviewing(), new FakeAgentRunner(happyScripts()), repo, 'add clamp', {
      runId: 'r1',
      name: 'r1',
    }).run();
    await expect(decide(repo, 'r1', 'approve', 'a note')).rejects.toThrow(
      /note goes with Send my notes back/,
    );
    await expect(decide(repo, 'r1', 'revise', '')).rejects.toThrow(/write a note/);
    expect(path.basename(logOf(repo).root)).toBe('r1');
  });
});
