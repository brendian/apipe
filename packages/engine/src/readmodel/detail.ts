import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  ArbiterRuling,
  CHOICE_VIEWS,
  VALID,
  specStage,
  suggestedBudget,
  COMMIT_KEYS,
  DECISION_CHOICES,
  Config,
  SHAPES,
  STAGE_LABELS,
  Verdict,
  droppedSafeguards,
  gatePassed,
  GateResult,
  RESUMABLE,
  retryWarning,
  scanOn,
  stepsFor,
  titleOf,
  type CriticViewData,
  type Decision,
  type DecisionViewData,
  type DiffViewData,
  type GatesViewData,
  type OpenQuestion,
  type RoundViewData,
  type RunDetail,
  type RunState,
  type Stage,
  type Starting,
  type StepState,
  type StepViewData,
} from '@advpipe/contracts';
import {
  answersReady,
  awaitingAnswers,
  migrate,
  pendingQuestions,
  toAnswer,
} from '../core/answers.js';
import { awaitingDecision, decisionReady, maxFixPasses } from '../core/decisions.js';
import { checkRunId, RunLog } from '../core/runlog.js';
import { parseModel } from '../stages/calls.js';
import { isDirectory, loadStarting, readConfig, rowOf } from './runs.js';
import { nextSteps, quote } from './next-steps.js';
import { markdown } from './render.js';
import { forRun } from './usage-view.js';

// What the run detail page shows, read from one run directory (.advpipe/runs/<id>/). Port of
// `ui/detail.py`. Everything comes from files the pipeline already writes; nothing here changes
// them. A file that is missing or can't be parsed is shown as such rather than failing the page: a
// live run writes them one at a time.

/** A diff longer than this is cut in the page; the full file stays in the run directory. */
export const MAX_DIFF_LINES = 3000;

/** Mainline stage -> the key it records in `RunState.commits` when it finishes. */
const COMMIT_KEY: Partial<Record<Stage, string>> = COMMIT_KEYS;

/** The final author pass of each kind (`final-pass-<kind>/`): who wrote it, and its step. */
const FINAL_PASS: Record<string, { author: string; stage: Stage }> = {
  tests: { author: 'test author', stage: 'TESTS' },
  code: { author: 'coder', stage: 'CODE' },
  solo: { author: 'solo agent', stage: 'SOLO' },
};

// ── file readers ───────────────────────────────────────────────────────────────────────────────

/** The file's text, or null if it doesn't exist (yet) or isn't a readable file. */
export function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

const rel = (log: RunLog, file: string): string =>
  path.relative(log.root, file).split(path.sep).join('/');

function diffOf(log: RunLog, file: string): DiffViewData | null {
  const text = readText(file);
  if (text === null) return null;
  const all = text.split(/\r\n|\r|\n/);
  if (all.at(-1) === '') all.pop();
  const lines = all.slice(0, MAX_DIFF_LINES).map((line) => {
    let kind: DiffViewData['lines'][number]['kind'] = 'ctx';
    if (/^(?:diff --git|index |\+\+\+|---|new file|deleted file)/.test(line)) kind = 'meta';
    else if (line.startsWith('@@')) kind = 'hunk';
    else if (line.startsWith('+')) kind = 'add';
    else if (line.startsWith('-')) kind = 'del';
    return { kind, text: line };
  });
  return { path: rel(log, file), lines, total: all.length };
}

// Colour codes a test runner printed: noise in a page.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** A gates.json (a list of results) or scanner.json (one result). */
function gatesOf(log: RunLog, file: string): GatesViewData | null {
  const text = readText(file);
  if (text === null) return null;
  try {
    const data: unknown = JSON.parse(text);
    const results = (Array.isArray(data) ? data : [data]).map((g) => GateResult.parse(g));
    const status = (g: GateResult): 'pass' | 'fail' | 'skipped' =>
      g.skipped ? 'skipped' : gatePassed(g) ? 'pass' : 'fail';
    return {
      path: rel(log, file),
      readable: true,
      passed: results.every(gatePassed),
      line: results.map((g) => `${g.name} ${status(g)}`).join(' · ') || 'no checks',
      results: results.map((g) => ({
        name: g.name,
        command: g.command.map((part) => quote(part, 'posix')).join(' '),
        status: status(g),
        returncode: g.returncode,
        output: g.output.replace(ANSI, ''),
        skip_reason: g.skip_reason,
      })),
    };
  } catch {
    return {
      path: rel(log, file),
      readable: false,
      passed: false,
      line: "couldn't read the results",
      results: [],
    };
  }
}

function criticOf(log: RunLog, file: string, role: string): CriticViewData | null {
  const raw = readText(file);
  if (raw === null) return null;
  let verdict: CriticViewData['verdict'] = null;
  let dropped = 0;
  try {
    const v = parseModel(raw, Verdict);
    verdict = { verdict: v.verdict, findings: v.findings };
    dropped = v.noise.length;
  } catch {
    // shown raw
  }
  return { role, path: rel(log, file), raw, verdict, dropped };
}

const reply = (file: string): string | null => {
  const text = readText(file);
  return text === null ? null : markdown(text);
};

/** Directory names `<prefix>-<n>` in `dir`, as numbers, in numeric order (round 10 after 2). */
function numbered(dir: string, prefix: string): number[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  return names
    .flatMap((n) => {
      const m = re.exec(n);
      return m?.[1] === undefined ? [] : [Number(m[1])];
    })
    .sort((a, b) => a - b);
}

// ── round panels ───────────────────────────────────────────────────────────────────────────────

type RoundInit = Partial<Omit<RoundViewData, 'key' | 'title' | 'outcome'>> & {
  key: string;
  title: string;
};

function round(init: RoundInit): RoundViewData {
  const r: Omit<RoundViewData, 'outcome'> = {
    author_role: '',
    author_html: null,
    diff: null,
    gates: [],
    critics: [],
    test_fix_html: null,
    expect_red: false,
    task_html: null,
    asked: [],
    notice: '',
    decision: null,
    ...init,
  };
  return { ...r, outcome: outcomeOf(r) };
}

/** A short result for the panel's summary line. */
function outcomeOf(r: Omit<RoundViewData, 'outcome'>): string {
  if (r.critics.length > 0) {
    if (r.critics.some((c) => c.verdict === null)) return 'critic output unreadable';
    return r.critics.map((c) => `${c.role}: ${c.verdict?.verdict}`).join(' · ');
  }
  if (r.gates.length > 0)
    return 'checks: ' + (r.gates.every((g) => g.view.passed) ? 'pass' : 'fail');
  if (r.decision !== null) return `you chose ${r.decision.choice}`;
  if (r.asked.length > 0) {
    return `${r.asked.length} blocking question${r.asked.length === 1 ? '' : 's'}`;
  }
  return '';
}

/** "Revision 1: with your answers to Q1, Q2", or the agent's, when you chose Bypass. */
function revisionTitle(number: number, earlier: OpenQuestion[]): string {
  const ids = (agent: boolean): string =>
    earlier
      .filter((q) => q.answer && (q.source === 'agent') === agent)
      .map((q) => q.id)
      .join(', ');
  const mine = ids(false);
  const agent = ids(true);
  const parts = [
    mine ? `your answers to ${mine}` : '',
    agent ? `the agent's best-judgement answers to ${agent}` : '',
  ].filter(Boolean);
  return `Revision ${number}` + (parts.length > 0 ? ': with ' + parts.join(' and ') : '');
}

/** One panel per spec-writer pass: the first spec, then each revision after answers. */
function specRounds(log: RunLog, state: RunState): RoundViewData[] {
  const numbers = [...new Set([1, ...numbered(log.path('spec'), 'pass')])].sort((a, b) => a - b);
  const rounds: RoundViewData[] = [];
  for (const n of numbers) {
    const dir = log.path(`spec/pass-${n}`);
    const author = reply(n === 1 ? log.path('spec/author.txt') : path.join(dir, 'author.txt'));
    const taskText = readText(path.join(dir, 'task.md'));
    const asked = state.questions.filter((q) => q.asked_in === n);
    if (author === null && taskText === null && asked.length === 0) continue;
    rounds.push(
      round({
        key: `spec/pass-${n}`,
        title:
          n > 1
            ? revisionTitle(
                n - 1,
                state.questions.filter((q) => q.asked_in < n),
              )
            : 'Spec writer',
        author_role: 'spec writer',
        author_html: author,
        task_html: taskText !== null && n > 1 ? markdown(taskText) : null,
        asked,
      }),
    );
  }
  return rounds;
}

/** One panel per pass of the solo agent: the first pass, each revision, each fix pass asked for. */
function soloRounds(log: RunLog, state: RunState): RoundViewData[] {
  const rounds: RoundViewData[] = [];
  let specPass = 0; // passes that wrote task.md, as `spec_passes` counts them
  for (const n of numbered(log.path('stage-solo'), 'pass')) {
    const dir = log.path(`stage-solo/pass-${n}`);
    const request = readText(path.join(dir, 'request.json'));
    let title = `Pass ${n}`;
    let asked: OpenQuestion[] = [];
    if (request !== null) {
      let number = 0;
      try {
        number = Number((JSON.parse(request) as { fix_pass?: unknown }).fix_pass ?? 0) || 0;
      } catch {
        // a damaged request: titled as a plain fix pass
      }
      title = number ? `Fix pass ${number} (you asked)` : 'Fix pass (you asked)';
    } else {
      specPass += 1;
      asked = state.questions.filter((q) => q.asked_in === specPass);
      if (readText(path.join(dir, 'answers.json')) !== null) {
        title = revisionTitle(
          specPass - 1,
          state.questions.filter((q) => q.asked_in < specPass),
        );
      }
    }
    const gates = gatesOf(log, path.join(dir, 'gates.json'));
    const taskText = readText(path.join(dir, 'task.md'));
    rounds.push(
      round({
        key: `solo/pass-${n}`,
        title,
        author_role: 'solo agent',
        author_html: reply(path.join(dir, 'author.txt')),
        diff: diffOf(log, path.join(dir, 'diff.patch')),
        gates: gates ? [{ label: 'Checks', view: gates }] : [],
        task_html: taskText !== null ? markdown(taskText) : null,
        asked,
      }),
    );
  }
  return rounds;
}

/** The author/critic rounds of the tests or code stage. */
function loopRounds(log: RunLog, kind: 'tests' | 'code', state: RunState): RoundViewData[] {
  const [author, critic] =
    kind === 'tests' ? ['test author', 'test critic'] : ['coder', 'code critic'];
  const noCritic = SHAPES[state.level].critics ? '' : 'No critic at this level: the checks decide.';
  return numbered(log.path(`stage-${kind}`), 'round').map((n) => {
    const dir = log.path(`stage-${kind}/round-${n}`);
    const gates = gatesOf(log, path.join(dir, 'gates.json'));
    const criticView = criticOf(log, path.join(dir, 'critic.json'), critic);
    return round({
      key: `${kind}/round-${n}`,
      title: `Round ${n}`,
      author_role: author,
      author_html: reply(path.join(dir, 'author.txt')),
      diff: diffOf(log, path.join(dir, 'diff.patch')),
      gates: gates ? [{ label: 'Checks', view: gates }] : [],
      critics: criticView ? [criticView] : [],
      test_fix_html: reply(path.join(dir, 'test-fix.txt')),
      expect_red: kind === 'tests',
      notice: criticView === null ? noCritic : '',
    });
  });
}

function reviewRounds(log: RunLog): RoundViewData[] {
  const dir = log.path('review');
  if (!statOk(dir)) return [];
  const single = criticOf(log, path.join(dir, 'single.json'), 'code critic (one review pass)');
  if (single) {
    return [
      round({
        key: 'review/single',
        title: 'Single review',
        diff: diffOf(log, path.join(dir, 'diff.patch')),
        critics: [single],
        notice: "One code-critic pass over the whole change; there's no second round.",
      }),
    ];
  }
  const scanner = gatesOf(log, path.join(dir, 'scanner.json'));
  const critics = [
    criticOf(log, path.join(dir, 'standards.json'), 'standards reviewer'),
    criticOf(log, path.join(dir, 'security.json'), 'security reviewer'),
  ].filter((c): c is CriticViewData => c !== null);
  return [
    round({
      key: 'review/review',
      title: 'Review',
      diff: diffOf(log, path.join(dir, 'diff.patch')),
      gates: scanner ? [{ label: 'Security scanner', view: scanner }] : [],
      critics,
    }),
  ];
}

function statOk(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Raw arbiter replies that couldn't be parsed. */
function unreadableArbiterRounds(log: RunLog): RoundViewData[] {
  const rounds: RoundViewData[] = [];
  for (const label of ['tests', 'code', 'review']) {
    const raw = readText(log.path(`arbiter-${label}.json`));
    if (raw === null) continue;
    try {
      parseModel(raw, ArbiterRuling);
    } catch {
      rounds.push(
        round({
          key: `arbiter/${label}`,
          title: `Arbiter reply after ${label} (unreadable)`,
          author_role: 'arbiter',
          author_html: markdown(`\`\`\`\n${raw}\n\`\`\``),
        }),
      );
    }
  }
  return rounds;
}

/** The final author pass after a step's open findings were ruled on, by kind. */
function finalPassRounds(log: RunLog): Map<string, RoundViewData> {
  const rounds = new Map<string, RoundViewData>();
  for (const [kind, { author }] of Object.entries(FINAL_PASS)) {
    const dir = log.path(`final-pass-${kind}`);
    if (!statOk(dir)) continue;
    const gates = gatesOf(log, path.join(dir, 'gates.json'));
    rounds.set(
      kind,
      round({
        key: `final-pass-${kind}`,
        title: `Final fix pass (${kind})`,
        author_role: author,
        author_html: reply(path.join(dir, 'author.txt')),
        gates: gates ? [{ label: 'Checks after the fix', view: gates }] : [],
      }),
    );
  }
  return rounds;
}

/** The fix passes you asked for (`fix-pass-N/`, outside the solo stage), by the step they were for. */
function fixPassRounds(log: RunLog, state: RunState): Map<Stage, RoundViewData[]> {
  const asked = state.decisions.filter((d) => d.choice === 'fix');
  const rounds = new Map<Stage, RoundViewData[]>();
  asked.forEach((d, i) => {
    const n = i + 1;
    const dir = log.path(`fix-pass-${n}`);
    if (!statOk(dir)) return;
    const gates = gatesOf(log, path.join(dir, 'gates.json'));
    rounds.set(d.stage, [
      ...(rounds.get(d.stage) ?? []),
      round({
        key: `fix-pass-${n}`,
        title: `Fix pass ${n} (you asked)`,
        author_role: d.stage === 'TESTS' ? 'test author' : 'coder',
        author_html: reply(path.join(dir, 'author.txt')),
        gates: gates ? [{ label: 'Checks after the fix', view: gates }] : [],
      }),
    ]);
  });
  return rounds;
}

export const DECISION_TITLE: Record<Decision['kind'], string> = {
  red_checks: 'The checks are still failing',
  scan_hits: 'The security scan reported issues',
  usage_limit: 'Paused: a usage limit was reached',
  spec_cap: 'Begin work?',
  review_step: 'Your review',
};

/** The decisions you made, each a panel in the step where the run stopped. */
function decisionRounds(state: RunState, steps: Stage[]): Map<Stage, RoundViewData[]> {
  const rounds = new Map<Stage, RoundViewData[]>();
  state.decisions.forEach((d, i) => {
    if (!d.choice) return; // the open one is in the page's header
    const stage: Stage = steps.includes(d.stage) ? d.stage : 'FINAL_GATES';
    rounds.set(stage, [
      ...(rounds.get(stage) ?? []),
      round({
        key: `decision-${i + 1}`,
        title: `Decision ${i + 1}: ${DECISION_TITLE[d.kind]}`,
        decision: d,
      }),
    ]);
  });
  return rounds;
}

// ── timeline steps ─────────────────────────────────────────────────────────────────────────────

/**
 * The mainline stage the run is in. During ARBITER, that's the stage it was called from: the first
 * one of the level's own steps without a recorded commit.
 */
function activeStage(state: RunState): Stage {
  if (state.stage !== 'ARBITER') return state.stage;
  const mainline = stepsFor(state.level).filter((s) => COMMIT_KEY[s] !== undefined);
  return (
    mainline.find((s) => !((COMMIT_KEY[s] ?? '') in state.commits)) ?? mainline.at(-1) ?? 'REVIEW'
  );
}

/**
 * `canContinue`: the run can still go on (resumable, or waiting on answers or a decision), so the
 * steps after where it stopped are "not yet" rather than "not reached".
 */
function stepState(
  stage: Stage,
  state: RunState,
  live: boolean,
  arbiterUsed: boolean,
  canContinue: boolean,
): StepState {
  const here: StepState = live ? 'current' : 'stopped';
  const later: StepState = canContinue ? 'pending' : 'not_reached';
  if (stage === 'ARBITER') {
    if (state.stage === 'ARBITER') return here;
    if (arbiterUsed) return 'done';
    if (state.status === 'complete' || state.stage === 'FINAL_GATES') return 'not_needed';
    return canContinue ? 'if_needed' : 'not_reached';
  }
  if (stage === 'FINAL_GATES') {
    if (state.status === 'complete') return 'done';
    return state.stage === 'FINAL_GATES' ? here : later;
  }
  if ((COMMIT_KEY[stage] ?? '') in state.commits) return 'done';
  return activeStage(state) === stage ? here : later;
}

function summaryOf(
  stage: Stage,
  state: RunState,
  config: Config | null,
  rounds: RoundViewData[],
): string {
  if (stage === 'TESTS' || stage === 'CODE') {
    const n = rounds.filter((r) => r.title.startsWith('Round ')).length;
    if (n === 0) return '';
    const cap = config
      ? stage === 'TESTS'
        ? config.limits.max_rounds_tests
        : config.limits.max_rounds_code
      : null;
    return cap ? `${n} of ${cap} rounds` : `${n} round${n === 1 ? '' : 's'}`;
  }
  if (stage === 'ARBITER' && state.rulings.length > 0) {
    const fixes = state.rulings.filter((r) => r.decision === 'fix').length;
    return `${state.rulings.length} ruling(s): ${fixes} fix, ${state.rulings.length - fixes} dismiss`;
  }
  if (stage === 'SOLO') {
    const n = rounds.filter((r) => /^(?:Pass|Revision)/.test(r.title)).length;
    return n > 0 ? `${n} ${n === 1 ? 'pass' : 'passes'}` : '';
  }
  return rounds[0]?.outcome ?? '';
}

/** The steps of the run's level (`stepsFor`), each with its rounds and state. */
export function buildTimeline(
  log: RunLog,
  state: RunState,
  config: Config | null,
  live: boolean,
): StepViewData[] {
  const levelSteps = stepsFor(state.level);
  const unreadable = unreadableArbiterRounds(log);
  const finalPasses = finalPassRounds(log);
  const arbiterUsed =
    state.rulings.length > 0 ||
    unreadable.length > 0 ||
    ['tests', 'code', 'review'].some((l) => readText(log.path(`arbiter-${l}.json`)) !== null);
  const hasArbiter = levelSteps.includes('ARBITER');
  const current = migrate(state);
  const cap = config?.limits.max_rounds_spec ?? Config.parse({}).limits.max_rounds_spec;
  const canContinue =
    RESUMABLE.has(state.status) ||
    awaitingAnswers(current, cap) ||
    answersReady(current, cap) ||
    awaitingDecision(state) ||
    decisionReady(state);
  const fixRounds = fixPassRounds(log, state);
  const decided = decisionRounds(state, levelSteps);
  // Without an arbiter, each final fix pass sits in the step it was for, and the rulings code
  // made go with the last of them.
  const ruledIn = (['code', 'tests', 'solo'] as const).find((k) => finalPasses.has(k));
  const ruledStage = ruledIn === undefined ? null : FINAL_PASS[ruledIn]?.stage;

  return levelSteps.map((stage): StepViewData => {
    let rounds: RoundViewData[] = [];
    let taskHtml: string | null = null;
    const taskText = (): string | null => {
      const t = readText(log.path('task.md'));
      return t === null ? null : markdown(t);
    };
    if (stage === 'SPEC') {
      rounds = specRounds(log, current);
      taskHtml = taskText();
    } else if (stage === 'SOLO') {
      rounds = soloRounds(log, current);
      taskHtml = taskText();
    } else if (stage === 'TESTS') rounds = loopRounds(log, 'tests', state);
    else if (stage === 'CODE') rounds = loopRounds(log, 'code', state);
    else if (stage === 'REVIEW') rounds = reviewRounds(log);
    else if (stage === 'ARBITER') rounds = [...unreadable, ...finalPasses.values()];
    else if (stage === 'FINAL_GATES') {
      const gates = gatesOf(log, log.path('final-gates.json'));
      rounds = gates
        ? [
            round({
              key: 'final-gates',
              title: 'Final checks',
              gates: [{ label: 'Checks', view: gates }],
            }),
          ]
        : [];
    }
    if (!hasArbiter) {
      for (const [kind, r] of finalPasses) if (FINAL_PASS[kind]?.stage === stage) rounds.push(r);
    }
    rounds.push(...(fixRounds.get(stage) ?? []), ...(decided.get(stage) ?? []));
    let rulings = [] as StepViewData['rulings'];
    let rulingsNote = '';
    if (stage === 'ARBITER') {
      rulings = [...state.rulings];
    } else if (!hasArbiter && stage === ruledStage) {
      rulings = [...state.rulings];
      rulingsNote = `No arbiter at the ${state.level} level: code ruled every open finding fix.`;
    }
    return {
      stage,
      label: STAGE_LABELS[stage] ?? stage,
      state: stepState(stage, state, live, arbiterUsed, canContinue),
      summary: summaryOf(stage, state, config, rounds),
      rounds,
      task_html: taskHtml,
      rulings,
      rulings_note: rulingsNote,
    };
  });
}

// ── the open decision ──────────────────────────────────────────────────────────────────────────

/** The panel for the decision the run is waiting at, or null if it isn't at one. */
export function decisionView(state: RunState, log: RunLog): DecisionViewData | null {
  const d = state.decisions.at(-1);
  if (d === undefined || !awaitingDecision(state)) return null;
  const choices: readonly string[] = DECISION_CHOICES[d.kind];
  const reviewed = d.kind === 'review_step' || (state.review_pauses && d.kind === 'red_checks');
  const patch =
    reviewed && (d.stage === 'TESTS' || d.stage === 'CODE')
      ? diffOf(log, log.path(`human-review/${d.stage.toLowerCase()}.patch`))
      : null;
  return {
    review_task_md:
      d.kind === 'review_step' && d.stage === 'SPEC' ? readText(log.path('task.md')) : null,
    review_diff: patch,
    decision: d,
    choices: choices.filter((c) => c in CHOICE_VIEWS),
    pending: d.kind === 'spec_cap' ? pendingQuestions(state) : [],
    fix_pass: state.fix_passes + 1,
    max_fix_passes: maxFixPasses(log),
    retry_warning: d.kind === 'usage_limit' ? retryWarning(d.usage) : '',
    add_key: d.kind === 'usage_limit' ? (d.billing ? 'add_credits' : 'add_usage') : '',
    add_label:
      d.kind === 'usage_limit'
        ? d.billing
          ? 'Add credits in the Console'
          : 'Add extra usage'
        : '',
  };
}

// ── the page ───────────────────────────────────────────────────────────────────────────────────

function elapsed(state: RunState): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(state.updated_at) - Date.parse(state.started_at)) / 1000) || 0,
  );
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
    : `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * The run's page for `runId`: null if the run directory is missing, the starting-up view while
 * run.json isn't there yet, else the whole run. Throws (with the reason) if run.json can't be read,
 * so the page can say "Can't read this run" rather than "No such run".
 */
export function loadDetail(repo: string, runId: string): RunDetail | Starting | null {
  const log = RunLog.forRun(repo, checkRunId(runId));
  if (!isDirectory(log.root)) return null;
  const starting = loadStarting(repo, runId);
  if (starting) return starting;
  const state = log.readState();
  const config = readConfig(log);
  const row = rowOf(runId, state, log);
  const live = row.status === 'running';
  const report = readText(log.path('report.md'));
  return {
    kind: 'run',
    row,
    title: titleOf(state.work_item, 120),
    live,
    elapsed: elapsed(state),
    scan: scanOn(state),
    dropped: droppedSafeguards(state.level, scanOn(state)),
    worktree_kept: state.worktree !== '' && !state.worktree_removed,
    work_item_file: state.work_item_file,
    usage: forRun(repo, state),
    timeline: buildTimeline(log, state, config, live),
    report_html: report === null ? null : markdown(report),
    next_steps: nextSteps(state, row.status, repo),
    decision_view:
      row.status === 'needs_decision' || row.status === 'paused' ? decisionView(state, log) : null,
    actions: [...VALID[row.status]],
    suggested_budget: suggestedBudget(state.cost_usd, config?.limits.budget_usd_per_task ?? null),
    questions: row.status === 'needs_answers' ? toAnswer(migrate(state)) : [],
    asker: specStage(state).stage === 'SOLO' ? 'solo agent' : 'spec writer',
    bypass_on: state.bypass_questions,
    open_findings: state.open_findings,
  };
}
