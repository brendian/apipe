import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { RESUMABLE, scanOn, type Config, type RunState } from '@advpipe/contracts';
import {
  awaitingDecision,
  decisionReady,
  endedMessage,
  waitingMessage,
} from '../core/decisions.js';
import type { Explicit } from '../core/config.js';
import { isThisProcess, RunLog } from '../core/runlog.js';
import { branchExists } from '../core/workspace.js';

/** A run that can't be resumed now; the message says why, in plain words. */
export class NotResumable extends Error {
  override name = 'NotResumable';
}

/** `YYYYMMDD-HHMMSS-<6 hex>` (UTC). */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

async function checkBranch(repo: string, state: RunState): Promise<void> {
  let exists = false;
  try {
    exists = state.branch !== '' && (await branchExists(repo, state.branch));
  } catch {
    // git failed: treat the branch as gone
  }
  if (!exists) {
    throw new NotResumable(
      `run ${state.run_id} can't be resumed: its branch ${state.branch} no longer exists`,
    );
  }
}

/**
 * The run's state, if it can be resumed now; throws NotResumable saying why not. `lockedForMe`: a
 * run.lock naming this process is expected, because the host wrote this (child) process's pid there
 * before starting it.
 *
 * M4 covers `running`, `error` and `budget_exceeded` runs and a `needs_human` run whose decision is
 * made. Resuming after answers (and `migrate`) arrives with `answers.ts` in M5.
 */
export async function checkResumable(
  repo: string,
  runId: string,
  opts: { lockedForMe?: boolean } = {},
): Promise<RunState> {
  const runlog = RunLog.forRun(path.resolve(repo), runId);
  if (!existsSync(runlog.path('run.json'))) throw new NotResumable(`no run ${runId} in ${repo}`);
  const state = runlog.readState();
  if (state.status === 'needs_human') {
    if (state.ended_by) throw new NotResumable(endedMessage(state));
    if (awaitingDecision(state)) throw new NotResumable(waitingMessage(state));
    if (decisionReady(state)) {
      await checkBranch(repo, state);
    } else {
      const pending = state.questions.filter((q) => !q.answer && !q.bypassed);
      if (pending.length > 0) {
        throw new NotResumable(
          `run ${runId} is waiting on answers to ${pending.map((q) => q.id).join(', ')}: ` +
            "answer them on the run's page",
        );
      }
      throw new NotResumable(`run ${runId} is ${state.status}; nothing to resume`);
    }
  } else if (!RESUMABLE.has(state.status)) {
    throw new NotResumable(`run ${runId} is ${state.status}; nothing to resume`);
  }
  const holder = runlog.lockHolder();
  if (holder !== null && !(opts.lockedForMe && isThisProcess(holder))) {
    throw new NotResumable(`run ${runId} is still being driven by pid ${holder}`);
  }
  return state;
}

/**
 * A resumed run keeps its level, scan setting and Bypass setting: throws NotResumable if `config`
 * explicitly sets any of them to something else. `explicit` says which keys the config file set.
 */
export function checkSameShape(state: RunState, config: Config, explicit: Explicit): void {
  const asked = explicit['pipeline'] ?? new Set<string>();
  const pipeline = config.pipeline;
  if (asked.has('level') && pipeline.level !== state.level) {
    throw new NotResumable(
      `run ${state.run_id} is at level ${state.level}; a resumed run keeps its level. ` +
        'Start a new run to change it',
    );
  }
  if (asked.has('bypass_questions') && pipeline.bypass_questions !== state.bypass_questions) {
    const now = state.bypass_questions ? 'bypassed up front' : 'asked as usual';
    throw new NotResumable(
      `run ${state.run_id} has its blocking questions ${now}; a resumed run keeps that. ` +
        'Start a new run to change it',
    );
  }
  const scan = pipeline.security_scan;
  if (asked.has('security_scan') && scan !== null && scan !== scanOn(state)) {
    const now = scanOn(state) ? 'on' : 'off';
    throw new NotResumable(
      `run ${state.run_id} has the security scan ${now}; a resumed run keeps that. ` +
        'Start a new run to change it',
    );
  }
}
