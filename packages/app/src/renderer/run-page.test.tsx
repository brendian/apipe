// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import type { ContextView, Finding } from '@advpipe/contracts';
import { App } from './app/App.js';
import { detailOf, listOf, makeApi, roundOf, row, stepOf } from './test-support.js';

afterEach(cleanup);
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { value: () => null });

const HOSTILE = [
  '<img src=x onerror=alert(1)>',
  '<script>window.__pwned = 1</script>',
  '[click](javascript:alert(1))',
  '<iframe src="https://evil.example"></iframe>',
  '‮evil\u0000rtl',
  'a'.repeat(5000),
];
const HTML_ATTACK =
  '<p onclick="alert(1)" style="x:y">hi</p><img src=x onerror=alert(1)><script>window.__pwned=1</script>' +
  '<iframe src="https://evil.example"></iframe><a href="javascript:alert(1)">bad</a>' +
  '<a href="https://ok.example">ok</a><svg onload=alert(1)></svg>';

async function noViolations(container: HTMLElement): Promise<void> {
  const results = await axe(container);
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

function expectInert(container: HTMLElement): void {
  expect(container.querySelector('img, script, iframe, svg, object, embed')).toBeNull();
  expect(container.querySelector('[onerror], [onclick], [onload], [style]')).toBeNull();
  expect(container.querySelector('a[href^="javascript"]')).toBeNull();
  expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
}

const blocking = (over: Partial<Finding> = {}): Finding => ({
  id: 'C1',
  severity: 'blocking',
  category: 'correctness',
  file: 'mathutils/core.js',
  line: 12,
  criterion: 'AC2',
  claim: 'clamp returns hi when x < lo',
  evidence: 'clamp(-1, 0, 5) is 5',
  suggested_check: 'add a test for x < lo',
  ...over,
});

async function openRun(stub: ReturnType<typeof makeApi>) {
  const view = render(<App api={stub.api} />);
  const list = await screen.findByRole('list', { name: /runs/i });
  fireEvent.click(within(list).getByRole('link'));
  return view;
}
const listWithRun = () => listOf([row({ run_id: 'r1' })]);

describe('run page', () => {
  it('shows the header, timeline, round contents, report and next steps, and is accessible', async () => {
    const stub = makeApi({
      list: listWithRun,
      detail: () =>
        detailOf({
          row: row({ run_id: 'r1', status: 'complete', stage: 'DONE' }),
          report_html: '<h1>advpipe run r1</h1><p>All good.</p>',
          next_steps: [{ label: 'Merge it', command: "git -C '/my repo' merge advpipe/x" }],
          timeline: [
            stepOf({
              stage: 'CODE',
              label: 'CODE',
              state: 'done',
              summary: '1 of 3 rounds',
              rounds: [
                roundOf({
                  title: 'Round 1',
                  outcome: 'code critic: FAIL',
                  author_html: '<p>I fixed it.</p>',
                  diff: {
                    path: 'stage-code/round-1/diff.patch',
                    total: 3005,
                    lines: [
                      { kind: 'meta', text: '+++ b/mathutils/core.js' },
                      { kind: 'add', text: '+export const x = 1;' },
                    ],
                  },
                  gates: [
                    {
                      label: 'Checks',
                      view: {
                        path: 'g',
                        readable: true,
                        passed: false,
                        line: 'test fail',
                        results: [
                          {
                            name: 'test',
                            command: 'node --test',
                            status: 'fail',
                            returncode: 1,
                            output: 'not ok 1 - clamps',
                            skip_reason: '',
                          },
                        ],
                      },
                    },
                  ],
                  critics: [
                    {
                      role: 'code critic',
                      path: 'c',
                      raw: '',
                      dropped: 1,
                      verdict: { verdict: 'FAIL', findings: [blocking()] },
                    },
                  ],
                }),
              ],
            }),
            stepOf({ stage: 'ARBITER', label: 'ARBITER', state: 'not_needed' }),
          ],
        }),
    });
    const { container } = await openRun(stub);
    await screen.findByRole('heading', { name: 'Add clamp' });
    const facts = container.querySelector('dl.facts')?.textContent ?? '';
    expect(facts).toContain('complete');
    expect(facts).toContain('Tests (3 of 5) · security scan off');
    expect(facts).toContain('$1.50 of $8.00');
    expect(facts).toContain('API-equivalent, not billed');
    expect(facts).toContain('3m 07s');
    expect(container.querySelector('.timeline-strip')?.textContent).toContain('not needed');
    expect(screen.getByText(/1 of 3 rounds/)).toBeTruthy();
    expect(screen.getByText(/code critic: FAIL/)).toBeTruthy();
    expect(container.querySelector('.diff-add')?.textContent).toContain('+export const x = 1;');
    expect(screen.getByText(/3003 more lines/)).toBeTruthy();
    expect(screen.getByLabelText('test output').textContent).toBe('not ok 1 - clamps');
    expect(screen.getByText('clamp returns hi when x < lo')).toBeTruthy();
    expect(screen.getByText('mathutils/core.js:12')).toBeTruthy();
    expect(screen.getByText(/1 finding dropped as noise/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'advpipe run r1' })).toBeTruthy();
    expect(screen.getByLabelText('Merge it').textContent).toBe("git -C '/my repo' merge advpipe/x");
    expect(screen.getByText(/advpipe never merges or pushes/)).toBeTruthy();
    await noViolations(container);
  });

  it('renders hostile text from every surface as text, and nothing else', async () => {
    const h = (i: number): string => HOSTILE[i % HOSTILE.length] ?? '';
    const stub = makeApi({
      list: listWithRun,
      detail: () =>
        detailOf({
          title: h(0),
          row: row({ run_id: 'r1', branch: h(1), stage: h(2), status: 'paused' }),
          work_item_file: h(3),
          usage: {
            login: 'subscription',
            login_label: h(0),
            cost_label: h(1),
            console: false,
            warn: '',
            note: h(2),
            meters: [
              {
                window: 'five_hour',
                label: h(3),
                percent: 5,
                text: h(4),
                status: 'allowed',
                stale: false,
                seen: 'now',
              },
            ],
          },
          report_html: HTML_ATTACK,
          next_steps: [{ label: h(0), command: h(1) }],
          decision_view: {
            decision: {
              kind: 'red_checks',
              stage: 'CODE',
              asked_at: '2026-10-15T10:00:00Z',
              explanation: h(0),
              findings: [
                blocking({
                  claim: h(1),
                  evidence: h(2),
                  file: h(3),
                  suggested_check: h(4),
                  id: h(5),
                }),
              ],
              usage: null,
              billing: false,
              choice: '',
              note: '',
              decided_at: null,
              applied: false,
            },
            choices: ['fix', 'takeover'],
            pending: [],
            fix_pass: 1,
            max_fix_passes: 3,
            retry_warning: h(1),
            add_key: '',
            add_label: '',
          },
          timeline: [
            stepOf({
              rulings_note: h(0),
              rulings: [{ finding_id: h(1), decision: 'fix', reason: h(2) }],
              task_html: HTML_ATTACK,
              rounds: [
                roundOf({
                  title: h(0),
                  outcome: h(1),
                  notice: h(2),
                  author_html: HTML_ATTACK,
                  test_fix_html: HTML_ATTACK,
                  task_html: HTML_ATTACK,
                  asked: [
                    {
                      id: 'Q1',
                      text: h(0),
                      asked_in: 1,
                      answer: h(1),
                      answered_at: null,
                      applied: false,
                      source: 'agent',
                      reasoning: h(2),
                      bypassed: false,
                    },
                  ],
                  diff: { path: h(3), total: 1, lines: [{ kind: 'add', text: h(4) }] },
                  gates: [
                    {
                      label: h(0),
                      view: {
                        path: 'p',
                        readable: true,
                        passed: false,
                        line: '',
                        results: [
                          {
                            name: h(1),
                            command: h(2),
                            status: 'fail',
                            returncode: 1,
                            output: h(3),
                            skip_reason: '',
                          },
                        ],
                      },
                    },
                  ],
                  critics: [
                    { role: h(0), path: 'p', raw: h(1), verdict: null, dropped: 0 },
                    {
                      role: h(2),
                      path: 'p',
                      raw: '',
                      dropped: 0,
                      verdict: {
                        verdict: 'FAIL',
                        findings: [blocking({ claim: h(3), evidence: h(4), id: h(5) })],
                      },
                    },
                  ],
                }),
              ],
            }),
          ],
        }),
    });
    const { container } = await openRun(stub);
    await screen.findByRole('heading', { level: 1 });
    // Open every panel so nothing hides in a closed <details>.
    container.querySelectorAll('details').forEach((d) => (d.open = true));
    expectInert(container);
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    for (const a of container.querySelectorAll('a[href]')) {
      expect(a.getAttribute('href')).toMatch(/^(?:https?:|mailto:|\/|#content)/);
    }
    // Links in markdown do nothing when clicked.
    const ok = container.querySelector('a[href="https://ok.example"]') as HTMLAnchorElement;
    expect(ok.getAttribute('rel')).toBe('noopener noreferrer');
    expect(fireEvent.click(ok)).toBe(false); // preventDefault was called
  });

  it('follows the live log: appends pushes once, hides data lines, resubscribes from nothing', async () => {
    const stub = makeApi({
      list: listWithRun,
      detail: () => detailOf({ row: row({ run_id: 'r1', status: 'running' }), live: true }),
    });
    const { unmount } = await openRun(stub);
    await waitFor(() =>
      expect(stub.fns.subscribe).toHaveBeenCalledWith({ runId: 'r1', offset: 0 }),
    );
    const line = (message: string, extra: object = {}) => ({
      ts: '2026-10-15T10:01:02.000Z',
      kind: 'agent_done' as const,
      stage: 'CODE' as const,
      round: 1,
      message,
      ...extra,
    });
    act(() => {
      stub.emit('run.log', {
        runId: 'r1',
        next_offset: 50,
        ended: false,
        lines: [line('first event'), line('the end', { final: true, kind: 'status' })],
      });
      stub.emit('run.log', {
        runId: 'other',
        next_offset: 9,
        ended: false,
        lines: [line('not mine')],
      });
    });
    await screen.findByText('first event');
    expect(screen.queryByText('the end')).toBeNull();
    expect(screen.queryByText('not mine')).toBeNull();
    act(() => {
      stub.emit('run.log', {
        runId: 'r1',
        next_offset: 50,
        ended: false,
        lines: [line('first event')],
      }); // a repeat
      stub.emit('run.log', {
        runId: 'r1',
        next_offset: 90,
        ended: false,
        lines: [line('second event')],
      });
    });
    await screen.findByText('second event');
    expect(screen.getAllByText('first event')).toHaveLength(1);
    expect(screen.getByText(/2 event\(s\)/)).toBeTruthy();
    unmount();
    expect(stub.fns.unsubscribe).toHaveBeenCalledWith({ runId: 'r1' });
  });

  it('keeps a panel open or closed across live refreshes, and says when the status changes', async () => {
    let detail = detailOf({
      row: row({ run_id: 'r1', status: 'running' }),
      live: true,
      timeline: [
        stepOf({
          rounds: [
            roundOf({ key: 'code/round-1', title: 'Round 1' }),
            roundOf({ key: 'code/round-2', title: 'Round 2' }),
          ],
        }),
      ],
    });
    const stub = makeApi({ list: listWithRun, detail: () => detail });
    const { container } = await openRun(stub);
    const panel = async (title: string) =>
      (await screen.findByText(title)).closest('details') as HTMLDetailsElement;
    expect((await panel('Round 2')).open).toBe(true); // the current step's last round
    expect((await panel('Round 1')).open).toBe(false);
    const first = await panel('Round 1');
    first.open = true;
    fireEvent(first, new Event('toggle'));
    const second = await panel('Round 2');
    second.open = false;
    fireEvent(second, new Event('toggle'));

    detail = {
      ...detail,
      row: { ...detail.row, status: 'complete' },
      live: false,
      timeline: [
        stepOf({
          state: 'done',
          rounds: [
            roundOf({ key: 'code/round-1', title: 'Round 1' }),
            roundOf({ key: 'code/round-2', title: 'Round 2' }),
            roundOf({ key: 'code/round-3', title: 'Round 3' }),
          ],
        }),
      ],
    };
    stub.emit('run.changed', { runId: 'r1' });
    await screen.findByText('Round 3', {}, { timeout: 3000 });
    expect((await panel('Round 1')).open).toBe(true);
    expect((await panel('Round 2')).open).toBe(false);
    await waitFor(() =>
      expect(container.querySelector('[role="status"].visually-hidden')?.textContent).toBe(
        'This run is now complete.',
      ),
    );
  });
});

const contextOf = (over: Partial<ContextView> = {}): ContextView => ({
  run_id: 'r1',
  status: 'complete',
  title: 'Add clamp',
  live: false,
  level: 'full',
  work_item: { text: 'add clamp', html: '<p>add clamp</p>', file: '' },
  task: {
    html: '<h2 class="task-ac">Acceptance criteria</h2><ul><li class="ac">AC1</li></ul>',
    criteria: 1,
    questions: 1,
    blocking: 1,
    sections: ['ac', 'oq'],
  },
  config: { config: null, raw: '{"bad": true}', error: '1 problem(s): nope' },
  checks: [
    { name: 'test', command: 'node --test', help: 'the test suite' },
    { name: 'lint', command: '', help: 'the linter' },
  ],
  standards: { path: 'CLAUDE.md', html: null, source: '' },
  roles: [
    {
      role: 'coder',
      name: 'coder',
      model: 'claude-opus-5-5',
      tools: ['Read', 'Edit'],
      read_only: false,
      inputs: 'task.md',
      prompt_html: '<p>You are the coder.</p>',
    },
  ],
  seen_by: {
    work_item: 'The spec writer only.',
    task_md: 'Everyone.',
    config: 'No agent.',
    checks: 'Authors.',
    standards: 'The standards reviewer.',
    prompts: 'Each role.',
  },
  answers: [],
  ...over,
});

describe('Spec & context page', () => {
  it('shows every block with who sees it, empty states and raw config, accessibly', async () => {
    const stub = makeApi({
      list: listWithRun,
      context: () => contextOf(),
      detail: () => detailOf(),
    });
    const { container } = await openRun(stub);
    fireEvent.click(await screen.findByRole('link', { name: 'Spec & context' }));
    await screen.findByRole('heading', { name: 'Work item' });
    expect(screen.getByText('The spec writer only.')).toBeTruthy();
    expect(container.querySelector('#ctx-task')?.textContent).toContain('1 acceptance criteria');
    expect(container.querySelector('#ctx-task')?.textContent).toContain('1 blocking');
    expect(screen.getByText(/Couldn't read this run's config: 1 problem\(s\): nope/)).toBeTruthy();
    expect(screen.getByText('skipped (not configured)')).toBeTruthy();
    expect(screen.getByText(/no standards doc at this path/)).toBeTruthy();
    expect(container.querySelector('#role-coder')?.textContent).toContain(
      'can edit and run commands',
    );
    await noViolations(container);
  });

  it('a run without task.md says so rather than failing', async () => {
    const stub = makeApi({
      list: listWithRun,
      detail: () => detailOf(),
      context: () => contextOf({ task: null, live: true }),
    });
    await openRun(stub);
    fireEvent.click(await screen.findByRole('link', { name: 'Spec & context' }));
    await screen.findByText(/task.md is not written yet/);
  });
});
