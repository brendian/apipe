import { existsSync } from 'node:fs';
import {
  ANSWERS_SECTION_RE,
  MAX_ANSWER_CHARS,
  MAX_TOTAL_ANSWER_CHARS,
  OpenQuestion,
  QUESTION_ID_RE,
  specStage,
  type RunState,
} from '@advpipe/contracts';
import { emit } from './events.js';
import { RunLocked, RunLog } from './runlog.js';
import { branchExists } from './workspace.js';

// Blocking questions from the spec writer, and the person's answers (docs/02 §5, §5.1). A run
// stopped on `BLOCKING:` questions waits at SPEC (or SOLO) with them in `RunState.questions`; the
// host records answers here, then resumes the run, whose next spec pass is a revision that uses
// them. The orchestrator writes the answers into task.md itself (`withAnswersSection`), so later
// agents see them verbatim. Everything that asks "is this run waiting on answers?" uses this file.

// The answer limits live in `contracts` (the form shows them); re-exported for the engine's users.
export { MAX_ANSWER_CHARS, MAX_TOTAL_ANSWER_CHARS };
export const MAX_REASONING_CHARS = 2_000;
export const ANSWERS_HEADING = '## Answers';

/** An answer set that can't be recorded; the message is meant for the person answering. */
export class AnswerError extends Error {
  override name = 'AnswerError';
}

const thousands = (n: number): string => n.toLocaleString('en-US');
const oneLine = (text: string): string => text.split(/\s+/).filter(Boolean).join(' ');
const qnum = (id: string): number => (QUESTION_ID_RE.test(id) ? Number(id.slice(1)) : 0);
const byNumber = (a: string, b: string): number => qnum(a) - qnum(b);

// ── run state ───────────────────────────────────────────────────────────────────────────────────

/**
 * Fill `questions` for a run stopped by an older advpipe, which kept its blocking questions only as
 * open findings (`Q1`... with criterion `open-question`).
 */
export function migrate(state: RunState): RunState {
  if (
    state.questions.length > 0 ||
    state.status !== 'needs_human' ||
    state.stage !== specStage(state).stage
  ) {
    return state;
  }
  const old = state.open_findings.filter((f) => f.criterion === 'open-question');
  if (old.length === 0) return state;
  return {
    ...state,
    questions: old.map((f) => OpenQuestion.parse({ id: f.id, text: f.claim, asked_in: 1 })),
    spec_passes: state.spec_passes || 1,
  };
}

/** Questions nobody has dealt with yet: no answer, and no Bypass chosen. */
export const pendingQuestions = (state: RunState): OpenQuestion[] =>
  state.questions.filter((q) => !q.answer && !q.bypassed);

/** Answered, but no spec revision has used the answer yet. */
export const unappliedQuestions = (state: RunState): OpenQuestion[] =>
  state.questions.filter((q) => q.answer && !q.applied);

/** Bypassed questions the agent hasn't answered yet (it is asked, once, when the run resumes). */
export const awaitingBypass = (state: RunState): OpenQuestion[] =>
  state.questions.filter((q) => q.bypassed && !q.answer);

/**
 * The questions an answer is wanted for now: those no spec pass has used an answer for (pending
 * ones, and ones answered since the run stopped, whose answers can be replaced).
 */
export const toAnswer = (state: RunState): OpenQuestion[] =>
  state.questions.filter((q) => !q.applied);

export const answeredQuestions = (state: RunState): OpenQuestion[] =>
  state.questions.filter((q) => q.answer);

/** Stopped at SPEC (or SOLO) on blocking questions, with spec passes left to answer them. */
function blockedAtSpec(state: RunState, maxPasses: number): boolean {
  const { stage, key } = specStage(state);
  return (
    state.status === 'needs_human' &&
    state.stage === stage &&
    !(key in state.commits) &&
    state.questions.length > 0 &&
    state.spec_passes < maxPasses
  );
}

/** The run is waiting for a person to answer its spec's blocking questions. */
export const awaitingAnswers = (state: RunState, maxPasses: number): boolean =>
  blockedAtSpec(state, maxPasses) && pendingQuestions(state).length > 0;

/**
 * Every question is answered or bypassed, and resuming will give the answers (the agent's, for
 * bypassed ones) to the spec writer.
 */
export const answersReady = (state: RunState, maxPasses: number): boolean =>
  blockedAtSpec(state, maxPasses) &&
  pendingQuestions(state).length === 0 &&
  (unappliedQuestions(state).length > 0 || awaitingBypass(state).length > 0);

/** The run's spec-pass cap, from the config it ran with. */
export function maxSpecPasses(log: RunLog): number {
  try {
    return (log.readConfig()?.limits.max_rounds_spec ?? 3) as number;
  } catch {
    return 3;
  }
}

// ── recording answers ───────────────────────────────────────────────────────────────────────────

const normaliseIds = (ids: Iterable<string>): Set<string> =>
  new Set([...ids].map((id) => id.trim().toUpperCase()));

/**
 * The answers, stripped, if every question no spec pass has used an answer for yet is answered or
 * bypassed (`bypass`: ids the agent decides). Throws AnswerError saying what's wrong otherwise.
 */
export function checkAnswers(
  state: RunState,
  answers: Record<string, string>,
  bypass: Iterable<string> = [],
): Record<string, string> {
  const waiting = new Set(toAnswer(state).map((q) => q.id));
  const known = new Set(state.questions.map((q) => q.id));
  const skipped = normaliseIds(bypass);
  const unknown = (id: string): AnswerError =>
    new AnswerError(`${id} isn't one of this run's questions (${[...known].sort().join(', ')})`);
  for (const id of [...skipped].sort(byNumber)) {
    if (!known.has(id)) throw unknown(id);
    if (!waiting.has(id)) throw new AnswerError(`${id} is already answered and used by the spec`);
  }
  const cleaned: Record<string, string> = {};
  for (const [rawId, rawText] of Object.entries(answers)) {
    const id = rawId.trim().toUpperCase();
    if (!known.has(id)) throw unknown(id);
    if (!waiting.has(id)) throw new AnswerError(`${id} is already answered and used by the spec`);
    if (skipped.has(id)) {
      throw new AnswerError(`${id} can't be both answered and bypassed; choose one`);
    }
    const text = rawText.trim();
    if (text === '') throw new AnswerError(`the answer to ${id} is empty`);
    if (text.length > MAX_ANSWER_CHARS) {
      throw new AnswerError(
        `the answer to ${id} is ${thousands(text.length)} characters; keep each answer under ` +
          thousands(MAX_ANSWER_CHARS),
      );
    }
    cleaned[id] = text;
  }
  const missing = [...waiting].filter((id) => !(id in cleaned) && !skipped.has(id)).sort(byNumber);
  if (missing.length > 0) {
    throw new AnswerError(
      `answer every question: ${missing.join(', ')} still ` +
        (missing.length === 1 ? 'needs an answer' : 'need answers') +
        ' (or Bypass it, to let the agent decide)',
    );
  }
  const total = Object.values(cleaned).reduce((sum, t) => sum + t.length, 0);
  if (total > MAX_TOTAL_ANSWER_CHARS) {
    throw new AnswerError(
      `the answers are ${thousands(total)} characters together; keep them under ` +
        thousands(MAX_TOTAL_ANSWER_CHARS),
    );
  }
  return cleaned;
}

/** Why a run can't take answers now, for the person trying (02 §19: no command names). */
export function notWaitingForAnswers(state: RunState, cap: number): string {
  const run = state.run_id;
  const { stage } = specStage(state);
  const d = state.decisions.at(-1);
  if (d !== undefined && d.kind === 'spec_cap' && !d.choice) {
    return (
      `run ${run}'s spec still has blocking questions after ${state.spec_passes} spec ` +
      "pass(es), the limit (limits.max_rounds_spec), so they can't be answered one more time. " +
      'Begin work anyway, and the agent decides them (and any later question), or stop: ' +
      "choose *Begin work* or *Stop here* on the run's page"
    );
  }
  if (
    state.status === 'needs_human' &&
    state.stage === stage &&
    state.questions.length > 0 &&
    state.spec_passes >= cap
  ) {
    return (
      `run ${run}'s spec still has blocking questions after ${state.spec_passes} spec ` +
      'pass(es), the limit (limits.max_rounds_spec). Reword the work item and start a new run.'
    );
  }
  return `run ${run} isn't waiting on answers (it's ${state.status} at ${state.stage})`;
}

async function branchStillThere(repo: string, branch: string): Promise<boolean> {
  try {
    return branch !== '' && (await branchExists(repo, branch));
  } catch {
    return false;
  }
}

/**
 * Save answers to a run's blocking questions in its run.json. Doesn't resume the run.
 *
 * All-or-nothing: every pending question must be answered, or bypassed (`bypass`: the person lets
 * the agent decide; it answers when the run resumes). Throws AnswerError if the run isn't waiting
 * on answers, is being driven by a live process, can't be resumed (its branch is gone), or the
 * answers don't fit (see `checkAnswers`).
 */
export async function recordAnswers(
  repo: string,
  runId: string,
  answers: Record<string, string>,
  bypass: Iterable<string> = [],
): Promise<RunState> {
  const log = RunLog.forRun(repo, runId);
  if (!existsSync(log.path('run.json'))) throw new AnswerError(`no run ${runId} in ${repo}`);
  try {
    log.acquireLock();
  } catch (e) {
    if (!(e instanceof RunLocked)) throw e;
    throw new AnswerError(`run ${runId} is still being driven (${e.message}); wait for it to stop`);
  }
  try {
    const state = migrate(log.readState());
    const cap = maxSpecPasses(log);
    if (!(awaitingAnswers(state, cap) || answersReady(state, cap))) {
      throw new AnswerError(notWaitingForAnswers(state, cap));
    }
    if (!(await branchStillThere(repo, state.branch))) {
      throw new AnswerError(
        `run ${runId} can't be resumed: its branch ${state.branch} no longer exists ` +
          '(cleaned up?). Start a new run instead.',
      );
    }
    const cleaned = checkAnswers(state, answers, bypass);
    const skipped = normaliseIds(bypass);
    const now = new Date().toISOString();
    for (const q of state.questions) {
      const given = cleaned[q.id];
      if (given !== undefined) {
        Object.assign(q, {
          answer: given,
          answered_at: now,
          applied: false,
          source: 'person',
          reasoning: '',
          bypassed: false,
        });
      } else if (skipped.has(q.id)) {
        // The agent answers when the run resumes (stages/bypass.ts).
        Object.assign(q, {
          answer: '',
          answered_at: null,
          applied: false,
          source: 'person',
          reasoning: '',
          bypassed: true,
        });
      }
    }
    log.writeState(state);
    const ids = Object.keys(cleaned).sort(byNumber);
    const bypassed = [...skipped].sort(byNumber);
    let said = ids.length > 0 ? `answers recorded for ${ids.join(', ')}` : 'answers recorded';
    if (bypassed.length > 0) {
      said += `${ids.length > 0 ? ';' : ':'} Bypass for ${bypassed.join(', ')}`;
    }
    const data = bypassed.length > 0 ? { ids, bypassed } : { ids };
    emit(log, state, () => undefined, 'answers', said, data);
    return state;
  } finally {
    log.releaseLock();
  }
}

// ── task.md ─────────────────────────────────────────────────────────────────────────────────────

const ANSWERS_SECTION_ALL = new RegExp(ANSWERS_SECTION_RE.source, 'gim');

/**
 * task.md with its `## Answers` section replaced by every answered question, verbatim.
 *
 * Written by the orchestrator, not an agent, so the person's words can't be dropped or reworded.
 * Answers are indented under their list item, so no line of an answer can start a heading or a
 * list item of its own (`blockingOpenQuestions` never sees them).
 */
export function withAnswersSection(taskMd: string, questions: readonly OpenQuestion[]): string {
  const body = taskMd.replace(ANSWERS_SECTION_ALL, '').trimEnd();
  const done = questions.filter((q) => q.answer);
  if (done.length === 0) return `${body}\n`;
  const byAgent = done.some((q) => q.source === 'agent');
  const intro = byAgent
    ? 'Answers to the blocking questions. They override anything above that disagrees. ' +
      'Answers marked "agent\'s best judgement" were chosen by the agent because the person ' +
      'chose Bypass.'
    : 'Answers from the person who started this run. They override anything above that disagrees.';
  const lines = [ANSWERS_HEADING, intro, ''];
  for (const q of done) {
    lines.push(`- **${q.id}:** ${oneLine(q.text)}`);
    const answer = q.answer.trim().split(/\r?\n/);
    const label = q.source === 'agent' ? "Answer (agent's best judgement)" : 'Answer';
    lines.push(`  **${label}:** ${answer[0] ?? ''}`);
    for (const line of answer.slice(1)) lines.push(line.trim() ? `  ${line}` : '');
    if (q.source === 'agent' && q.reasoning.trim()) {
      lines.push(`  Reason: ${oneLine(q.reasoning)}`);
    }
  }
  return `${body}\n\n${lines.join('\n').trimEnd()}\n`;
}
