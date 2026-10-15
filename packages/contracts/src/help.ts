import { z } from 'zod';
import { DISPLAY_STATUSES, type DisplayStatus } from './statuses.js';
import { LEVEL_ORDER, SHAPES } from './levels.js';
import { Role } from './primitives.js';

// The Help page (docs/05 §5.8): the pipeline in plain words, built from the tables the code uses so
// it can't drift. Ported from `ui/routes/help.py`; the wording that named the browser, the token or
// the CLI is changed for a desktop app with buttons (docs/02 §19).

/** What to do about each status, in plain words. One entry per displayed status (a test checks). */
export const STATUS_NEXT: Readonly<Record<DisplayStatus, string>> = {
  running: 'Watch it, or cancel it from its page. It carries on if you close the window.',
  stopped: "Resume it from its page, or clean it up if you don't want it any more.",
  complete: 'Read the change, then merge the branch yourself. The run page has the commands.',
  needs_human:
    'Open the run and read "What\'s left open". Finish the branch by hand, or clean it up ' +
    'and start a new run with a clearer work item.',
  needs_answers:
    "Open the run and answer the spec's questions in the form there. The same run carries " +
    'on: the spec writer revises task.md with your answers, then the usual steps run.',
  needs_decision:
    'Open the run and choose: another fix pass (with a note, if you like) or take over; ' +
    "ignore or block the security scan's hits; or begin work and let the agent decide the " +
    'questions. The same run carries on.',
  paused:
    'Open the run. A usage limit (or the Console credit balance) ran out and the work so ' +
    'far is kept. Add extra usage or credits, or wait for the reset, then press Try again; ' +
    'or finish it as it is. Nothing retries by itself.',
  finished:
    'Look at the uncommitted work in its working copy (the run page has the commands). ' +
    "Clean it up when you're done; cleaning asks before deleting uncommitted work.",
  handed_over:
    'Check the branch out and finish it by hand: the run page has the command. Clean it up ' +
    "when you're done.",
  ended: 'Nothing to do: you stopped it. Clean it up, or start a new run.',
  budget_exceeded: 'Resume it with a bigger budget, or clean it up.',
  error: 'Read the report for the error, then resume it, or clean it up.',
};

/** Which role does what, in plain words. One entry per role (a test checks). */
export const ROLE_JOBS: Readonly<Record<Role, string>> = {
  'spec-writer':
    'Turns your work item into task.md: numbered acceptance criteria, scope and open questions.',
  'test-author':
    'Writes tests for the acceptance criteria before any code exists. It sees task.md only.',
  'test-critic': 'Looks for missing, weak or wrong tests.',
  coder: 'Changes the code until the tests and checks pass. It may not edit the tests.',
  solo:
    'At the Basic and Reviewer levels, does everything in one pass: writes task.md, the tests ' +
    'and the code, or stops with blocking questions for you.',
  'code-critic': 'Looks for bugs, unmet criteria and tests that pass for the wrong reason.',
  'standards-reviewer': "Checks the change follows the repo's standards doc and stays in scope.",
  'security-reviewer': "Checks the change for security problems, with the scanner's output.",
  arbiter:
    "Decides, finding by finding, whether to fix or dismiss what's still open after a step's " +
    'last round or the review.',
};

/** The design rules (CLAUDE.md), as the Help page's level-by-level table lists them. */
export const RULES = [
  '1. The orchestrator is code, not an agent',
  '2. Tests before code (the test author sees task.md only)',
  '3. One writer at a time; reviewers are read-only',
  '4. Critics get artifacts, not reasoning',
  '5. Every loop is bounded',
  '6. Critics may PASS; findings are grounded',
  '7. A failed check is a blocking finding',
] as const;

/** For each design rule, its mark at each level (in slider order): ✔, ✘ one agent, or n/a. */
export function ruleMarks(): { rule: string; marks: string[] }[] {
  return RULES.map((rule, i) => ({
    rule,
    marks: LEVEL_ORDER.map((level) => {
      const shape = SHAPES[level];
      const n = i + 1;
      if (n === 2 && shape.solo) return '✘ one agent';
      if ((n === 4 || n === 6) && !shape.critics && shape.review === 'none') return 'n/a';
      return '✔';
    }),
  }));
}

export const HelpView = z.strictObject({
  levels: z.array(
    z.strictObject({
      number: z.number().int(),
      name: z.string(),
      label: z.string(),
      good_for: z.string(),
      description: z.string(),
      agents: z.number().int(),
      steps: z.string(),
      calls: z.string(),
      scan: z.enum(['on', 'off']),
      dropped: z.array(z.string()),
    }),
  ),
  level_labels: z.array(z.string()),
  rule_marks: z.array(z.strictObject({ rule: z.string(), marks: z.array(z.string()) })),
  step_states: z.array(z.strictObject({ label: z.string(), help: z.string() })),
  roles: z.array(
    z.strictObject({
      role: Role,
      job: z.string(),
      inputs: z.string(),
      model: z.string(),
      tools: z.array(z.string()),
      writes: z.boolean(),
    }),
  ),
  checks: z.array(z.strictObject({ name: z.string(), help: z.string() })),
  statuses: z.array(
    z.strictObject({
      key: z.enum(DISPLAY_STATUSES),
      label: z.string(),
      icon: z.string(),
      help: z.string(),
      next: z.string(),
    }),
  ),
  limits: z.strictObject({
    max_rounds_spec: z.number().int(),
    max_rounds_tests: z.number().int(),
    max_rounds_code: z.number().int(),
    max_fix_passes: z.number().int(),
    budget_usd_per_task: z.number(),
  }),
});
export type HelpView = z.infer<typeof HelpView>;

/** What About shows: the app's own versions, nothing about the user or their repos. */
export const AboutView = z.strictObject({
  name: z.string(),
  version: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
});
export type AboutView = z.infer<typeof AboutView>;
