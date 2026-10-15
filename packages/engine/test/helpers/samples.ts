// Sample content for scripted agents (port of the content half of tests/fakes.py, in JavaScript).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { newRunState, type Config } from '@advpipe/contracts';
import {
  Budget,
  Context,
  RunLog,
  Workspace,
  verdictPass,
  writes,
  type FakeAgentRunner,
  type Scripts,
  type Step,
} from '../../src/index.js';

export const TASK_MD = `# Task: Add clamp

## Goal
Add clamp(x, lo, hi).

## Acceptance criteria
- [ ] AC1: \`import { clamp } from "mathutils"\` works.
- [ ] AC2: returns x within [lo, hi], lo below, hi above.
- [ ] AC3: lo > hi throws RangeError.

## Constraints
- None

## In scope
- mathutils/

## Out of scope
- None

## Open questions
- None
`;

export const TASK_MD_BLOCKING = TASK_MD.replace(
  '## Open questions\n- None',
  '## Open questions\n- BLOCKING: should lo > hi swap or throw?',
);

export const TEST_CLAMP = `import assert from "node:assert/strict";
import { test } from "node:test";

import { clamp } from "../mathutils/index.js";

test("within", () => {
  assert.equal(clamp(5, 0, 10), 5); // AC2
});

test("below and above", () => {
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

test("lo > hi throws", () => {
  assert.throws(() => clamp(1, 10, 0), RangeError); // AC3
});
`;

/** A test that passes with no implementation (for the G-tests-green case). */
export const TRIVIAL_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";

test("nothing", () => {
  assert.ok(true);
});
`;

/** A test with a wrong expected value: it can never pass, even with a correct clamp. */
export const TEST_CLAMP_DEFECT = TEST_CLAMP.replace(
  'assert.equal(clamp(5, 0, 10), 5);',
  'assert.equal(clamp(5, 0, 10), 6); // defect',
);

export const CORE_HEADER = `// Core numeric helpers.

/** Return a / b, or \`fallback\` if b is zero. */
export function safeDiv(a, b, fallback = 0) {
  if (b === 0) return fallback;
  return a / b;
}

/** Return the arithmetic mean of \`values\`. */
export function mean(values) {
  if (values.length === 0) throw new RangeError("values must not be empty");
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
`;

export const CLAMP_OK = `
/** Return x restricted to [lo, hi]. */
export function clamp(x, lo, hi) {
  if (lo > hi) throw new RangeError("lo must be <= hi");
  return Math.max(lo, Math.min(x, hi));
}
`;

export const CLAMP_WRONG = `
/** Return x restricted to [lo, hi]. */
export function clamp(x) {
  return x;
}
`;

export const INDEX = `// Small numeric helpers.
export { clamp, mean, safeDiv } from "./core.js";
`;

export const IMPL_OK = { 'mathutils/core.js': CORE_HEADER + CLAMP_OK, 'mathutils/index.js': INDEX };
export const IMPL_WRONG = {
  'mathutils/core.js': CORE_HEADER + CLAMP_WRONG,
  'mathutils/index.js': INDEX,
};

/** Every stage passes on the first round; author replies carry text a critic must never see. */
export function happyScripts(): Scripts {
  return {
    'spec-writer': [writes({ 'task.md': TASK_MD }, 'wrote task.md')],
    'test-author': [writes({ 'tests/clamp.test.js': TEST_CLAMP }, 'AUTHOR-REASONING tests')],
    'test-critic': [verdictPass()],
    coder: [writes(IMPL_OK, 'AUTHOR-REASONING code')],
    'code-critic': [verdictPass()],
    'standards-reviewer': [verdictPass()],
    'security-reviewer': [verdictPass()],
  };
}

/** A Context over a fresh worktree of `repo`, with the base commit recorded. */
export async function makeCtx(
  config: Config,
  repo: string,
  runner: FakeAgentRunner,
  runId = 's1',
): Promise<Context> {
  const ws = await Workspace.create(repo, runId);
  const state = newRunState({ run_id: runId, work_item: 'add clamp', repo });
  state.base_commit = await ws.head();
  return new Context(
    config,
    runner,
    ws,
    new Budget(config.limits.budget_usd_per_task),
    RunLog.forRun(repo, runId),
    state,
  );
}

/** What the spec stage leaves behind: task.md committed as `spec`. */
export async function commitSpec(ctx: Context, taskMd = TASK_MD): Promise<void> {
  mkdirSync(ctx.workspace.path, { recursive: true });
  writeFileSync(path.join(ctx.workspace.path, 'task.md'), taskMd);
  ctx.taskMd = taskMd;
  ctx.state.commits['spec'] = await ctx.workspace.commit('advpipe: spec (task.md)');
}

// ── questions, answers, Bypass ──────────────────────────────────────────────────────────────────

export const QUESTION = 'should lo > hi swap or throw?';
export const QUESTION_2 = 'may lo equal hi?';
export const ANSWER = 'Throw RangeError naming both lo and hi.';
export const AGENT_ANSWER = "Throw RangeError: the spec's AC3 already says lo > hi is an error.";
export const AGENT_REASON = 'AC3 names RangeError for lo > hi; swapping would hide a bug.';

/** A revision that adds the answer as a criterion and has no blocking questions left. */
export const TASK_MD_REVISED = TASK_MD.replace(
  '- [ ] AC3: lo > hi throws RangeError.',
  '- [ ] AC3: lo > hi throws RangeError.\n- [ ] AC4: the RangeError message names lo and hi.',
);

export const secondQuestion = (taskMd = TASK_MD_REVISED): string =>
  taskMd.replace('## Open questions\n- None', `## Open questions\n- BLOCKING: ${QUESTION_2}`);

/** The reply of an agent deciding its own blocking questions (Bypass). */
export const bypassReply = (...ids: string[]): string =>
  JSON.stringify({
    answers: ids.map((id) => ({ id, answer: AGENT_ANSWER, reasoning: AGENT_REASON })),
  });

/** A spec writer that asks one blocking question and nothing else. */
export function blockedScripts(first = TASK_MD_BLOCKING): Scripts {
  return {
    ...happyScripts(),
    'spec-writer': [writes({ 'task.md': first }, 'one blocking question')],
  };
}

/** A resumed run: the spec writer's steps, then every later stage once. */
export function afterAnswers(...specSteps: Step[]): Scripts {
  return {
    ...happyScripts(),
    'spec-writer': specSteps.length > 0 ? specSteps : [writes({ 'task.md': TASK_MD_REVISED })],
  };
}

// ── the solo levels ─────────────────────────────────────────────────────────────────────────────

/** What a solo agent writes besides the implementation. */
export const SOLO_FILES = { 'task.md': TASK_MD, 'tests/clamp.test.js': TEST_CLAMP };
export const SOLO_OK = writes({ ...SOLO_FILES, ...IMPL_OK }, 'AUTHOR-REASONING solo');
export const SOLO_WRONG = writes({ ...SOLO_FILES, ...IMPL_WRONG }, 'wrong');
export const SOLO_REVISED = writes(
  { 'task.md': TASK_MD_REVISED, 'tests/clamp.test.js': TEST_CLAMP, ...IMPL_OK },
  'revised',
);
export const SOLO_ASKS = writes(
  { 'task.md': TASK_MD_BLOCKING, 'mathutils/extra.js': '// written too early\n', ...IMPL_OK },
  'asked a question',
);
