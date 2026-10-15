import path from 'node:path';
import {
  BRANCH_PREFIX,
  Config,
  droppedSafeguards,
  maxAgentCalls,
  MAX_TASK_BYTES,
  parseLevel,
  rolesFor,
  SCAN_CHOICES,
  SCAN_FAILURES,
  SETTINGS_CHANGED,
  SHAPES,
  slugify,
  switchValue,
  type Level,
  type RunForm,
  type RunPlan,
  type StartRun,
  WorkItemError,
  type WorkItem,
} from '@advpipe/contracts';
import { ConfigError, loadConfig } from '../core/config.js';
import { startRun, type WorkerOptions } from '../core/control.js';
import { loadWorkItem } from '../core/workitem.js';
import { branchExists } from '../core/workspace.js';
import { newRunId } from '../orchestrator/resume.js';
import { isFileAt, isInside, ItemPathError, itemPath, realish } from './items.js';

// What the New run page shows before it starts, and what starting does (docs/05 §5.4). Port of
// `ui/actions.plan_run` and `_how_much_checking`. The form is merged over the work item's front
// matter, over the config, over the defaults, exactly as the engine does it (docs/02 §16); the
// window never works any of that out.

/** Starting wasn't possible; the message is for a person and is shown as is. */
export class NewRunError extends Error {
  override name = 'NewRunError';
}

type Failures = RunPlan['failures'];

type Checking = {
  level: Level;
  inherited_level: Level;
  level_source: string;
  scan: boolean;
  scan_default: boolean;
  scan_source: string;
  failures: Failures;
  inherited_failures: Failures;
  bypass: boolean;
  inherited_bypass: boolean;
};

const singleLine = (label: string, value: string): string | null =>
  /[\r\n\0]/.test(value) ? `The ${label} must be a single line.` : null;

/** The level, scan, scan policy and Bypass the run would get. Problems go to `errors`. */
function howMuchChecking(
  form: RunForm,
  item: WorkItem | null,
  config: Config,
  configLabel: string,
  errors: string[],
): Checking {
  const pipeline = config.pipeline;
  const fromConfig = configLabel || 'the config';
  let inherited: Level;
  let source: string;
  if (item?.level) {
    inherited = parseLevel(item.level);
    source = "the work item's front matter";
  } else {
    inherited = pipeline.level;
    source = fromConfig;
  }
  let level = inherited;
  if (form.level) {
    try {
      level = parseLevel(form.level);
    } catch {
      errors.push('The level must be 1 (Basic) to 5 (Full).');
    }
  }
  if (!(SCAN_CHOICES as readonly string[]).includes(form.scan)) {
    errors.push('The security scan must be Default, On or Off.');
  }
  if (form.scan_failures && !(SCAN_FAILURES as readonly string[]).includes(form.scan_failures)) {
    errors.push('If the scan finds issues: choose Ask me, Ignore or Block.');
  }

  let configured: boolean;
  let scanSource: string;
  if (item?.security_scan) {
    configured = switchValue(item.security_scan);
    scanSource = "the work item's front matter";
  } else if (pipeline.security_scan !== null) {
    configured = pipeline.security_scan;
    scanSource = fromConfig;
  } else {
    configured = SHAPES[level].securityScan;
    scanSource = "the level's default";
  }
  const scan = form.scan === 'on' ? true : form.scan === 'off' ? false : configured;

  const inheritedFailures = (item?.scan_failures || pipeline.scan_failures) as Failures;
  const failures = (SCAN_FAILURES as readonly string[]).includes(form.scan_failures)
    ? (form.scan_failures as Failures)
    : inheritedFailures;

  const inheritedBypass = item?.bypass_questions
    ? switchValue(item.bypass_questions)
    : pipeline.bypass_questions;
  return {
    level,
    inherited_level: inherited,
    level_source: source,
    scan,
    scan_default: configured,
    scan_source: scanSource,
    failures,
    inherited_failures: inheritedFailures,
    bypass: form.bypass ?? inheritedBypass,
    inherited_bypass: inheritedBypass,
  };
}

/** A start request with everything but its id and repo: those are the host's to add. */
type Pending = Omit<StartRun, 'run_id' | 'repo'>;

async function compute(
  repo: string,
  itemsDir: string,
  form: RunForm,
): Promise<{ plan: RunPlan; pending: Pending | null }> {
  const errors = [singleLine('branch name', form.name), singleLine('config', form.config)].filter(
    (e): e is string => e !== null,
  );
  const warnings: string[] = [];
  let body = '';
  let itemName = '';
  let itemConfig = '';
  let item: WorkItem | null = null;
  let itemFile = '';

  if (form.source === 'item') {
    if (!form.item) {
      errors.push('Pick a work item, or choose to type a one-off task.');
    } else {
      try {
        const file = itemPath(itemsDir, form.item);
        if (!isFileAt(file)) throw new ItemPathError(`There's no work item ${form.item} any more.`);
        item = loadWorkItem(file);
        body = item.body;
        itemName = item.name ?? '';
        itemConfig = item.config ?? '';
        itemFile = realish(file);
      } catch (e) {
        if (e instanceof ItemPathError && e.message.startsWith("There's no")) {
          errors.push(e.message);
        } else if (e instanceof ItemPathError) {
          errors.push(`Work item: ${e.message}`);
        } else if (e instanceof WorkItemError) {
          errors.push(`${form.item} can't be run as it is: ${e.message}. Fix it in the editor.`);
        } else {
          throw e;
        }
      }
    }
  } else if (form.source === 'task') {
    body = form.task.replace(/\r\n|\r/g, '\n').trim();
    if (!body) errors.push('The task is empty: say what to build or fix.');
    else if (body.includes('\0')) errors.push('The task contains a NUL character.');
    else if (Buffer.byteLength(body) > MAX_TASK_BYTES) {
      errors.push(`The task is over ${MAX_TASK_BYTES / 1000} kB. Save it as a work item instead.`);
    }
  } else {
    errors.push('Choose a work item or a one-off task.');
  }

  let config: Config | null = null;
  let budget: number | null = null;
  let configLabel = '';
  let configPath: string | null = null;
  const chosen = form.config || itemConfig;
  try {
    if (chosen) {
      const where = form.config ? 'set here' : "from the work item's front matter";
      const file = realish(path.resolve(realish(repo), chosen));
      if (!isInside(realish(repo), file)) throw new ConfigError(`${chosen} is outside the repo`);
      if (!isFileAt(file)) throw new ConfigError(`${chosen} doesn't exist`);
      config = loadConfig({ file }).config;
      configLabel = `${chosen} (${where})`;
      configPath = file;
    } else {
      config = loadConfig({ repo }).config;
      configLabel = isFileAt(path.join(repo, 'pipeline.toml'))
        ? 'pipeline.toml'
        : "advpipe's defaults (no pipeline.toml)";
    }
    budget = config.limits.budget_usd_per_task;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    errors.push(`Config: ${e.message.trim().split('\n')[0] || e.name}`);
  }

  const cfg = config ?? Config.parse({});
  const checking = howMuchChecking(form, item, cfg, configLabel, errors);

  const name = form.name || itemName;
  const branch = name || body ? BRANCH_PREFIX + slugify(name || body) : '';
  if (branch && (await branchExists(repo, branch))) {
    warnings.push(`Branch ${branch} already exists, so the run makes ${branch}-2 or similar.`);
  }

  const budgetText = budget !== null ? budget.toFixed(2) : '';
  const plan: RunPlan = {
    errors,
    warnings,
    ok: errors.length === 0,
    budget,
    budget_text: budgetText,
    config_label: configLabel,
    branch,
    item_name: itemName,
    item_config: itemConfig,
    level: checking.level,
    inherited_level: checking.inherited_level,
    level_source: checking.level_source,
    scan: checking.scan,
    scan_default: checking.scan_default,
    scan_source: checking.scan_source,
    failures: checking.failures,
    inherited_failures: checking.inherited_failures,
    bypass: checking.bypass,
    inherited_bypass: checking.inherited_bypass,
    agents: rolesFor(checking.level).length,
    calls: maxAgentCalls(checking.level, cfg.limits),
    dropped: droppedSafeguards(checking.level, checking.scan),
    shown_text: [
      checking.level,
      checking.scan ? 'on' : 'off',
      checking.failures,
      checking.bypass ? 'bypass' : 'ask',
    ].join(';'),
  };
  if (errors.length > 0) return { plan, pending: null };

  // The level is always sent: a run never starts at a level nobody saw. The scan only when it was
  // set by someone (here, the item or the config), else the level's own default applies.
  const scanSet = form.scan !== 'default' || checking.scan_source !== "the level's default";
  return {
    plan,
    pending: {
      command: 'run',
      work_item: body,
      work_item_file: itemFile,
      name: name || null,
      config_path: configPath,
      keep_worktree: form.keep_worktree,
      level: checking.level,
      security_scan: scanSet ? checking.scan : null,
      scan_failures: checking.failures,
      bypass_questions: checking.bypass,
      budget_usd: budget,
    },
  };
}

/** What starting a run from `form` would do. Pure over files and git; spawns nothing. */
export async function planRun(repo: string, itemsDir: string, form: RunForm): Promise<RunPlan> {
  return (await compute(repo, itemsDir, form)).plan;
}

/**
 * Start the run the form describes, in a detached worker, if and only if what the person was
 * shown (`shown`, `budgetShown`) is still what is computed now. Returns the new run's id.
 */
export async function startNewRun(
  repo: string,
  itemsDir: string,
  form: RunForm,
  shown: string,
  budgetShown: string,
  opts: WorkerOptions = {},
): Promise<{ runId: string }> {
  const { plan, pending } = await compute(repo, itemsDir, form);
  if (pending === null) throw new NewRunError(plan.errors.join(' '));
  if (shown !== plan.shown_text || budgetShown !== plan.budget_text) {
    throw new NewRunError(SETTINGS_CHANGED);
  }
  const { runId } = startRun(repo, { ...pending, run_id: newRunId(), repo }, opts);
  return { runId };
}
