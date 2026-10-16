import {
  FindingResponse,
  scanOn,
  type Config,
  type Finding,
  type GateName,
  type GateResult,
  type OpenQuestion,
  type RunState,
} from '@advpipe/contracts';
import { formatGates } from '../core/gates.js';
import { jsonAscii } from '../core/runlog.js';
import { dumpFinding } from './calls.js';
import type { Context } from './context.js';

// Every user prompt the code builds (docs/07). Wording and section order are ported exactly:
// parity tests assert on substrings of these.

/** The kind of author stage a prompt or pass is for. */
export type StageKind = 'tests' | 'code' | 'solo';

/** task.md is the contract, not part of the change: keep it out of diffs that critics judge. */
export const REVIEW_PATHS = ['.', ':(exclude)task.md'];

export const ALL_GATES = ['test', 'types', 'lint'] as const satisfies readonly GateName[];

/**
 * The checks run for authors and at the final gates. Below full, the security scan runs with them
 * when it's on; at full the review stage runs it, for the security reviewer.
 */
export function runGateNames(state: Pick<RunState, 'level' | 'security_scan'>): GateName[] {
  if (state.level !== 'full' && scanOn(state)) return [...ALL_GATES, 'security'];
  return [...ALL_GATES];
}

/** ```lang\n<text, trailing whitespace trimmed>\n``` */
export const fence = (text: string, lang = ''): string =>
  `\`\`\`${lang}\n${text.trimEnd()}\n\`\`\``;

const bulletList = (files: string[]): string => files.map((f) => `- ${f}`).join('\n') || '- (none)';

function gateCommands(config: Config, names: readonly string[]): string {
  const lines: string[] = [];
  for (const name of names) {
    const cmd = config.gates[name as keyof Config['gates']];
    if (cmd.length > 0) lines.push(`- ${name}: \`${cmd.join(' ')}\``);
  }
  return lines.join('\n') || '- (none configured)';
}

// ── spec writer ─────────────────────────────────────────────────────────────────────────────────

export function specPrompt(workItem: string): string {
  return (
    `Work item: ${workItem}\n\n` +
    'The target repository is your current working directory. Write task.md at the repository root.'
  );
}

function questionsAndAnswers(questions: readonly OpenQuestion[]): string {
  return questions
    .filter((q) => q.answer)
    .map(
      (q) =>
        `${q.id}: ${q.text}\nAnswer` +
        (q.source === 'agent' ? ' (your own best judgement: the person chose Bypass)' : '') +
        `: ${q.answer}`,
    )
    .join('\n\n');
}

/** The spec writer's next pass, after a person answered its blocking questions. */
export function specRevisionPrompt(
  workItem: string,
  previousTaskMd: string,
  questions: readonly OpenQuestion[],
): string {
  const previous = previousTaskMd.trim() || '(missing)';
  return (
    `Work item: ${workItem}\n\n` +
    'The target repository is your current working directory.\n\n' +
    'You wrote the task.md below, and the run stopped on its BLOCKING open questions. ' +
    'The person who started the run has now answered them.\n\n' +
    `# Your previous task.md\n\n${fence(previous, 'markdown')}\n\n` +
    `# Questions and answers\n\n${questionsAndAnswers(questions)}\n\n` +
    'Revise the spec: write the complete task.md again at the repository root, following ' +
    'the section "Revising after answers" in your instructions.'
  );
}

/** The spec writer's pass over its own task.md, because a person reviewed it and left notes. */
export function specReviewPrompt(workItem: string, previousTaskMd: string, note: string): string {
  const previous = previousTaskMd.trim() || '(missing)';
  return (
    `Work item: ${workItem}\n\n` +
    'The target repository is your current working directory.\n\n' +
    'You wrote the task.md below. The person who started the run read it and left notes.\n\n' +
    `# Your previous task.md\n\n${fence(previous, 'markdown')}\n\n` +
    `# The person's notes\n\n${fence(note.trim())}\n\n` +
    'Revise the spec: write the complete task.md again at the repository root, with the ' +
    "person's notes taken into account."
  );
}

// ── solo agent ──────────────────────────────────────────────────────────────────────────────────

function soloTail(ctx: Context): string {
  const paths = ctx.config.paths.tests.join(', ');
  return (
    '# Gate commands (run from repo root)\n\n' +
    `${gateCommands(ctx.config, runGateNames(ctx.state))}\n\nTest paths: ${paths}.`
  );
}

/** The solo agent's first pass: task.md first, then tests and code (or BLOCKING questions only). */
export function soloPrompt(ctx: Context): string {
  return (
    `Work item: ${ctx.state.work_item}\n\n` +
    'The target repository is your current working directory. Write task.md at the ' +
    'repository root first, then do the work, as your instructions say.\n\n' +
    soloTail(ctx)
  );
}

/** The solo agent's next pass, after its blocking questions were answered. */
export function soloRevisionPrompt(
  ctx: Context,
  previousTaskMd: string,
  questions: readonly OpenQuestion[],
): string {
  const previous = previousTaskMd.trim() || '(missing)';
  return (
    `Work item: ${ctx.state.work_item}\n\n` +
    'The target repository is your current working directory.\n\n' +
    'You wrote the task.md below, and the run stopped on its BLOCKING open questions. They ' +
    'have now been answered.\n\n' +
    `# Your previous task.md\n\n${fence(previous, 'markdown')}\n\n` +
    `# Questions and answers\n\n${questionsAndAnswers(questions)}\n\n` +
    'Write the complete task.md again at the repository root, following the section "Revising ' +
    'after answers" in your instructions, and then do the work.\n\n' +
    soloTail(ctx)
  );
}

// ── bypass ──────────────────────────────────────────────────────────────────────────────────────

/** Ask the agent that wrote task.md to answer its own blocking questions (the person chose Bypass). */
export function bypassPrompt(
  workItem: string,
  taskMd: string,
  questions: readonly OpenQuestion[],
): string {
  const listed = questions.map((q) => `${q.id}: ${q.text}`).join('\n');
  return (
    `Work item: ${workItem}\n\n` +
    'The target repository is your current working directory.\n\n' +
    'You wrote the task.md below and marked the questions listed after it BLOCKING. The ' +
    'person who started the run has chosen to let you decide them yourself.\n\n' +
    `# Your task.md\n\n${fence(taskMd.trim() || '(missing)', 'markdown')}\n\n` +
    `# Questions to decide\n\n${listed}\n\n` +
    'Answer every question with your best judgement: read the code if it helps, pick the ' +
    'answer a careful engineer would pick, and give a one-paragraph reason. Do not edit ' +
    'or create any file. Reply with JSON only, in this shape:\n\n' +
    fence('{"answers": [{"id": "Q1", "answer": "...", "reasoning": "..."}]}', 'json')
  );
}

export const FALLBACK_ANSWER =
  'No answer given; use your best judgement and record the choice under Assumptions.';
export const FALLBACK_REASON =
  'The agent gave no usable answer when asked, so the run went on without one.';

// ── test author / coder ─────────────────────────────────────────────────────────────────────────

export async function authorInitialPrompt(ctx: Context, kind: 'tests' | 'code'): Promise<string> {
  const paths = ctx.config.paths.tests.join(', ');
  const parts = [
    `# task.md\n\n${ctx.taskMd}`,
    '# Gate commands (run from repo root)\n\n' + gateCommands(ctx.config, runGateNames(ctx.state)),
  ];
  if (kind === 'tests') {
    parts.push(`Write the tests now. Test paths: ${paths}. This is round 1.`);
  } else {
    const testFiles = await ctx.workspace.changedFiles(ctx.specCommit, ctx.config.paths.tests);
    parts.push(
      `# Tests written for this task\n\n${bulletList(testFiles)}\n\n` +
        `Implement the change now. Do not modify anything under: ${paths}. This is round 1.`,
    );
  }
  return parts.join('\n\n');
}

/** Round >= 2, the final author pass and a person's fix pass all use this. */
export function authorFindingsPrompt(
  findings: readonly Finding[],
  gates: GateResult[],
  note: string,
): string {
  const verdict = { verdict: 'FAIL', findings: findings.map(dumpFinding) };
  return (
    `# ${note}\n\nBlocking findings to address:\n\n${fence(jsonAscii(verdict), 'json')}` +
    `\n\n# Latest gate output\n\n${formatGates(gates)}\n\n` +
    'Fix or dispute each finding (failed gates cannot be disputed), re-run the gates, ' +
    'then reply with AuthorResponse JSON only.'
  );
}

export const ARBITER_NOTE = 'Final pass: the arbiter ruled these must be fixed';
export const NO_ARBITER_NOTE = 'Final pass: these findings are still open and must be fixed';

export const fixPassNote = (n: number): string =>
  `Fix pass ${n}: a person asked for another pass at the failing checks`;

/** What a person's note adds to an author's fix-pass prompt, verbatim. */
export function fixPassExtra(note: string): string {
  if (!note.trim()) return '';
  return `\n\nA person asked for this pass and left you this note:\n\n${fence(note.trim())}`;
}

/** An author's pass because a person read the step's work and left notes (verbatim). */
export function reviewPassPrompt(n: number, note: string, gates: GateResult[]): string {
  return (
    `# Review pass ${n}: a person read your work and asked for changes\n\n` +
    `The person who started the run left these notes:\n\n${fence(note.trim())}` +
    `\n\n# Latest gate output\n\n${formatGates(gates)}\n\n` +
    'Make the changes the notes ask for, re-run the gates, then reply with AuthorResponse JSON only.'
  );
}

/** The test author's one pass at tests the code critic called defective. */
export function testFixPrompt(
  ctx: Context,
  defects: readonly Finding[],
  gates: GateResult[],
): string {
  const paths = ctx.config.paths.tests;
  return (
    `# task.md\n\n${ctx.taskMd}\n\n# Test fix pass\n\n` +
    'The implementation was judged against your tests, and the code critic reports that ' +
    'these failing tests are themselves defective (the test is wrong, not the code):\n\n' +
    `${fence(jsonAscii(defects.map(dumpFinding)), 'json')}\n\n# Latest gate output\n\n${formatGates(gates)}\n\n` +
    `Fix only these defects, in files under ${paths.join(', ')}. Keep every test checking ` +
    "the behaviour task.md requires: don't delete or skip tests, and don't weaken " +
    "assertions just to make them pass. Don't edit implementation files; changes outside " +
    'the test paths are reverted. Re-run the tests, then reply with a short summary.'
  );
}

// ── critics, reviewers, arbiter ─────────────────────────────────────────────────────────────────

/**
 * What a critic judges: task.md, the diff, gate output and, for code, which tests the run wrote.
 * `single`: the one review of the whole change at levels without critics.
 */
export async function criticPrompt(
  ctx: Context,
  kind: StageKind,
  diffLabel: string,
  diff: string,
  gates: GateResult[],
  opts: { single?: boolean } = {},
): Promise<string> {
  let context = '';
  if (opts.single) {
    const tests = await ctx.workspace.changedFiles(ctx.state.base_commit, ctx.config.paths.tests);
    context =
      '\n\n# Review\n\nThis is a single review pass: judge the whole change once; there ' +
      "won't be another round.\n\n# Test files changed in this run (part of the diff " +
      `below)\n\n${bulletList(tests)}`;
  } else if (kind === 'code') {
    const tests = await ctx.workspace.changedFiles(ctx.specCommit, ctx.config.paths.tests);
    context =
      '\n\n# Tests written in the previous stage (not part of this diff; the coder may ' +
      `not modify them)\n\n${bulletList(tests)}`;
  }
  return (
    `# task.md\n\n${ctx.taskMd}${context}\n\n# ${diffLabel}\n\n` +
    fence(diff || '(empty diff)', 'diff') +
    `\n\n# Gate output\n\n${formatGates(gates)}\n\nReply with Verdict JSON only.`
  );
}

export const NO_STANDARDS_DOC = '(no standards doc found)';

/** The two Full-level reviewers' prompts (docs/07 §6). */
export function reviewerPrompts(
  ctx: Context,
  diff: string,
  standardsDoc: string,
  scannerSummary: string,
): { standards: string; security: string } {
  const base =
    `# task.md\n\n${ctx.taskMd}\n\n# Full diff\n\n${fence(diff, 'diff')}` +
    `\n\n# Gate output\n\n${formatGates(ctx.lastGates)}`;
  return {
    standards:
      `${base}\n\n# Standards doc (${ctx.config.paths.standards_doc})\n\n${standardsDoc}\n\n` +
      'Reply with Verdict JSON only.',
    security: `${base}\n\n# Security scanner output\n\n${scannerSummary}\n\nReply with Verdict JSON only.`,
  };
}

export type ArbiterItem = { finding: Finding; response: FindingResponse | null };

export function arbiterPrompt(ctx: Context, items: readonly ArbiterItem[], diff: string): string {
  const shown = items.map((d) => ({
    finding: dumpFinding(d.finding),
    author_response: d.response ? FindingResponse.parse(d.response) : null,
  }));
  return (
    `# task.md\n\n${ctx.taskMd}\n\n# Current diff\n\n${fence(diff, 'diff')}` +
    `\n\n# Latest gate output\n\n${formatGates(ctx.lastGates)}` +
    `\n\n# Open findings\n\n${fence(jsonAscii(shown), 'json')}` +
    '\n\nRule on each finding. Reply with JSON only.'
  );
}
