import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '@advpipe/contracts';
import {
  BRANCH_PREFIX,
  describeAll,
  levelTag,
  StartRequest,
  type RunState,
  type StartResume,
  type StartRun,
} from '@advpipe/contracts';
import { checkResumable } from '../orchestrator/resume.js';
import { awaitingAnswers, maxSpecPasses, pendingQuestions } from './answers.js';
import { awaitingDecision } from './decisions.js';
import { loadConfig } from './config.js';
import { emit } from './events.js';
import { git } from './git.js';
import { withGitLock } from './gitlock.js';
import { killTree, looksLikeWorker } from './proc.js';
import { renderReport } from './report.js';
import { pidAlive, RunLog } from './runlog.js';
import { branchExists, unmergedCommits } from './workspace.js';

// Managing runs from outside the process that drives them (docs/04 §3, docs/02 §15): start a
// detached worker, cancel it, clean up after it. The host calls these; they never call an agent.
// Worker and host talk only through files in the run directory.

export const CONSOLE_LOG = 'console.log';
export const CANCEL_FILE = 'cancel';
export const START_FILE = 'start.json';
/** How long a worker gets to stop at a safe point after a cancel before its process tree is ended. */
export const CANCEL_GRACE_MS = 10_000;

/** The requested action isn't safe or possible for this run; the message is for a person. */
export class ControlError extends Error {
  override name = 'ControlError';
}

/** The worker entry beside the built engine (`dist/src/worker.js`). A packaged app passes its own path. */
export function defaultWorkerEntry(): string {
  return fileURLToPath(new URL('../worker.js', import.meta.url));
}

/**
 * `config` with a run request's settings in its [pipeline] table (and its budget), so the run's
 * config.json records what it runs under. The same function on both sides of start.json, so the
 * worker applies exactly what the host showed.
 */
export function effectiveConfig(config: Config, request: StartRun): Config {
  const limits =
    request.budget_usd !== null
      ? { ...config.limits, budget_usd_per_task: request.budget_usd }
      : config.limits;
  return {
    ...config,
    limits,
    pipeline: {
      ...config.pipeline,
      level: request.level,
      security_scan: request.security_scan,
      scan_failures: request.scan_failures,
      bypass_questions: request.bypass_questions,
    },
  };
}

export type WorkerOptions = {
  /** The worker script; default `defaultWorkerEntry()`. */
  workerEntry?: string;
  /** What runs it; default this process (Electron's binary runs as plain Node, below). */
  execPath?: string;
  /** Extra environment for the worker, on top of ours. */
  env?: Record<string, string | undefined>;
};

/**
 * Start `request` in a detached worker that logs to console.log, and return its pid.
 *
 * The request goes in start.json (never on the command line). The worker gets its own session, so
 * closing the app doesn't stop it, and its pid goes into run.lock straight away, so Cancel works
 * before the worker has started up. A stale `cancel` file is removed first: it would stop the run
 * the moment it started.
 */
export function startWorker(
  runlog: RunLog,
  request: StartRequest,
  opts: WorkerOptions = {},
): number {
  const checked = StartRequest.parse(request);
  const holder = runlog.lockHolder();
  if (holder !== null) {
    throw new ControlError(`run ${checked.run_id} is still being driven (pid ${holder})`);
  }
  mkdirSync(runlog.root, { recursive: true });
  runlog.writeText(START_FILE, JSON.stringify(checked, null, 2));
  rmSync(runlog.path(CANCEL_FILE), { force: true });
  const fd = openSync(runlog.path(CONSOLE_LOG), 'a');
  let pid: number | undefined;
  try {
    const child = spawn(
      opts.execPath ?? process.execPath,
      [opts.workerEntry ?? defaultWorkerEntry(), '--start', runlog.path(START_FILE)],
      {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...opts.env },
      },
    );
    child.on('error', () => undefined); // a failed spawn has no pid: reported below
    child.unref();
    pid = child.pid;
  } finally {
    closeSync(fd);
  }
  if (pid === undefined)
    throw new ControlError(`couldn't start a worker for run ${checked.run_id}`);
  runlog.acquireLock(pid);
  return pid;
}

/**
 * Start a new run in a worker. Writes the run's effective config.json first, so the UI can show
 * the run's settings at once. `opts.config` replaces loading it from `request.config_path` (else
 * `<repo>/pipeline.toml`, else the defaults).
 */
export function startRun(
  repo: string,
  request: StartRun,
  opts: WorkerOptions & { config?: Config } = {},
): { runId: string; pid: number } {
  const root = path.resolve(repo);
  const runlog = RunLog.forRun(root, request.run_id);
  if (existsSync(runlog.path('run.json'))) {
    throw new ControlError(`run ${request.run_id} already exists in ${root}`);
  }
  const base =
    opts.config ??
    loadConfig({
      repo: root,
      ...(request.config_path !== null ? { file: request.config_path } : {}),
    }).config;
  mkdirSync(runlog.root, { recursive: true });
  runlog.writeConfig(effectiveConfig(base, request));
  const pid = startWorker(runlog, { ...request, repo: root }, opts);
  return { runId: request.run_id, pid };
}

/**
 * Resume a run in a worker. Refuses, before starting anything, a run that can't be resumed now
 * (it is complete, waits for a decision or answers, ended, or a live process drives it).
 */
export async function resumeRun(
  repo: string,
  runId: string,
  opts: WorkerOptions & { budgetUsd?: number | null } = {},
): Promise<{ runId: string; pid: number }> {
  const root = path.resolve(repo);
  await checkResumable(root, runId); // throws NotResumable, in plain words
  const request: StartResume = {
    command: 'resume',
    run_id: runId,
    repo: root,
    budget_usd: opts.budgetUsd ?? null,
    locked_for_me: true,
  };
  return { runId, pid: startWorker(RunLog.forRun(root, runId), request, opts) };
}

// ── cancel ──────────────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a cancel has been asked for: the worker's 500 ms poll looks for this file. */
export const cancelRequested = (runlog: RunLog): boolean => existsSync(runlog.path(CANCEL_FILE));

/**
 * After the grace period, end a worker that hasn't stopped: its process tree goes, the stale lock
 * and `cancel` file are removed, and a note says so. The run keeps its status (`running`), so it
 * can be resumed.
 */
async function forceStop(runlog: RunLog, pid: number): Promise<void> {
  killTree(pid);
  for (let i = 0; i < 100 && pidAlive(pid); i++) await sleep(50);
  runlog.releaseLock();
  rmSync(runlog.path(CANCEL_FILE), { force: true });
  if (!existsSync(runlog.path('run.json'))) return; // it never got as far as writing a state
  try {
    runlog.acquireLock();
  } catch {
    return; // something else took the run already
  }
  try {
    const state = runlog.readState();
    state.notes.push(`Interrupted during ${state.stage} (forced stop)`);
    runlog.writeState(state);
    runlog.writeText(
      'report.md',
      renderReport(state, { waitingOnAnswers: awaitingAnswers(state, maxSpecPasses(runlog)) }),
    );
    emit(
      runlog,
      state,
      () => undefined,
      'status',
      'interrupted (forced stop); press Resume to continue',
      { status: state.status, final: true, total_usd: state.cost_usd },
      false,
    );
  } finally {
    runlog.releaseLock();
  }
}

/**
 * Ask the worker driving a run to stop at its next safe point. Returns its pid at once; `done`
 * settles when it has (`forced`: it hadn't stopped after `graceMs`, so its process tree was ended).
 * Either way the run is left `running` with "Interrupted during <stage>" in its notes: resumable.
 */
export function cancelRun(
  repo: string,
  runId: string,
  opts: { graceMs?: number; pollMs?: number } = {},
): { pid: number; done: Promise<{ forced: boolean }> } {
  const runlog = RunLog.forRun(path.resolve(repo), runId);
  if (!existsSync(runlog.root)) throw new ControlError(`no run ${runId}`);
  const pid = runlog.lockHolder();
  if (pid === null) throw new ControlError(`run ${runId} is not active; nothing to cancel`);
  if (!looksLikeWorker(pid)) {
    throw new ControlError(`run.lock names pid ${pid}, which isn't an advpipe worker`);
  }
  runlog.writeText(CANCEL_FILE, '');
  const deadline = Date.now() + (opts.graceMs ?? CANCEL_GRACE_MS);
  const done = (async (): Promise<{ forced: boolean }> => {
    while (runlog.lockHolder() === pid) {
      if (Date.now() >= deadline) {
        await forceStop(runlog, pid);
        return { forced: true };
      }
      await sleep(opts.pollMs ?? 100);
    }
    rmSync(runlog.path(CANCEL_FILE), { force: true });
    return { forced: false };
  })();
  return { pid, done };
}

// ── clean ───────────────────────────────────────────────────────────────────────────────────────

/** What cleaning a run up would do, for the confirmation page (docs/05 §5.7). */
export type CleanInfo = {
  run_id: string;
  /** Why this run can't be cleaned up at all (complete, active); null when it can. */
  refusal: string | null;
  /** The working copy, if it is still on disk. */
  worktree: string | null;
  /** The run's branch, if it still exists. */
  branch: string | null;
  /** Commits only this branch has: lost if it's deleted. */
  unmerged_commits: number;
  /** A finished-as-is run whose working copy holds uncommitted work. */
  dirty_finished: boolean;
};

/** `child` is `parent` or inside it (symlinks resolved where the paths exist). */
function isInside(parent: string, child: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const rel = path.relative(real(parent), real(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

type Inspection = {
  info: CleanInfo;
  top: string;
  state: RunState;
  /** Refusals that `force` (Delete anyway) overrides. */
  forceable: string[];
  /** Refusals nothing overrides. */
  fatal: string | null;
};

async function inspect(repo: string, runlog: RunLog, state: RunState): Promise<Inspection> {
  const runId = state.run_id;
  const top = path.resolve((await git(repo, 'rev-parse', '--show-toplevel')).trim());
  const info: CleanInfo = {
    run_id: runId,
    refusal: null,
    worktree: null,
    branch: null,
    unmerged_commits: 0,
    dirty_finished: false,
  };
  const forceable: string[] = [];
  const out = (fatal: string | null): Inspection => {
    info.refusal = fatal;
    return { info, top, state, forceable, fatal };
  };
  if (state.status === 'complete') {
    return out(
      `run ${runId} is complete: branch ${state.branch} is its result. ` +
        "Delete it with git once you're done with it.",
    );
  }
  const holder = runlog.lockHolder();
  if (holder !== null) {
    return out(`run ${runId} is active (pid ${holder}); cancel it first`);
  }
  // Whatever run.json says, only touch a worktree under .advpipe/worktrees and an advpipe/ branch.
  const worktree = state.worktree !== '' ? state.worktree : null;
  if (worktree !== null && !isInside(path.join(top, '.advpipe', 'worktrees'), worktree)) {
    return out(`worktree ${worktree} isn't under .advpipe/worktrees; not touching it`);
  }
  const branch = state.branch !== '' && (await branchExists(top, state.branch)) ? state.branch : '';
  if (branch !== '' && !branch.startsWith(BRANCH_PREFIX)) {
    return out(`branch ${branch} isn't an ${BRANCH_PREFIX} branch; not touching it`);
  }
  if (worktree !== null && existsSync(worktree)) {
    info.worktree = worktree;
    if (state.ended_by === 'finish' && (await git(worktree, 'status', '--porcelain')).trim()) {
      // A run finished as is keeps its uncommitted work on purpose; cleaning would lose it.
      info.dirty_finished = true;
      forceable.push(
        `run ${runId} was finished as is: its worktree ${worktree} has uncommitted changes ` +
          `that cleaning up would delete. Look at them with: git -C ${worktree} status  ` +
          'Tick *Delete anyway* to delete them.',
      );
    }
  }
  if (branch !== '') {
    info.branch = branch;
    info.unmerged_commits = await unmergedCommits(top, branch);
    if (info.unmerged_commits > 0) {
      const since = state.base_commit ? `${state.base_commit.slice(0, 12)}..` : '';
      forceable.push(
        `branch ${branch} has ${info.unmerged_commits} commit(s) that no other branch has. ` +
          `Look at them with: git log --oneline ${since}${branch}  ` +
          'Tick *Delete anyway* to delete them.',
      );
    }
  }
  return out(null);
}

function readRun(repo: string, runId: string): { runlog: RunLog; state: RunState } {
  const runlog = RunLog.forRun(repo, runId);
  if (!existsSync(runlog.path('run.json'))) throw new ControlError(`no run ${runId}`);
  return { runlog, state: runlog.readState() };
}

/** What cleaning `state`'s run would remove, and why it might be refused. */
export async function cleanInfo(repo: string, state: RunState): Promise<CleanInfo> {
  const root = path.resolve(repo);
  return (await inspect(root, RunLog.forRun(root, state.run_id), state)).info;
}

/**
 * Remove a dead run's worktree and branch (and its run directory if `logs`).
 *
 * Refuses complete runs (their branch is the result) and active runs (`force` doesn't override),
 * and without `force` a finished-as-is run's uncommitted work and a branch with commits no other
 * branch has. Every check runs before anything is deleted. Returns what was done, as lines.
 */
export async function cleanRun(
  repo: string,
  runId: string,
  opts: { force?: boolean; logs?: boolean } = {},
): Promise<string[]> {
  const root = path.resolve(repo);
  const { runlog, state } = readRun(root, runId);
  const found = await inspect(root, runlog, state);
  if (found.fatal !== null) throw new ControlError(found.fatal);
  const refused = found.forceable[0];
  if (!opts.force && refused !== undefined) throw new ControlError(refused);

  const { top, info } = found;
  const done: string[] = [];
  await withGitLock(top, async () => {
    if (info.worktree !== null) {
      await git(top, 'worktree', 'remove', '--force', info.worktree);
      done.push(`removed worktree ${info.worktree}`);
    }
    await git(top, 'worktree', 'prune');
    if (info.branch !== null) {
      await git(top, 'branch', '-D', info.branch);
      done.push(`deleted branch ${info.branch}`);
    }
  });
  if (opts.logs) {
    rmSync(runlog.root, { recursive: true, force: true });
    done.push(`deleted run log ${runlog.root}`);
  } else {
    state.worktree_removed = true;
    state.notes.push('Cleaned up: ' + (done.join('; ') || 'nothing left to remove'));
    runlog.writeState(state);
    runlog.writeText('report.md', renderReport(state));
  }
  return done.length > 0 ? done : ['nothing to remove'];
}

// ── the worker's one-line summary ───────────────────────────────────────────────────────────────

/** What a worker prints to console.log when its run stops (Python `_summary`, minus CLI hints). */
export function summaryLines(state: RunState, runlog: RunLog): string[] {
  const tag = levelTag(state);
  // A subscription login isn't billed per call, so its dollar figure is an estimate.
  const estimate = state.auth === 'subscription' ? ' (API-equivalent)' : '';
  const lines = [
    `${state.run_id}  ${state.status}  $${state.cost_usd.toFixed(2)}${estimate}  ${state.branch}` +
      (tag ? `  [${tag}]` : ''),
  ];
  if (state.auth === 'subscription' && Object.keys(state.rate_limits).length > 0) {
    lines.push(`  usage, last known: ${describeAll(state.rate_limits).join('; ')}`);
  }
  if (awaitingAnswers(state, maxSpecPasses(runlog))) {
    const n = pendingQuestions(state).length;
    lines.push(`  ${n} blocking question${n === 1 ? '' : 's'}: answer them on the run's page`);
  }
  if (awaitingDecision(state)) lines.push(`  ${state.decisions.at(-1)?.explanation ?? ''}`);
  lines.push(`  report: ${runlog.path('report.md')}`);
  return lines;
}

/** Re-exported for the host: a run whose `cancel` file and lock were left by a killed worker. */
export function clearStaleFiles(runlog: RunLog): void {
  if (runlog.lockHolder() === null) {
    runlog.releaseLock();
    rmSync(runlog.path(CANCEL_FILE), { force: true });
  }
}
