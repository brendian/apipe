import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  blockingOpenQuestions,
  Config,
  Decision,
  DECISION_CHOICES,
  Finding,
  levelTag,
  newRunState,
  normalise,
  limitExplanation,
  OpenQuestion,
  scanOn,
  SHAPES,
  type DecisionKind,
  type EventKind,
  type RateLimitSnapshot,
  type Role,
  type Ruling,
  type RunState,
  type Stage,
  type StageResult,
  type Status,
} from '@advpipe/contracts';
import { Budget, BudgetExceeded } from '../core/budget.js';
import { Cancelled } from '../core/cancel.js';
import type { Explicit } from '../core/config.js';
import { DecisionNeeded, pendingChoice, take } from '../core/decisions.js';
import { emit } from '../core/events.js';
import { runGates } from '../core/gates.js';
import { renderReport } from '../core/report.js';
import { RunLog } from '../core/runlog.js';
import { Workspace } from '../core/workspace.js';
import { UsageLimitReached, type AgentRunner } from '../runner/types.js';
import {
  adversarialStage,
  arbiterStage,
  ARBITER_NOTE,
  callAgent,
  checkedFindings,
  Context,
  finalAuthorPass,
  fixPassExtra,
  fixPassNote,
  NO_ARBITER_NOTE,
  noteScannerSkipped,
  reviewStage,
  runGateNames,
  singleReviewStage,
  specPrompt,
  type StageKind,
} from '../stages/index.js';
import { checkResumable, checkSameShape, newRunId } from './resume.js';

// Budget keys of the stages `settle` can settle (StageResult.name -> Budget stage).
const BUDGET_STAGE: Record<string, string> = {
  tests: 'stage-tests',
  code: 'stage-code',
  solo: 'solo',
  review: 'review',
};

const blocker = (id: string, criterion: string, claim: string): Finding =>
  Finding.parse({ id, severity: 'blocking', category: 'scope', criterion, claim });

/**
 * The run stopped on blocking spec questions a person can still answer (the report says where).
 * M4 version: `answers.ts` (M5) replaces it with the full rule.
 */
function waitingOnAnswers(state: RunState, cap: number): boolean {
  return (
    state.status === 'needs_human' &&
    state.stage === 'SPEC' &&
    !('spec' in state.commits) &&
    state.spec_passes < cap &&
    state.questions.some((q) => !q.answer && !q.bypassed)
  );
}

export type OrchestratorOptions = {
  runId?: string;
  keepWorktree?: boolean;
  /** An existing run's state (resume). */
  state?: RunState;
  progress?: (message: string) => void;
  /** Names the branch (`advpipe/<slug>`); defaults to the work item's first line. */
  name?: string;
  workItemFile?: string;
  consoleWarned?: boolean;
  /** Fires when the run is cancelled (the worker's abort signal). */
  signal?: AbortSignal;
};

/**
 * INIT -> SPEC -> TESTS -> CODE -> REVIEW -> [ARBITER] -> FINAL_GATES -> a terminal status.
 *
 * Agents are called by this class; they never decide whether a stage runs. Each completed stage is
 * committed and recorded in run.json, so an interrupted run resumes at the first stage that didn't
 * finish. M4 drives levels Tests, Adversarial and Full; the solo levels, answers, Bypass and
 * recording decisions arrive in M5.
 */
export class Orchestrator {
  readonly repo: string;
  readonly state: RunState;
  readonly runId: string;
  readonly runlog: RunLog;
  readonly budget: Budget;
  readonly keepWorktree: boolean;
  ctx: Context | null = null;
  private readonly progress: (message: string) => void;
  private readonly name: string | undefined;
  private readonly consoleWarned: boolean;
  private readonly signal: AbortSignal | undefined;

  constructor(
    readonly config: Config,
    readonly runner: AgentRunner,
    repo: string,
    workItem: string,
    opts: OrchestratorOptions = {},
  ) {
    if (opts.state === undefined && workItem.trim() === '') {
      throw new Error('work_item must not be empty');
    }
    this.repo = path.resolve(repo);
    this.keepWorktree = opts.keepWorktree ?? false;
    this.state = opts.state ?? this.newState(opts.runId, workItem, opts.workItemFile ?? '');
    this.runId = this.state.run_id;
    if (SHAPES[this.state.level].solo || this.state.bypass_questions) {
      throw new Error(
        'levels Basic and Reviewer, and Bypass, are not built yet (milestone M5); use Tests, Adversarial or Full',
      );
    }
    this.runlog = RunLog.forRun(this.repo, this.runId);
    this.budget = new Budget(
      config.limits.budget_usd_per_task,
      this.state.cost_usd,
      this.state.cost_by_stage,
      this.state.calls_by_stage,
    );
    this.progress = opts.progress ?? ((): void => undefined);
    this.name = opts.name;
    this.consoleWarned = opts.consoleWarned ?? false;
    this.signal = opts.signal;
  }

  /**
   * A new run's state. Its level and scan setting come from the effective config (explicit choice,
   * front matter and pipeline.toml already merged) and never change.
   */
  private newState(runId: string | undefined, workItem: string, workItemFile: string): RunState {
    const pipeline = this.config.pipeline;
    const state = newRunState({
      run_id: runId ?? newRunId(),
      work_item: workItem,
      work_item_file: workItemFile,
      repo: this.repo,
      level: pipeline.level,
      security_scan: pipeline.security_scan,
      scan_policy: pipeline.scan_failures,
      bypass_questions: pipeline.bypass_questions,
    });
    state.security_scan = scanOn(state); // the level's default, when not set
    return state;
  }

  /** Reload an interrupted run from run.json. Uses the run's saved config unless one is given. */
  static async resume(
    runner: AgentRunner,
    repo: string,
    runId: string,
    opts: {
      config?: Config;
      /** Which keys `config` set explicitly (from `loadConfig`), for the same-shape check. */
      explicit?: Explicit;
      budgetUsd?: number | null;
      keepWorktree?: boolean;
      progress?: (message: string) => void;
      lockedForMe?: boolean;
      consoleWarned?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<Orchestrator> {
    const root = path.resolve(repo);
    const state = await checkResumable(root, runId, { lockedForMe: opts.lockedForMe ?? false });
    if (opts.config !== undefined) checkSameShape(state, opts.config, opts.explicit ?? {});
    let cfg = opts.config ?? RunLog.forRun(root, runId).readConfig() ?? Config.parse({});
    // config.json says what the run runs under, so it mustn't contradict the run's own level and
    // scan setting (e.g. a run whose config.json predates levels).
    const p = cfg.pipeline;
    const scan = p.security_scan ?? SHAPES[p.level].securityScan;
    if (
      p.level !== state.level ||
      scan !== scanOn(state) ||
      p.bypass_questions !== state.bypass_questions
    ) {
      cfg = {
        ...cfg,
        pipeline: {
          ...p,
          level: state.level,
          security_scan: scanOn(state),
          bypass_questions: state.bypass_questions,
        },
      };
    }
    if (opts.budgetUsd != null) {
      cfg = { ...cfg, limits: { ...cfg.limits, budget_usd_per_task: opts.budgetUsd } };
    }
    const o: OrchestratorOptions = { state };
    if (opts.keepWorktree !== undefined) o.keepWorktree = opts.keepWorktree;
    if (opts.progress !== undefined) o.progress = opts.progress;
    if (opts.consoleWarned !== undefined) o.consoleWarned = opts.consoleWarned;
    if (opts.signal !== undefined) o.signal = opts.signal;
    return new Orchestrator(cfg, runner, root, state.work_item, o);
  }

  async run(): Promise<RunState> {
    this.runlog.acquireLock();
    try {
      await this.drive();
    } catch (e) {
      if (e instanceof DecisionNeeded) {
        this.ask(e.kind, e.findings, e.explanation);
      } else if (e instanceof UsageLimitReached) {
        this.askUsage(e);
      } else if (e instanceof BudgetExceeded) {
        this.state.status = 'budget_exceeded';
        this.state.notes.push(e.message);
        this.emit('status', e.message, { status: this.state.status });
      } else if (e instanceof Cancelled) {
        // Interrupted (the app's cancel): status stays "running", so it's resumable.
        this.state.notes.push(`Interrupted during ${this.state.stage}`);
        this.emit('status', 'interrupted; press Resume to continue', {
          status: this.state.status,
        });
        throw e;
      } else {
        // Any failure must end in a recorded state.
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        this.state.status = 'error';
        this.state.notes.push(msg);
        this.emit('error', `error: ${msg}`);
      }
    } finally {
      this.state.cost_usd = this.budget.spent;
      this.state.cost_by_stage = { ...this.budget.byStage };
      this.state.calls_by_stage = { ...this.budget.callsByStage };
      this.runlog.writeState(this.state);
      const waiting = waitingOnAnswers(this.state, this.config.limits.max_rounds_spec);
      this.runlog.writeText('report.md', renderReport(this.state, { waitingOnAnswers: waiting }));
      // The last event of every process driving the run; not shown in the live log.
      this.emit(
        'status',
        `run ended: ${this.state.status}`,
        { status: this.state.status, final: true, total_usd: this.budget.spent },
        false,
      );
      this.runlog.releaseLock();
    }
    return this.state;
  }

  private emit(
    kind: EventKind,
    message: string,
    data: Record<string, unknown> = {},
    echo = true,
  ): void {
    emit(this.runlog, this.state, this.progress, kind, message, data, echo);
  }

  private enter(stage: Stage): void {
    this.state.stage = stage;
    this.state.round = 0;
    this.emit('stage', `== ${stage}`);
    this.runlog.writeState(this.state);
  }

  private stop(status: Status, openFindings: Finding[] = []): void {
    this.state.status = status;
    if (openFindings.length > 0) this.state.open_findings = openFindings;
  }

  /**
   * Stop at a decision point: record what's being asked, leave the worktree exactly as it is, and
   * wait for a person. Nothing here picks a choice. (Recording the choice is M5.)
   */
  private ask(
    kind: DecisionKind,
    findings: Finding[],
    explanation: string,
    opts: { stage?: Stage; usageSnapshot?: RateLimitSnapshot | null; billing?: boolean } = {},
  ): void {
    const asked = Decision.parse({
      kind,
      stage: opts.stage ?? this.state.stage,
      explanation,
      findings,
      usage: opts.usageSnapshot ?? null,
      billing: opts.billing ?? false,
    });
    this.state.decisions.push(asked);
    this.state.status = 'needs_human';
    this.state.open_findings = findings;
    this.emit('decision', explanation, {
      decision_kind: kind,
      choice: 'asked',
      decision_stage: asked.stage,
      choices: [...DECISION_CHOICES[kind]],
    });
  }

  /** A usage limit or the Console credit balance ran out: pause at a `usage_limit` decision. */
  private askUsage(limit: UsageLimitReached): void {
    const where = this.state.stage.toLowerCase().replace(/_/g, ' ');
    this.ask('usage_limit', [], limitExplanation(where, limit.snapshot, limit.billing), {
      usageSnapshot: limit.snapshot,
      billing: limit.billing,
    });
  }

  /** *Try again* after a usage limit: the interrupted step starts again with its partial work kept. */
  private applyRetry(ctx: Context): void {
    const d = take(this.state, 'usage_limit', 'retry');
    if (d === null) return;
    d.applied = true;
    ctx.cutOff = true;
    this.emit(
      'decision',
      `trying again after the usage limit: ${d.stage} starts again with its partial work kept`,
      { decision_kind: 'usage_limit', choice: 'retry', decision_stage: d.stage },
    );
  }

  /** A person decided what a failing security scan means: set the policy, judge the work as it is. */
  private applyScanChoice(ctx: Context): void {
    const d = take(this.state, 'scan_hits', 'ignore') ?? take(this.state, 'scan_hits', 'block');
    if (d === null) return;
    this.state.scan_policy = d.choice === 'ignore' ? 'ignore' : 'block';
    d.applied = true;
    ctx.judgeExisting = true;
    const what = d.choice === 'ignore' ? 'recorded as minor findings' : 'blocking findings';
    this.emit(
      'decision',
      `security scan hits: ${d.choice}; the scan keeps running and its hits are ${what}`,
      { decision_kind: 'scan_hits', choice: d.choice, decision_stage: d.stage },
    );
  }

  private async openWorkspace(): Promise<Workspace> {
    const state = this.state;
    if (state.branch) {
      state.notes.push(`Resumed at stage ${state.stage}`);
      this.emit('run_start', `resuming run ${this.runId} at stage ${state.stage}`, {
        level: state.level,
        security_scan: scanOn(state),
      });
      // A person has just decided what to do about the work in the worktree: keep it.
      const keep = pendingChoice(state);
      state.status = 'running';
      state.open_findings = [];
      // What it runs under from now on (e.g. a new budget), so the UI and a later resume see it.
      this.runlog.writeConfig(this.config);
      if (keep && !existsSync(state.worktree)) {
        state.notes.push(
          'The worktree was gone when the run resumed; it was recreated from the branch, so the ' +
            'uncommitted work from before your decision is lost.',
        );
      }
      return Workspace.reopen(this.repo, state.worktree, state.branch, { keepChanges: keep });
    }
    this.runlog.writeConfig(this.config);
    // A readable branch: from the given name, else from the work item's first line.
    const ws = await Workspace.create(this.repo, this.runId, this.name ?? state.work_item);
    state.worktree = ws.path;
    state.branch = ws.branch;
    state.base_commit = await ws.head();
    const tag = levelTag(state);
    const at = tag ? ` at level ${tag}` : '';
    this.emit('run_start', `run ${this.runId} started${at}; branch ${ws.branch}`, {
      branch: ws.branch,
      level: state.level,
      security_scan: scanOn(state),
    });
    this.emit('run_start', `worktree: ${ws.path}`, { worktree: ws.path });
    return ws;
  }

  private async drive(): Promise<void> {
    const state = this.state;
    this.runlog.writeState(state);
    const ws = await this.openWorkspace();
    const ctx = new Context(this.config, this.runner, ws, this.budget, this.runlog, state, {
      progress: this.progress,
      consoleWarned: this.consoleWarned,
      signal: this.signal,
    });
    this.ctx = ctx;
    const done = state.commits;
    const shape = SHAPES[state.level];
    const author: Role = 'coder';
    const kind: StageKind = 'code';
    this.applyRetry(ctx);
    this.applyScanChoice(ctx);

    if ('spec' in done) {
      ctx.taskMd = readFileSync(path.join(ws.path, 'task.md'), 'utf-8');
    } else if (!(await this.spec(ctx))) {
      return;
    }

    if (!('tests' in done)) {
      this.enter('TESTS');
      if (!(await this.stage(ctx, 'test-author', 'tests'))) return;
      done['tests'] = await ws.commit('advpipe: tests');
    }

    if (!('code' in done)) {
      this.enter('CODE');
      if (!(await this.stage(ctx, 'coder', 'code'))) return;
      done['code'] = await ws.commit('advpipe: implementation');
    }

    if (shape.review !== 'none' && !('review' in done)) {
      this.enter('REVIEW');
      const fix = take(state, 'red_checks', 'fix', 'REVIEW');
      if (fix !== null) {
        if (!(await this.personFix(ctx, fix, author, kind, 'review'))) return;
      } else {
        if (ctx.lastGates.length === 0) {
          // Resumed: the reviewers still need current gate output.
          ctx.lastGates = await runGates(this.config, ws.path, runGateNames(state), this.signal);
        }
        const result =
          shape.review === 'full' ? await reviewStage(ctx) : await singleReviewStage(ctx);
        if (!(await this.settle(result, author, kind, shape.arbiter))) return;
      }
      const changed = await ws.changedFiles(await ws.head());
      done['review'] =
        changed.length > 0 ? await ws.commit('advpipe: review fixes') : await ws.head();
    }

    this.enter('FINAL_GATES');
    const fix = take(state, 'red_checks', 'fix', 'FINAL_GATES');
    if (fix !== null && !(await this.personFix(ctx, fix, author, kind, 'fix'))) return;
    const gates = await runGates(this.config, ws.path, runGateNames(state), this.signal);
    noteScannerSkipped(ctx, gates);
    this.runlog.writeJson('final-gates.json', gates);
    const failed = checkedFindings(ctx, gates);
    if (failed.length > 0) {
      ctx.lastGates = gates;
      this.askRed(failed, 'the final checks', author);
      return;
    }
    state.stage = 'DONE';
    this.stop('complete');
    if (!this.keepWorktree) {
      await ws.remove();
      state.worktree_removed = true;
    }
  }

  /** The `checks are red` decision point: nothing automatic is left to try. */
  private askRed(
    findings: Finding[],
    where: string,
    fixer: Role,
    tried = '',
    opts: { stage?: Stage } = {},
  ): void {
    const names = [
      ...new Set(
        findings
          .filter((f) => f.criterion?.startsWith('gate:'))
          .map((f) => (f.criterion as string).split(':', 2)[1] as string),
      ),
    ].sort();
    const failing = names.length > 0 ? ` (${names.join(', ')})` : '';
    const used = this.state.fix_passes;
    const cap = this.config.limits.max_fix_passes;
    const explanation =
      `The checks are still failing at ${where}${failing}. ` +
      (tried ? `${tried} ` : '') +
      `Another fix pass by the ${fixer}, with the failing output and a note from you if you ` +
      `like (fix pass ${used + 1} of ${cap}); or take over: the work so far is committed to ` +
      `the branch ${this.state.branch} and the worktree removed, so you can finish it by hand.`;
    this.ask('red_checks', findings, explanation, opts.stage ? { stage: opts.stage } : {});
  }

  /**
   * The tests or code stage: its author <-> critic rounds, then `settle`. After a person asked for
   * a fix pass at this stage, that pass instead.
   */
  private async stage(ctx: Context, author: Role, kind: 'tests' | 'code'): Promise<boolean> {
    const shape = SHAPES[this.state.level];
    const fix = take(this.state, 'red_checks', 'fix', kind === 'tests' ? 'TESTS' : 'CODE');
    if (fix !== null) {
      return this.personFix(ctx, fix, author, kind, BUDGET_STAGE[kind] as string);
    }
    const result = await adversarialStage(ctx, kind, { critic: shape.critics });
    return this.settle(result, author, kind, shape.arbiter);
  }

  /**
   * One more author pass because a person asked for it: the failing output and the person's note
   * verbatim, no critic round afterwards. The gates decide: green carries on, red asks again.
   * False = the run stops.
   */
  private async personFix(
    ctx: Context,
    d: Decision,
    author: Role,
    kind: StageKind,
    charged: string,
  ): Promise<boolean> {
    const state = this.state;
    const number = state.fix_passes + 1;
    const cap = this.config.limits.max_fix_passes;
    this.emit('round', `fix pass ${number}/${cap}: you asked for another pass`, { cap });
    const remaining = await finalAuthorPass(ctx, author, d.findings, kind, {
      note: fixPassNote(number),
      stage: charged,
      extra: fixPassExtra(d.note),
      rdir: `fix-pass-${number}`,
    });
    // Counted once the pass has run, so one an interrupt cut short runs again on resume.
    state.fix_passes = number;
    d.applied = true;
    if (remaining.length > 0) {
      this.askRed(remaining, `${state.stage}, after your fix pass`, author);
      return false;
    }
    return true;
  }

  // ----------------------------------------------------------------------------- SPEC

  /**
   * The spec writer's pass. M4: the first pass only; blocking questions stop the run (answering,
   * revisions and Bypass are M5). False = the run stops.
   */
  private async spec(ctx: Context): Promise<boolean> {
    const state = this.state;
    const ws = ctx.workspace;
    const cap = this.config.limits.max_rounds_spec;
    this.enter('SPEC');
    const number = state.spec_passes + 1;
    const result = await callAgent(ctx, 'spec-writer', specPrompt(state.work_item), 'spec');
    state.spec_passes = number;
    this.runlog.writeText(
      number === 1 ? 'spec/author.txt' : `spec/pass-${number}/author.txt`,
      result.text,
    );
    const stray = (await ws.changedFiles(state.base_commit)).filter((f) => f !== 'task.md');
    if (stray.length > 0) {
      await ws.restore(state.base_commit, stray);
      state.notes.push(
        `Spec writer edited files other than task.md; reverted: ${stray.join(', ')}`,
      );
    }
    const taskPath = path.join(ws.path, 'task.md');
    if (!existsSync(taskPath)) {
      this.stop('needs_human', [blocker('S1', 'spec', 'spec writer did not produce task.md')]);
      return false;
    }
    const taskMd = readFileSync(taskPath, 'utf-8');
    this.setTaskMd(ctx, taskMd, `spec/pass-${number}`);
    if (this.questionStop(taskMd, number, cap) === 'stop') return false;
    state.commits['spec'] = await ws.commit('advpipe: spec (task.md)');
    return true;
  }

  private setTaskMd(ctx: Context, taskMd: string, pdir: string): void {
    ctx.taskMd = taskMd;
    this.runlog.writeText('task.md', taskMd);
    this.runlog.writeText(`${pdir}/task.md`, taskMd);
  }

  /**
   * What the pass's blocking questions mean for the run: `none`, or `stop` (waiting for answers, or
   * at the *Begin work?* decision when this was the last allowed pass).
   */
  private questionStop(taskMd: string, number: number, cap: number): 'none' | 'stop' {
    const fresh = this.newQuestions(blockingOpenQuestions(taskMd), number);
    if (fresh.length === 0) return 'none';
    const ids = fresh.map((q) => q.id);
    const findings = fresh.map((q) => blocker(q.id, 'open-question', q.text));
    this.stop('needs_human', findings);
    if (number >= cap) {
      // The pass at the cap still has blocking questions: don't ask them one more time.
      const n = fresh.length;
      const explanation =
        `The spec still has ${n} blocking question${n !== 1 ? 's' : ''} after ${number} ` +
        `pass${number !== 1 ? 'es' : ''}. Begin work anyway? The agent will decide these, and ` +
        'any question that comes up later in this run, itself.';
      this.emit('questions', explanation, { ids, answerable: false });
      this.ask('spec_cap', findings, explanation);
    } else {
      this.emit(
        'questions',
        `spec has ${fresh.length} blocking question(s); answer them on the run's page.`,
        { ids, answerable: true },
      );
    }
    return 'stop';
  }

  /**
   * Record this pass's blocking questions with fresh ids (numbering continues across passes). A
   * question that was already answered isn't asked again: its answer stands.
   */
  private newQuestions(asked: string[], number: number): OpenQuestion[] {
    const state = this.state;
    const done = new Map(
      state.questions.filter((q) => q.answer).map((q) => [normalise(q.text), q]),
    );
    const fresh: OpenQuestion[] = [];
    for (const text of asked) {
      const again = done.get(normalise(text));
      if (again !== undefined) {
        state.notes.push(`Spec writer asked ${again.id} again; its answer stands.`);
        continue;
      }
      const q = OpenQuestion.parse({
        id: `Q${state.questions.length + 1}`,
        text,
        asked_in: number,
      });
      state.questions.push(q);
      fresh.push(q);
    }
    return fresh;
  }

  // ----------------------------------------------------------------------------- SETTLE

  /**
   * Record a stage result; send open findings to the arbiter, then one final author pass on those
   * ruled fix. Without an arbiter every open finding is ruled fix, with the reason recorded. Checks
   * still red after that stop at a `red_checks` decision point. False = the run stops.
   */
  private async settle(
    result: StageResult,
    author: Role,
    kind: StageKind,
    arbiter: boolean,
  ): Promise<boolean> {
    const ctx = this.ctx as Context;
    const state = this.state;
    state.minor_findings.push(...result.minor_findings);
    if (result.passed) return true;
    const previous = state.stage;
    let rulings: Ruling[];
    let note: string;
    let charged: string;
    if (arbiter) {
      this.enter('ARBITER');
      rulings = await arbiterStage(ctx, result.open_findings, result.name);
      state.rulings.push(...rulings);
      this.runlog.writeJson('arbiter.json', state.rulings);
      note = ARBITER_NOTE;
      charged = 'arbiter';
    } else {
      const reason = `no arbiter at level ${state.level}`;
      rulings = result.open_findings.map((d) => ({
        finding_id: d.finding.id,
        decision: 'fix' as const,
        reason,
      }));
      for (const r of rulings) {
        this.emit('ruling', `  ${r.finding_id}: fix (${reason})`, {
          finding_id: r.finding_id,
          decision: r.decision,
        });
      }
      state.rulings.push(...rulings);
      // Charged to the stage being settled: there's no arbiter step at this level.
      note = NO_ARBITER_NOTE;
      charged = BUDGET_STAGE[result.name] as string;
    }
    const fixIds = new Set(rulings.filter((r) => r.decision === 'fix').map((r) => r.finding_id));
    const toFix = result.open_findings
      .filter((d) => fixIds.has(d.finding.id))
      .map((d) => d.finding);
    if (toFix.length > 0) {
      const remaining = await finalAuthorPass(ctx, author, toFix, kind, { note, stage: charged });
      if (remaining.length > 0) {
        // The run stays "in" the arbiter step; the decision remembers the stage that was being
        // settled, which is where a fix pass goes.
        this.askRed(
          remaining,
          previous,
          author,
          "The step's rounds, the rulings and a final fix pass didn't clear them.",
          { stage: previous },
        );
        return false;
      }
    }
    state.stage = previous;
    return true;
  }
}
