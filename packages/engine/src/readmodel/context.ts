import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  Config,
  SHAPES,
  titleOf,
  rolesFor,
  type ContextView,
  type Level,
  type Role,
  type RunState,
} from '@advpipe/contracts';
import { git } from '../core/git.js';
import { checkRunId, RunLog } from '../core/runlog.js';
import { loadPrompt, ROLE_MODEL, ROLE_TOOLS } from '../runner/roles.js';
import { ALL_GATES } from '../stages/prompts.js';
import { readText } from './detail.js';
import { quote } from './next-steps.js';
import { markdown, taskMarkdown } from './render.js';
import { displayStatus, isDirectory } from './runs.js';

// What the "Spec & context" tab shows: everything the agents of one run worked from — the work
// item, `task.md`, the config and checks, the standards doc and the role prompts — each with who
// sees it. Port of `ui/context.py`. The "who sees" text describes what `stages` actually puts in
// each agent's prompt; keep the two in step. As in detail.ts, a missing or unreadable file is
// shown as such rather than failing the page.

type SeenBy = ContextView['seen_by'];

/** Who sees each block, in plain words. Critics never see an author's reasoning. */
export const SEEN_BY: SeenBy = {
  work_item:
    'The spec writer only. Every later agent works from task.md instead, never from the work ' +
    'item itself.',
  task_md:
    'Written by the spec writer. Every other agent gets it in its prompt: the test author, test ' +
    'critic, coder, code critic, both reviewers and the arbiter. Critics cite its acceptance ' +
    'criteria (AC1, AC2, ...) in their findings.',
  config:
    'No agent. The orchestrator uses it for the models, round caps, turn limit, budget and ' +
    'check commands.',
  checks:
    'The test author and coder get the test, types and lint commands in their prompt and run ' +
    "them. Critics, reviewers and the arbiter get the check output, never the author's " +
    "reasoning. The security scanner's output goes to the security reviewer.",
  standards:
    "In its prompt: the standards reviewer only. Separately, Claude Code loads the repo's " +
    "CLAUDE.md into every agent's context (advpipe uses the project's settings).",
  prompts:
    'Each role gets its own prompt as its system prompt. Shown as installed now: a run started ' +
    'with an older advpipe may have used different text.',
};

const names = (roles: readonly Role[]): string =>
  roles.map((r) => r.replaceAll('-', ' ')).join(', ');

/**
 * `SEEN_BY` for a run at `level`: the same text at full, and at the other levels only the agents
 * that level has (no mention of critics where there are none).
 */
export function seenByFor(level: Level): SeenBy {
  if (level === 'full') return SEEN_BY;
  const roles = rolesFor(level);
  const solo = SHAPES[level].solo;
  const writer: Role = solo ? 'solo' : 'spec-writer';
  const readers = roles.filter((r) => r !== 'solo' && r !== 'spec-writer');
  const judges = roles.filter((r) => /(?:critic|reviewer)$/.test(r) || r === 'arbiter');
  const authors = roles.filter((r) => r === 'solo' || r === 'test-author' || r === 'coder');
  const out: SeenBy = { ...SEEN_BY };
  out.work_item = solo
    ? 'The solo agent only: it writes task.md from it itself.'
    : SEEN_BY.work_item;
  out.task_md =
    `Written by the ${writer.replaceAll('-', ' ')}. ` +
    (readers.length > 0
      ? `Every other agent at this level gets it in its prompt: ${names(readers)}.`
      : "No other agent at this level reads it: it's the record of what was asked.") +
    (roles.some((r) => r.endsWith('critic'))
      ? ' Critics cite its acceptance criteria (AC1, AC2, ...) in their findings.'
      : '');
  out.checks =
    `The ${names(authors)} get the check commands in their prompt and run them.` +
    (judges.length > 0
      ? " The critic, reviewers and arbiter get the check output, never the author's reasoning."
      : '');
  if (!roles.includes('standards-reviewer')) {
    out.standards =
      "No agent at this level reads it directly: there's no standards reviewer. Separately, " +
      "Claude Code loads the repo's CLAUDE.md into every agent's context (advpipe uses the " +
      "project's settings).";
  }
  return out;
}

/** What each role gets in its (user) prompt, from `stages/prompts.ts`. */
export const ROLE_INPUTS: Readonly<Record<Role, string>> = {
  'spec-writer': 'the work item',
  'test-author':
    'task.md and the check commands; in later rounds, the findings to address and the latest ' +
    'check output',
  'test-critic': 'task.md, the diff of the new tests, and the check output',
  coder:
    'task.md, the check commands and the list of test files; in later rounds, the findings to ' +
    'address and the latest check output',
  solo:
    'the work item and the check commands; after answers, its previous task.md and the ' +
    'questions with their answers; in later passes, the findings to address, the latest check ' +
    'output and any note from you',
  'code-critic': 'task.md, the list of test files, the diff, and the check output',
  'standards-reviewer': 'task.md, the full diff, the check output, and the standards doc',
  'security-reviewer':
    "task.md, the full diff, the check output, and the security scanner's output",
  arbiter:
    "task.md, the current diff, the check output, and the open findings with each author's " +
    'response',
};

export const CHECK_HELP: Readonly<Record<string, string>> = {
  test: 'the test suite',
  types: 'the type checker',
  lint: 'the linter',
  security: 'the security scanner, run once before the review',
};
/** The pipeline's checks, then the scanner (which runs only before the review). */
export const CHECKS = [...ALL_GATES, 'security'] as const;

// A git revision from run.json, before it goes on a git command line (an argument list, never a
// shell): no leading '-', so it can't be read as an option.
const REV_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;

function configView(log: RunLog): ContextView['config'] {
  const raw = readText(log.path('config.json'));
  if (raw === null) return { config: null, raw: null, error: '' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return {
      config: null,
      raw,
      error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const parsed = Config.safeParse(json);
  if (!parsed.success) {
    const n = parsed.error.issues.length;
    const first = parsed.error.issues[0];
    return { config: null, raw, error: `${n} problem(s): ${first?.message ?? 'invalid'}` };
  }
  // Shown re-indented, in case it was written compactly.
  return { config: parsed.data, raw: JSON.stringify(json, null, 2), error: '' };
}

/** `p` from config.json if it's a plain relative path inside the repo, else null. */
export function safeRepoPath(p: string): string | null {
  if (
    p === '' ||
    p.startsWith('-') ||
    p.startsWith('/') ||
    /^[A-Za-z]:/.test(p) ||
    p.includes('\\')
  ) {
    return null;
  }
  const parts = p.split('/');
  if (parts.includes('..') || p.includes('\0')) return null;
  return parts.filter((part) => part !== '' && part !== '.').join('/') || null;
}

/**
 * The standards doc as the run saw it: the reviewers read it from the run's working copy, so
 * prefer the run's branch, then the commit it started from, then the repo as it is now.
 */
async function standardsView(
  repo: string,
  state: RunState,
  config: Config | null,
): Promise<ContextView['standards']> {
  const configured = (config ?? Config.parse({})).paths.standards_doc;
  const file = safeRepoPath(configured);
  if (file === null)
    return { path: configured, html: null, source: "its path isn't inside the repo" };
  const candidates: [string, string][] = [
    [state.branch, `on the run's branch ${state.branch}`],
    [state.base_commit, `at the commit the run started from (${state.base_commit.slice(0, 12)})`],
  ];
  for (const [rev, where] of candidates) {
    if (rev && REV_RE.test(rev) && !rev.includes('..')) {
      try {
        return {
          path: file,
          html: markdown(await git(repo, 'cat-file', 'blob', `${rev}:${file}`)),
          source: where,
        };
      } catch {
        // not on that revision: try the next
      }
    }
  }
  try {
    const real = realpathSync(path.join(repo, file));
    const inside = path.relative(realpathSync(repo), real);
    if (!inside.startsWith('..') && !path.isAbsolute(inside) && statSync(real).isFile()) {
      return { path: file, html: markdown(readFileSync(real, 'utf-8')), source: 'in the repo now' };
    }
  } catch {
    // missing
  }
  return { path: file, html: null, source: '' };
}

function rolesView(config: Config | null, level: Level): ContextView['roles'] {
  const models = (config ?? Config.parse({})).models;
  return rolesFor(level).map((role) => {
    let prompt: string | null = null;
    try {
      prompt = markdown(loadPrompt(role));
    } catch {
      // the prompt file couldn't be read
    }
    const tools = [...ROLE_TOOLS[role]];
    return {
      role,
      name: role.replaceAll('-', ' '),
      model: models[ROLE_MODEL[role]],
      tools,
      read_only: !tools.some((t) => t === 'Edit' || t === 'Write' || t === 'Bash'),
      inputs: ROLE_INPUTS[role],
      prompt_html: prompt,
    };
  });
}

/**
 * The Spec & context tab for `runId`, or null if there is no such run. Throws if run.json exists
 * but can't be read.
 */
export async function loadContext(repo: string, runId: string): Promise<ContextView | null> {
  const log = RunLog.forRun(repo, checkRunId(runId));
  if (!isDirectory(log.root) || !existsSync(log.path('run.json'))) return null;
  const state = log.readState();
  const config = configView(log);
  const taskText = readText(log.path('task.md'));
  return {
    run_id: state.run_id,
    status: displayStatus(state, log),
    title: titleOf(state.work_item, 120),
    live: displayStatus(state, log) === 'running',
    level: state.level,
    work_item: {
      text: state.work_item,
      html: state.work_item.trim() ? markdown(state.work_item) : null,
      file: state.work_item_file,
    },
    task: taskText === null ? null : taskMarkdown(taskText),
    config,
    checks: config.config
      ? CHECKS.map((name) => ({
          name,
          command: (config.config?.gates[name] ?? []).map((p) => quote(p, 'posix')).join(' '),
          help: CHECK_HELP[name] ?? '',
        }))
      : [],
    standards: await standardsView(repo, state, config.config),
    roles: rolesView(config.config, state.level),
    seen_by: seenByFor(state.level),
    answers: state.questions.filter((q) => q.answer),
  };
}
