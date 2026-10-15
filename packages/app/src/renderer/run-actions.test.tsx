// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { DecisionViewData, OpenQuestion, RunDetail } from '@advpipe/contracts';
import { App } from './app/App.js';
import { cleanInfoOf, detailOf, listOf, makeApi, ok, row } from './test-support.js';

afterEach(cleanup);
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { value: () => null });

const HOSTILE = '<img src=x onerror=alert(1)><script>window.__pwned=1</script>';

const question = (id: string, text: string, over: Partial<OpenQuestion> = {}): OpenQuestion => ({
  id,
  text,
  asked_in: 1,
  answer: '',
  answered_at: null,
  applied: false,
  source: 'person',
  reasoning: '',
  bypassed: false,
  ...over,
});

const decisionView = (over: Partial<DecisionViewData> = {}): DecisionViewData => ({
  decision: {
    kind: 'red_checks',
    stage: 'CODE',
    asked_at: '2026-10-15T10:00:00Z',
    explanation: 'The checks are still failing at CODE (test).',
    findings: [],
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
  retry_warning: '',
  add_key: '',
  add_label: '',
  ...over,
});

async function openRun(detail: () => RunDetail, run: Record<string, unknown> = {}) {
  const stub = makeApi({
    list: () => listOf([row({ run_id: 'r1' })]),
    detail,
    run,
  });
  render(<App api={stub.api} />);
  fireEvent.click(within(await screen.findByRole('list', { name: /runs/i })).getByRole('link'));
  return stub;
}

const needsAnswers = (questions: OpenQuestion[]) =>
  detailOf({
    row: row({ run_id: 'r1', status: 'needs_answers', stage: 'SPEC' }),
    actions: ['answer', 'clean'],
    questions,
  });

describe('the answer form', () => {
  const two = [question('Q1', 'Round half-up?'), question('Q2', 'Refunds after 90 days?')];

  it('sends what was typed; a ticked "let the agent decide" beats the text; typed text survives a refresh', async () => {
    const answer = vi.fn(async () => ok({ runId: 'r1' }));
    const stub = await openRun(() => needsAnswers(two), { answer });
    const q1 = await screen.findByLabelText(/Round half-up/);
    fireEvent.change(q1, { target: { value: 'Half-up.' } });
    fireEvent.change(screen.getByLabelText(/Refunds after 90 days/), {
      target: { value: 'ignored' },
    });
    fireEvent.click(screen.getByLabelText(/Let the agent decide Q2/));

    // A live refresh replaces the run's data; what was typed stays.
    await act(async () => stub.emit('run.changed', { runId: 'r1' }));
    await waitFor(() => expect(stub.fns.runsDetail.mock.calls.length).toBeGreaterThan(1), {
      timeout: 2000,
    });
    expect((screen.getByLabelText(/Round half-up/) as HTMLInputElement).value).toBe('Half-up.');

    fireEvent.click(screen.getByRole('button', { name: 'Save answers and continue' }));
    await waitFor(() => expect(answer).toHaveBeenCalled());
    expect(answer).toHaveBeenCalledWith({
      runId: 'r1',
      answers: { Q1: 'Half-up.' },
      bypass: ['Q2'],
    });
  });

  it('Bypass all beats everything, and a refusal is shown with the answers intact', async () => {
    const answer = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'Not saved: the answer to Q1 is empty.' })
      .mockResolvedValueOnce(ok({ runId: 'r1' }));
    await openRun(() => needsAnswers(two), { answer });
    fireEvent.change(await screen.findByLabelText(/Refunds after 90 days/), {
      target: { value: 'Yes.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save answers and continue' }));
    expect(await screen.findByText('Not saved: the answer to Q1 is empty.')).toBeTruthy();
    expect(answer).toHaveBeenLastCalledWith({
      runId: 'r1',
      answers: { Q1: '', Q2: 'Yes.' },
      bypass: [],
    });
    expect((screen.getByLabelText(/Refunds after 90 days/) as HTMLInputElement).value).toBe('Yes.');

    fireEvent.click(screen.getByRole('button', { name: 'Bypass all and continue' }));
    await waitFor(() => expect(answer).toHaveBeenCalledTimes(2));
    expect(answer).toHaveBeenLastCalledWith({
      runId: 'r1',
      answers: {},
      bypass: ['Q1', 'Q2'],
      bypassAll: true,
    });
  });

  it('shows question text as text and has no accessibility violations', async () => {
    await openRun(() => needsAnswers([question('Q1', HOSTILE)]));
    await screen.findByLabelText(/onerror/);
    const main = document.querySelector('main') as HTMLElement;
    expect(main.querySelector('img, script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect((await axe(main)).violations.map((v) => v.id)).toEqual([]);
  });
});

describe('the decision panel', () => {
  const red = (view: DecisionViewData) =>
    detailOf({
      row: row({ run_id: 'r1', status: 'needs_decision', stage: 'CODE' }),
      actions: ['decide', 'clean'],
      decision_view: view,
    });

  it('sends a fix with the note; take over goes to its own page, which asks first', async () => {
    const decide = vi.fn(async () => ok({ runId: 'r1', resumed: true }));
    await openRun(() => red(decisionView()), { decide });
    expect(await screen.findByText('Fix pass 1 of 3.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/A note for the author/), {
      target: { value: 'keep the signature' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Another fix pass' }));
    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide).toHaveBeenCalledWith({ runId: 'r1', choice: 'fix', note: 'keep the signature' });

    fireEvent.click(screen.getByRole('link', { name: /I'll take over/ }));
    const safe = await screen.findByRole('button', { name: 'Keep it waiting' });
    expect(safe).toBe(document.activeElement); // the safe button is first and focused
    expect(decide).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
    expect(decide).toHaveBeenLastCalledWith({ runId: 'r1', choice: 'takeover', confirm: true });
  });

  it('disables the fix when every pass is used, and says so', async () => {
    await openRun(() => red(decisionView({ fix_pass: 4 })));
    expect(
      ((await screen.findByRole('button', { name: 'Another fix pass' })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/All 3 fix passes are used/)).toBeTruthy();
  });

  it('a usage limit opens only a named link, and Try again is a plain button', async () => {
    const openLink = vi.fn(async () => ok({ ok: true }));
    const decide = vi.fn(async () => ok({ runId: 'r1', resumed: true }));
    const view = decisionView({
      decision: {
        ...decisionView().decision,
        kind: 'usage_limit',
        explanation: 'The window ran out.',
      },
      choices: ['retry', 'finish'],
      retry_warning: 'If the limit is still in force, the run will pause again.',
      add_key: 'add_usage',
      add_label: 'Add extra usage',
    });
    await openRun(
      () =>
        detailOf({
          row: row({ run_id: 'r1', status: 'paused' }),
          actions: ['decide', 'clean'],
          decision_view: view,
        }),
      { openLink, decide },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add extra usage' }));
    expect(openLink).toHaveBeenCalledWith({ key: 'add_usage' });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith({ runId: 'r1', choice: 'retry' }));
    expect(screen.getByRole('link', { name: /Finish as is/ })).toBeTruthy();
  });

  it('shows explanations as text and has no accessibility violations', async () => {
    const view = decisionView({
      decision: { ...decisionView().decision, explanation: HOSTILE },
    });
    await openRun(() => red(view));
    await screen.findByText(HOSTILE);
    const main = document.querySelector('main') as HTMLElement;
    expect(main.querySelector('img, script')).toBeNull();
    expect((await axe(main)).violations.map((v) => v.id)).toEqual([]);
  });
});

describe('resume, cancel and clean up', () => {
  it('an over-budget run asks for a bigger total, prefilled with a suggestion', async () => {
    const resume = vi.fn(async () => ok({ runId: 'r1' }));
    await openRun(
      () =>
        detailOf({
          row: row({ run_id: 'r1', status: 'budget_exceeded', cost_usd: 8.2, budget_usd: 8 }),
          actions: ['resume', 'clean'],
          suggested_budget: 16,
        }),
      { resume },
    );
    const budget = await screen.findByLabelText(/New budget/);
    expect((budget as HTMLInputElement).value).toBe('16');
    expect((budget as HTMLInputElement).required).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith({ runId: 'r1', budget: '16' }));
  });

  it('cancel asks first, with the safe choice focused', async () => {
    const cancel = vi.fn(async () => ok({ runId: 'r1' }));
    await openRun(
      () =>
        detailOf({
          row: row({ run_id: 'r1', status: 'running' }),
          live: true,
          actions: ['cancel'],
        }),
      { cancel },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    expect(await screen.findByRole('button', { name: 'Keep it running' })).toBe(
      document.activeElement,
    );
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the run' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith({ runId: 'r1' }));
  });

  it('the clean-up page says what goes, needs "delete anyway" for unmerged work, and sends confirm', async () => {
    const clean = vi.fn(async () => ok({ lines: ['removed worktree'] }));
    const cleanInfo = vi.fn(async () => ok(cleanInfoOf({ unmerged_commits: 2 })));
    await openRun(
      () =>
        detailOf({
          row: row({ run_id: 'r1', status: 'stopped' }),
          actions: ['resume', 'clean'],
        }),
      { clean, cleanInfo },
    );
    fireEvent.click(await screen.findByRole('link', { name: 'Clean up…' }));
    expect(await screen.findByText(/that no other branch has/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep it' })).toBe(document.activeElement);
    fireEvent.click(screen.getByLabelText(/Delete anyway/));
    fireEvent.click(screen.getByLabelText(/Also delete the run's log/));
    fireEvent.click(screen.getByRole('button', { name: 'Clean it up' }));
    await waitFor(() => expect(clean).toHaveBeenCalled());
    expect(clean).toHaveBeenCalledWith({ runId: 'r1', force: true, logs: true, confirm: true });
  });
});
