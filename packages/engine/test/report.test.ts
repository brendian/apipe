import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Decision,
  droppedSafeguards,
  LEVEL_ORDER,
  newRunState,
  OpenQuestion,
  rolesFor,
  RunState,
} from '@advpipe/contracts';
import { emit, RunLog, renderReport } from '../src/index.js';

const base = () => newRunState({ run_id: 'r', work_item: 'w', repo: '/x' });
const section = (report: string, heading: string) =>
  (report.split(`## ${heading}\n`)[1] ?? '').split('\n## ')[0];

describe('renderReport', () => {
  it.each(LEVEL_ORDER.flatMap((l) => [[l, true] as const, [l, false] as const]))(
    'names level %s (scan %s) and what is not done',
    (level, scan) => {
      const report = renderReport({ ...base(), level, security_scan: scan });
      if (level === 'full' && scan) {
        expect(report).toContain('- **Level:** full\n');
        expect(report).not.toContain('Not done at this level');
        return;
      }
      const n = rolesFor(level).length;
      expect(report).toContain(
        `(${LEVEL_ORDER.indexOf(level) + 1} of 5): ${n} agent${n === 1 ? '' : 's'} · security scan ${scan ? 'on' : 'off'}`,
      );
      for (const line of droppedSafeguards(level, scan)) expect(report).toContain(`  - ${line}`);
    },
  );

  it('marks the agent’s answers and says where a person acts, without naming a command', () => {
    const s = base();
    s.questions = [
      OpenQuestion.parse({ id: 'Q1', text: 'Round how?', asked_in: 1, answer: 'half-up' }),
      OpenQuestion.parse({
        id: 'Q2',
        text: 'After 90 days?',
        asked_in: 1,
        answer: 'No.',
        source: 'agent',
        reasoning: 'RefundPolicy\ncaps it',
        bypassed: true,
      }),
      OpenQuestion.parse({ id: 'Q3', text: 'Open?', asked_in: 2 }),
    ];
    const q = section(renderReport(s, { waitingOnAnswers: true }), 'Questions and answers');
    expect(q).toContain('  - **Answer:** half-up');
    expect(q).toContain("  - **Answer (agent's best judgement, you chose Bypass):** No.");
    expect(q).toContain('  - **Reason:** RefundPolicy caps it');
    expect(q).toContain('  - (not answered yet)');
    const waiting = renderReport(s, { waitingOnAnswers: true });
    expect(waiting).toContain("- The spec has blocking questions. Answer them on the run's page.");
    expect(waiting).not.toMatch(/advpipe (answer|decide)/);
  });

  it('shows an open decision once in the notes, then what the person chose', () => {
    const s = base();
    s.status = 'needs_human';
    s.decisions.push(
      Decision.parse({ kind: 'red_checks', stage: 'CODE', explanation: 'The checks are failing.' }),
    );
    let report = renderReport(s);
    expect(section(report, 'Decisions')).toContain("(waiting for you: choose on the run's page)");
    expect(section(report, 'Notes')).toContain('- The checks are failing.');
    expect(report).not.toMatch(/advpipe decide/);

    Object.assign(s.decisions[0] as Decision, { choice: 'takeover', note: 'a\nb' });
    s.ended_by = 'takeover';
    report = renderReport(s);
    expect(section(report, 'Decisions')).toContain('**You chose:** takeover (not acted on yet)');
    expect(section(report, 'Decisions')).toContain('**Your note:** a\n    b');
    expect(section(report, 'Decisions')).toContain(
      'Handed over to you at CODE; the branch has the work as it was.',
    );
    expect(section(report, 'Notes')).toBe('- None\n');
  });

  it('a run without decisions has no Decisions section; cost table has a total row', () => {
    const s = base();
    expect(renderReport(s)).not.toContain('## Decisions');
    s.cost_by_stage = { spec: 0.25, 'stage-code': 0.75 };
    s.calls_by_stage = { spec: 1, 'stage-code': 3 };
    expect(section(renderReport(s), 'Cost by stage')).toContain(
      '| spec | 1 | $0.25 | 25% |\n| stage-code | 3 | $0.75 | 75% |\n| **total** | **4** | **$1.00** | |',
    );
  });
});

describe('a run written by the engine loads back and reports', () => {
  let repo = '';
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('round-trips run.json and renders the ported report text', () => {
    repo = mkdtempSync(path.join(tmpdir(), 'advpipe-report-'));
    const log = RunLog.forRun(repo, 'run-1');
    const state = newRunState({ run_id: 'run-1', work_item: 'Add clamp.', repo });
    Object.assign(state, {
      branch: 'advpipe/add-clamp',
      worktree: path.join(repo, '.advpipe/worktrees/run-1'),
      status: 'complete',
      stage: 'DONE',
      cost_usd: 1.5,
      rounds_used: { tests: 1, code: 2 },
      auth: 'subscription',
    });
    state.open_findings.push({
      id: 'C2-F1',
      severity: 'blocking',
      category: 'correctness',
      file: 'a.js',
      line: 3,
      criterion: 'AC2',
      claim: 'wrong',
      evidence: 'line1\nline2',
      suggested_check: '',
    });
    emit(log, state, () => {}, 'run_start', 'branch advpipe/add-clamp');
    log.writeState(state);
    log.writeText('report.md', renderReport(log.readState()));

    expect(log.readState()).toEqual(
      RunState.parse(JSON.parse(readFileSync(log.path('run.json'), 'utf-8'))),
    );
    expect(readFileSync(log.path('report.md'), 'utf-8')).toBe(
      [
        '# advpipe run run-1',
        '',
        '- **Status:** complete',
        '- **Level:** full',
        '- **Work item:** Add clamp.',
        `- **Branch:** \`advpipe/add-clamp\` (worktree \`${state.worktree}\`)`,
        '- **Stopped at stage:** DONE',
        '- **Cost:** $1.50',
        '- **Time:** 0s',
        '',
        '## Rounds used',
        '- tests: 1',
        '- code: 2',
        '',
        '## Open blocking findings',
        '- **C2-F1** [blocking/correctness] (a.js:3, AC2) wrong',
        '  - evidence:\n    ```\n    line1\n    line2\n    ```',
        '',
        '## Minor findings (not fixed)',
        '- None',
        '',
        '## Arbiter rulings',
        '- None',
        '',
        '## Cost by stage',
        '- None',
        '',
        '## Login and usage',
        '- **Login:** Claude subscription',
        "- The dollar figures are API-equivalent estimates: a subscription login isn't billed per call. The budget still caps them.",
        '',
        '## Notes',
        '- None',
        '',
      ].join('\n'),
    );
  });
});
