import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  allowed,
  parseBudget,
  STALE_MESSAGE,
  type CleanInfoView,
  type DisplayStatus,
  type RunAction,
  type RunState,
  titleOf,
} from '@advpipe/contracts';
import { AnswerError, migrate, recordAnswers, toAnswer } from '../core/answers.js';
import {
  cancelRun,
  cleanInfo,
  cleanRun,
  ControlError,
  resumeRun,
  type WorkerOptions,
} from '../core/control.js';
import { DecisionError, decide, ENDING } from '../core/decisions.js';
import { checkRunId, RunLog } from '../core/runlog.js';
import { NotResumable } from '../orchestrator/resume.js';
import { displayStatus } from './runs.js';

// What a person does to a run from its page (docs/05 §5.2.2-§5.2.5, §5.7, docs/04 §3.3): cancel,
// resume, answer, decide, clean up, and "open this in the file manager". Each one checks the run's
// displayed status against `VALID` first, in the host, so a stale page can't do what the run no
// longer allows; then it calls the engine. Port of `ui/routes/actions.py` minus the HTTP, with the
// CLI replaced by direct calls. Every message here is for a person and is shown as it is.

/** An action that can't be done; the message says why, in plain words. */
export class ActionError extends Error {
  override name = 'ActionError';
}

type Found = { log: RunLog; state: RunState; status: DisplayStatus };

function find(repo: string, runId: string): Found {
  let log: RunLog;
  try {
    log = RunLog.forRun(path.resolve(repo), checkRunId(runId));
  } catch {
    throw new ActionError(`There's no run ${runId}.`);
  }
  if (!existsSync(log.path('run.json'))) throw new ActionError(`There's no run ${runId}.`);
  try {
    const state = log.readState();
    return { log, state, status: displayStatus(state, log) };
  } catch (e) {
    throw new ActionError(`Can't read this run: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function check(repo: string, runId: string, action: RunAction): Found {
  const found = find(repo, runId);
  if (!allowed(found.status, action)) throw new ActionError(STALE_MESSAGE(found.status));
  return found;
}

const sentence = (message: string): string => (message.endsWith('.') ? message : `${message}.`);

/** Engine refusals are already plain words; other errors are bugs and pass through. */
async function refusing<T>(prefix: string, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ControlError || e instanceof NotResumable) {
      throw new ActionError(`${prefix}${sentence(e.message)}`);
    }
    if (e instanceof AnswerError || e instanceof DecisionError) {
      throw new ActionError(`${prefix}${sentence(e.message)}`);
    }
    throw e;
  }
}

/** Ask the run's worker to stop at its next safe point. The run stays resumable. */
export function cancelAction(repo: string, runId: string): { runId: string } {
  check(repo, runId, 'cancel');
  try {
    const { done } = cancelRun(repo, runId);
    // The host keeps the grace timer: if the worker hasn't stopped by then, its tree is ended.
    done.catch(() => undefined);
  } catch (e) {
    if (e instanceof ControlError)
      throw new ActionError(`Couldn't cancel it: ${sentence(e.message)}`);
    throw e;
  }
  return { runId };
}

/** Continue a stopped run in a worker, with a new total budget if `budgetText` gives one. */
export async function resumeAction(
  repo: string,
  runId: string,
  budgetText: string,
  opts: WorkerOptions = {},
): Promise<{ runId: string }> {
  const { state, status } = check(repo, runId, 'resume');
  let budget: number | null;
  try {
    budget = parseBudget(budgetText, state.cost_usd, status === 'budget_exceeded');
  } catch (e) {
    throw new ActionError(`Not resumed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await refusing("Couldn't resume it: ", () =>
    resumeRun(repo, runId, { ...opts, budgetUsd: budget }),
  );
  return { runId };
}

export type AnswerInput = {
  answers: Record<string, string>;
  bypass: readonly string[];
  bypassAll?: boolean | undefined;
};

/**
 * Save the answers to a run's blocking questions (or let the agent decide: Bypass), then resume it.
 * A ticked Bypass for a question beats any text for it; Bypass all beats everything (docs/05 §5.2.4).
 */
export async function answerAction(
  repo: string,
  runId: string,
  input: AnswerInput,
  opts: WorkerOptions = {},
): Promise<{ runId: string }> {
  const { state } = check(repo, runId, 'answer');
  const bypass = new Set(
    input.bypassAll === true ? toAnswer(migrate(state)).map((q) => q.id) : input.bypass,
  );
  const given = Object.fromEntries(Object.entries(input.answers).filter(([id]) => !bypass.has(id)));
  await refusing('Not saved: ', () => recordAnswers(repo, runId, given, bypass));
  try {
    await resumeRun(repo, runId, opts);
  } catch (e) {
    if (e instanceof ControlError || e instanceof NotResumable) {
      throw new ActionError(
        `Your answers are saved, but the run couldn't carry on: ${sentence(e.message)}`,
      );
    }
    throw e;
  }
  return { runId };
}

export type DecideInput = {
  choice: string;
  note?: string | undefined;
  confirm?: boolean | undefined;
};

/**
 * Record the person's choice at the run's decision point. A choice that ends the run (take over,
 * stop, finish) is done at once and only with `confirm`; the others resume the run in a worker.
 */
export async function decideAction(
  repo: string,
  runId: string,
  input: DecideInput,
  opts: WorkerOptions = {},
): Promise<{ runId: string; resumed: boolean }> {
  check(repo, runId, 'decide');
  const choice = input.choice.trim().toLowerCase();
  if (ENDING.has(choice) && input.confirm !== true) {
    throw new ActionError('Not done: that needs confirming first.');
  }
  await refusing('Not sent: ', () => decide(repo, runId, choice, (input.note ?? '').trim()));
  if (ENDING.has(choice)) return { runId, resumed: false };
  try {
    await resumeRun(repo, runId, opts);
  } catch (e) {
    if (e instanceof ControlError || e instanceof NotResumable) {
      throw new ActionError(
        `Your choice is saved, but the run couldn't carry on: ${sentence(e.message)}`,
      );
    }
    throw e;
  }
  return { runId, resumed: true };
}

// ── clean up ────────────────────────────────────────────────────────────────────────────────────

/** What cleaning a run up would remove: the confirmation page's text. */
export async function cleanInfoAction(repo: string, runId: string): Promise<CleanInfoView> {
  const found = find(repo, runId);
  const { state, status } = found;
  if (!allowed(status, 'clean')) {
    throw new ActionError(
      "Can't clean up this run. " +
        (status === 'running'
          ? 'This one is still running: cancel it first.'
          : status === 'complete'
            ? "This one is complete: its branch is the result. Delete it with git once you've merged it."
            : STALE_MESSAGE(status)),
    );
  }
  const info = await cleanInfo(repo, state);
  return {
    run_id: runId,
    title: titleOf(state.work_item, 120),
    status,
    refusal: info.refusal,
    worktree: info.worktree,
    branch: info.branch,
    unmerged_commits: info.unmerged_commits,
    dirty_finished: info.dirty_finished,
    base: state.base_commit.slice(0, 12),
  };
}

/** Remove the run's working copy and branch (and its log, if asked). `force` is "Delete anyway". */
export async function cleanAction(
  repo: string,
  runId: string,
  opts: { force: boolean; logs: boolean },
): Promise<string[]> {
  check(repo, runId, 'clean');
  return refusing('', () => cleanRun(repo, runId, opts));
}

// ── open in the file manager ────────────────────────────────────────────────────────────────────

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

function insideOf(parent: string, child: string): boolean {
  const rel = path.relative(real(parent), real(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The path to show in the file manager: derived here from the run, never given by the window, and
 * only if it is under `<repo>/.advpipe/` (the working copy under `.advpipe/worktrees/`) whatever
 * run.json says (docs/08 §5).
 */
export function revealPath(
  repo: string,
  runId: string,
  what: 'worktree' | 'runDir' | 'report',
): string {
  const { log, state } = find(repo, runId);
  const advpipe = path.join(path.resolve(repo), '.advpipe');
  let target: string;
  if (what === 'worktree') {
    if (state.worktree === '' || state.worktree_removed || !existsSync(state.worktree)) {
      throw new ActionError("This run's working copy isn't there any more.");
    }
    if (!insideOf(path.join(advpipe, 'worktrees'), state.worktree)) {
      throw new ActionError(
        "This run's working copy isn't under .advpipe/worktrees; not opening it.",
      );
    }
    target = state.worktree;
  } else if (what === 'report') {
    target = log.path('report.md');
    if (!existsSync(target)) throw new ActionError('This run has no report.md yet.');
  } else {
    target = log.root;
  }
  if (!insideOf(advpipe, target))
    throw new ActionError("That isn't inside .advpipe/; not opening it.");
  return target;
}
