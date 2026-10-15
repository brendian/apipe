import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  FILTER_KEYS,
  FILTERS,
  isValidRunId,
  STAGE_LABELS,
  titleOf,
  type Config,
  type DisplayStatus,
  type FilterKey,
  type RunList,
  type RunRow,
  type RunState,
  type Starting,
} from '@advpipe/contracts';
import { answersReady, awaitingAnswers, maxSpecPasses, migrate } from '../core/answers.js';
import { awaitingDecision, decisionReady } from '../core/decisions.js';
import { CONSOLE_LOG } from '../core/control.js';
import { checkRunId, RunLog, runsDir } from '../core/runlog.js';

// What the runs list and a run's header show, read from `.advpipe/runs/` (files are the source of
// truth). Port of `ui/runs.py`. Status is derived here, never in the window.

/**
 * The status a person sees. The first rule that matches wins (docs/05 §6): a live process holding
 * run.lock means running, whatever run.json says yet (a resume that hasn't written "running").
 */
export function displayStatus(state: RunState, runlog: RunLog): DisplayStatus {
  if (runlog.lockHolder() !== null) return 'running';
  if (state.status === 'running') return 'stopped';
  if (state.status === 'needs_human') {
    if (state.ended_by === 'takeover') return 'handed_over';
    if (state.ended_by === 'finish') return 'finished';
    if (state.ended_by) return 'ended';
    if (awaitingDecision(state)) {
      return state.decisions.at(-1)?.kind === 'usage_limit' ? 'paused' : 'needs_decision';
    }
    if (decisionReady(state)) return 'stopped'; // a choice is made; resuming applies it
    const current = migrate(state);
    const cap = maxSpecPasses(runlog);
    if (awaitingAnswers(current, cap) || answersReady(current, cap)) return 'needs_answers';
  }
  return state.status;
}

export function readConfig(runlog: RunLog): Config | null {
  try {
    return runlog.readConfig();
  } catch {
    return null;
  }
}

/** `CODE r2/3`: the stage, plus the round and its cap during the author/critic loops. */
export function stageLabel(state: RunState, config: Config | null): string {
  let label: string = STAGE_LABELS[state.stage] ?? state.stage;
  if ((state.stage === 'TESTS' || state.stage === 'CODE') && state.round) {
    label += ` r${state.round}`;
    if (config) {
      const { max_rounds_tests, max_rounds_code } = config.limits;
      label += `/${state.stage === 'TESTS' ? max_rounds_tests : max_rounds_code}`;
    }
  }
  return label;
}

export function rowOf(runId: string, state: RunState, runlog: RunLog): RunRow {
  const config = readConfig(runlog);
  return {
    run_id: runId,
    status: displayStatus(state, runlog),
    title: titleOf(state.work_item),
    branch: state.branch,
    stage: stageLabel(state, config),
    cost_usd: state.cost_usd,
    budget_usd: config?.limits.budget_usd_per_task ?? null,
    started_at: state.started_at,
    work_item_file: state.work_item_file,
    level: state.level,
  };
}

/**
 * Every run in `repo`, newest first, filtered by `show`. A run.json that can't be read (damaged,
 * or from something older) is listed in `unreadable` instead of breaking the list.
 */
export function loadRuns(repo: string, show: FilterKey = 'all'): RunList {
  const rows: RunRow[] = [];
  const unreadable: RunList['unreadable'] = [];
  const root = runsDir(repo);
  let names: string[] = [];
  try {
    names = readdirSync(root).sort();
  } catch {
    // no runs yet
  }
  for (const name of names) {
    if (!isValidRunId(name) || !existsSync(path.join(root, name, 'run.json'))) continue;
    const runlog = new RunLog(path.join(root, name));
    try {
      rows.push(rowOf(name, runlog.readState(), runlog));
    } catch (e) {
      unreadable.push({ run_id: name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  rows.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  const count = (key: FilterKey): number =>
    rows.filter((r) => FILTERS[key].statuses.has(r.status)).length;
  return {
    rows: rows.filter((r) => FILTERS[show].statuses.has(r.status)),
    counts: {
      all: count('all'),
      running: count('running'),
      needs_you: count('needs_you'),
      complete: count('complete'),
    },
    unreadable,
  };
}

export const FILTER_ORDER = FILTER_KEYS;

const TAIL_LINES = 40;
const TAIL_CHARS = 4_000;

/**
 * The starting-up view of a run whose worker hasn't written run.json yet: whether a process still
 * holds the lock, and the end of console.log. Null if the run directory is missing, or run.json
 * exists (it isn't starting any more).
 */
export function loadStarting(repo: string, runId: string): Starting | null {
  const runlog = RunLog.forRun(repo, checkRunId(runId));
  if (!isDirectory(runlog.root) || existsSync(runlog.path('run.json'))) return null;
  let tail = '';
  try {
    const text = readFileSync(runlog.path(CONSOLE_LOG), 'utf-8');
    tail = text.split('\n').slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS).trimEnd();
  } catch {
    // no console.log yet
  }
  return {
    kind: 'starting',
    run_id: runId,
    alive: runlog.lockHolder() !== null,
    console_tail: tail,
  };
}

export function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e; // an unreadable directory is not "no such run"
  }
}
