import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  blockingOpenQuestions,
  COMMIT_KEYS,
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
import {
  answeredQuestions,
  awaitingAnswers,
  awaitingBypass,
  pendingQuestions,
  unappliedQuestions,
  withAnswersSection,
} from '../core/answers.js';
import { Budget, BudgetExceeded } from '../core/budget.js';
import { Cancelled } from '../core/cancel.js';
import type { Explicit } from '../core/config.js';
import { DecisionNeeded, pendingChoice, take } from '../core/decisions.js';
import { emit, gateStatuses } from '../core/events.js';
import { gatesLine, runGates } from '../core/gates.js';
import { renderReport } from '../core/report.js';
import { RunLog } from '../core/runlog.js';
import { Workspace } from '../core/workspace.js';
import { UsageLimitReached, type AgentRunner } from '../runner/types.js';
import {
  adversarialStage,
  arbiterStage,
  ARBITER_NOTE,
  authorFindingsPrompt,
  bypassQuestions,
  callAgent,
  checkedFindings,
  Context,
  finalAuthorPass,
  fixPassExtra,
  fixPassNote,
  NO_ARBITER_NOTE,
  noteScannerSkipped,
  reviewStage,
  REVIEW_PATHS,
  runGateNames,
  singleReviewStage,
  soloPrompt,
  soloRevisionPrompt,
  specPrompt,
  specRevisionPrompt,
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
 * finish. All five levels: the solo ones (Basic, Reviewer) run one agent in SOLO; the others SPEC,
 * TESTS and CODE. Recording a person's answers and decisions happens in the host (`answers.ts`,
 * `decisions.ts`); this class applies them when the run resumes.
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
      const waiting = awaitingAnswers(this.state, this.config.limits.max_rounds_spec);
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
   * wait for a person. Nothing here picks a choice.
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
    const author: Role = shape.solo ? 'solo' : 'coder';
    const kind: StageKind = shape.solo ? 'solo' : 'code';
    this.applyRetry(ctx);
    this.applyScanChoice(ctx);

    if (shape.solo) {
      if (!('solo' in done)) {
        this.enter('SOLO');
        if (!(await this.solo(ctx))) return;
        done['solo'] = await ws.commit('advpipe: solo (task.md, tests, code)');
      } else {
        ctx.taskMd = readFileSync(path.join(ws.path, 'task.md'), 'utf-8');
      }
    } else {
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
      this.askRed(failed, 'the final checks', this.fixer(author));
      return;
    }
    state.stage = 'DONE';
    this.stop('complete');
    if (!this.keepWorktree) {
      await ws.remove();
      state.worktree_removed = true;
    }
  }

  private fixer(author: Role): string {
    return author === 'solo' ? 'solo agent' : author;
  }

  /** The `checks are red` decision point: nothing automatic is left to try. */
  private askRed(
    findings: Finding[],
    where: string,
    fixer: string,
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
      this.askRed(remaining, `${state.stage}, after your fix pass`, this.fixer(author));
      return false;
    }
    return true;
  }

  // ----------------------------------------------------------------------------- SPEC

  /**
   * The spec writer's passes: the first spec, then a revision each time a person (or, under
   * Bypass, the agent) has answered the blocking questions of the last pass. False = the run stops.
   */
  private async spec(ctx: Context): Promise<boolean> {
    const state = this.state;
    const ws = ctx.workspace;
    const cap = this.config.limits.max_rounds_spec;
    this.enter('SPEC');
    const begin = take(state, 'spec_cap', 'begin', 'SPEC');
    if (begin !== null) return this.beginSpec(ctx, begin);
    for (;;) {
      const number = state.spec_passes + 1;
      // The person chose Bypass for some questions: the spec writer answers them itself, once,
      // before the revision that uses the answers.
      await this.bypass(ctx, number);
      const given = unappliedQuestions(state);
      let prompt: string;
      if (given.length > 0) {
        // The worktree's task.md was wiped when the run was reopened: the previous spec is the
        // copy in the run directory.
        const previousMd = this.readRunTaskMd();
        state.round = number;
        this.emit(
          'round',
          `spec pass ${number}/${cap}: revising task.md with the answers to ` +
            given.map((q) => q.id).join(', '),
          { cap },
        );
        this.runlog.writeJson(`spec/pass-${number}/answers.json`, answeredQuestions(state));
        prompt = specRevisionPrompt(state.work_item, previousMd, answeredQuestions(state));
      } else {
        prompt = specPrompt(state.work_item);
      }
      const result = await callAgent(ctx, 'spec-writer', prompt, 'spec');
      state.spec_passes = number;
      for (const q of given) q.applied = true;
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
      let taskMd = readFileSync(taskPath, 'utf-8');
      if (answeredQuestions(state).length > 0) {
        // The answers, verbatim, written by code: later agents see them as part of the contract,
        // and no agent can drop or reword them.
        taskMd = withAnswersSection(taskMd, state.questions);
        writeFileSync(taskPath, taskMd);
      }
      const pdir = `spec/pass-${number}`;
      this.setTaskMd(ctx, taskMd, pdir);
      const outcome = await this.questionStop(ctx, taskMd, number, pdir, false);
      if (outcome === 'stop') return false;
      if (outcome === 'again') continue;
      if (outcome === 'go') {
        taskMd = withAnswersSection(taskMd, state.questions);
        writeFileSync(taskPath, taskMd);
        this.setTaskMd(ctx, taskMd, pdir);
      }
      state.commits[COMMIT_KEYS.SPEC] = await ws.commit('advpipe: spec (task.md)');
      return true;
    }
  }

  private readRunTaskMd(): string {
    const file = this.runlog.path('task.md');
    return existsSync(file) ? readFileSync(file, 'utf-8') : '';
  }

  private setTaskMd(ctx: Context, taskMd: string, pdir: string): void {
    ctx.taskMd = taskMd;
    this.runlog.writeText('task.md', taskMd);
    this.runlog.writeText(`${pdir}/task.md`, taskMd);
  }

  /**
   * What the blocking questions of the pass just finished (the spec writer's, or the solo agent's)
   * mean for the run:
   * - `none`: there are none, carry on;
   * - `stop`: the run stopped (waiting for answers, or at the *Begin work?* decision);
   * - `again`: Bypass is on, so the agent answers them and runs another pass;
   * - `go`: Bypass is on and this was the last pass: the agent has answered them, and the answers
   *   go into task.md without another revision.
   */
  private async questionStop(
    ctx: Context,
    taskMd: string,
    number: number,
    pdir: string,
    solo: boolean,
  ): Promise<'none' | 'again' | 'stop' | 'go'> {
    const state = this.state;
    const cap = this.config.limits.max_rounds_spec;
    const fresh = this.newQuestions(blockingOpenQuestions(taskMd), number);
    if (fresh.length === 0) return 'none';
    const ids = fresh.map((q) => q.id);
    const who = solo ? 'solo agent' : 'spec';
    if (state.bypass_questions) {
      // Bypass up front (or *Begin work*): nobody is asked. Each pass is still capped; at the cap
      // the agent's answers go in without another revision and the run begins work. The solo agent
      // first gets one more pass, because the pass that asked the questions did none of the work.
      for (const q of fresh) q.bypassed = true;
      this.emit(
        'questions',
        `${who} has ${fresh.length} blocking question(s); Bypass is on, so the agent decides them`,
        { ids, answerable: false, bypassed: true },
      );
      if (number < cap || (solo && number === cap)) return 'again';
      await this.bypass(ctx, number, `${pdir}/bypass.json`);
      for (const q of fresh) q.applied = true;
      state.notes.push(
        `The spec still had blocking questions after ${number} spec pass(es), the limit ` +
          '(limits.max_rounds_spec); the agent decided them and the run went on (Bypass).',
      );
      return 'go';
    }
    const findings = fresh.map((q) => blocker(q.id, 'open-question', q.text));
    this.stop('needs_human', findings);
    if (number >= cap) {
      // The pass at the cap still has blocking questions: don't ask them one more time. *Begin
      // work?* lets the agent decide them, and every later question.
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
        `${who} has ${fresh.length} blocking question(s); answer them on the run's page.`,
        { ids, answerable: true },
      );
    }
    return 'stop';
  }

  /**
   * *Begin work*: from now on the agent decides every question, including those still waiting, so
   * nothing stops the run for questions again.
   */
  private begin(d: Decision): void {
    const state = this.state;
    state.bypass_questions = true;
    for (const q of pendingQuestions(state)) q.bypassed = true;
    d.applied = true;
    this.emit(
      'decision',
      'you chose to begin work: the agent decides the open questions, and any later one',
      { decision_kind: 'spec_cap', choice: 'begin', decision_stage: d.stage },
    );
  }

  /**
   * *Begin work* at the spec stage: the spec writer answers the questions the last pass left open,
   * the answers go into task.md without another revision pass, and the spec is committed.
   */
  private async beginSpec(ctx: Context, d: Decision): Promise<boolean> {
    const state = this.state;
    const ws = ctx.workspace;
    this.begin(d);
    const number = state.spec_passes;
    await this.bypass(ctx, number, `spec/pass-${number}/bypass-begin.json`);
    for (const q of state.questions) if (q.answer) q.applied = true;
    const taskMd = withAnswersSection(this.readRunTaskMd(), state.questions);
    writeFileSync(path.join(ws.path, 'task.md'), taskMd);
    this.setTaskMd(ctx, taskMd, `spec/pass-${number}`);
    state.notes.push(
      `The spec still had blocking questions after ${number} spec pass(es), the limit ` +
        '(limits.max_rounds_spec); you chose to begin work, and the agent decided them.',
    );
    state.commits[COMMIT_KEYS.SPEC] = await ws.commit('advpipe: spec (task.md)');
    return true;
  }

  /**
   * Have the agent that wrote task.md (the spec writer, or the solo agent) answer the questions a
   * person bypassed. Does nothing when there are none.
   */
  private async bypass(ctx: Context, number: number, rel?: string): Promise<void> {
    const waiting = awaitingBypass(this.state);
    if (waiting.length === 0) return;
    const solo = SHAPES[this.state.level].solo;
    const role: Role = solo ? 'solo' : 'spec-writer';
    const where = solo ? this.soloDir() : `spec/pass-${number}`;
    await bypassQuestions(
      ctx,
      role,
      waiting,
      this.readRunTaskMd(),
      solo ? 'solo' : 'spec',
      rel ?? `${where}/bypass.json`,
    );
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

  // ----------------------------------------------------------------------------- SOLO

  /**
   * The solo agent's stage (Basic and Reviewer): task.md, tests and code in one pass, or the
   * blocking questions and nothing else. One agent call per entry and no automatic retries: red
   * checks stop and ask. False = the run stops.
   */
  private async solo(ctx: Context): Promise<boolean> {
    const state = this.state;
    const ws = ctx.workspace;
    const cap = this.config.limits.max_rounds_spec;
    const taskPath = path.join(ws.path, 'task.md');
    if (existsSync(taskPath)) ctx.taskMd = readFileSync(taskPath, 'utf-8');
    const fix = take(state, 'red_checks', 'fix', 'SOLO');
    if (fix !== null) return this.soloFix(ctx, fix);
    const begin = take(state, 'spec_cap', 'begin', 'SOLO');
    if (begin !== null) this.begin(begin);
    if (ctx.judgeExisting) {
      ctx.judgeExisting = false;
      return this.soloChecks(ctx, this.soloDir(true));
    }
    for (;;) {
      const number = state.spec_passes + 1;
      await this.bypass(ctx, number);
      const given = unappliedQuestions(state);
      const pdir = this.soloDir();
      let prompt: string;
      if (given.length > 0) {
        const previousMd = this.readRunTaskMd();
        state.round = number;
        this.emit(
          'round',
          `solo pass ${number}/${cap}: with the answers to ${given.map((q) => q.id).join(', ')}`,
          { cap },
        );
        this.runlog.writeJson(`${pdir}/answers.json`, answeredQuestions(state));
        prompt = soloRevisionPrompt(ctx, previousMd, answeredQuestions(state));
      } else {
        prompt = soloPrompt(ctx);
      }
      const result = await callAgent(ctx, 'solo', prompt, 'solo');
      state.spec_passes = number;
      for (const q of given) q.applied = true;
      this.runlog.writeText(`${pdir}/author.txt`, result.text);
      if (!existsSync(taskPath)) return this.soloChecks(ctx, pdir);
      let taskMd = readFileSync(taskPath, 'utf-8');
      if (answeredQuestions(state).length > 0) {
        taskMd = withAnswersSection(taskMd, state.questions);
        writeFileSync(taskPath, taskMd);
      }
      this.setTaskMd(ctx, taskMd, pdir);
      const outcome = await this.questionStop(ctx, taskMd, number, pdir, true);
      if (outcome === 'stop') {
        await this.revertAllButTaskMd(ctx, 'solo agent', 'while it had blocking questions');
        return false;
      }
      if (outcome === 'again') {
        await this.revertAllButTaskMd(ctx, 'solo agent', 'while it had blocking questions');
        continue;
      }
      if (outcome === 'go') {
        taskMd = withAnswersSection(taskMd, state.questions);
        writeFileSync(taskPath, taskMd);
        this.setTaskMd(ctx, taskMd, pdir);
      }
      return this.soloChecks(ctx, pdir);
    }
  }

  /** `stage-solo/pass-N` for the next solo pass (or, `newest`, the last one). */
  private soloDir(newest = false): string {
    const root = this.runlog.path('stage-solo');
    const count = existsSync(root)
      ? readdirSync(root).filter((n) => n.startsWith('pass-')).length
      : 0;
    return `stage-solo/pass-${newest ? Math.max(count, 1) : count + 1}`;
  }

  /** An agent that stopped on blocking questions mustn't leave code behind. */
  private async revertAllButTaskMd(ctx: Context, who: string, why: string): Promise<void> {
    const ws = ctx.workspace;
    const state = this.state;
    const stray = (await ws.changedFiles(state.base_commit)).filter((f) => f !== 'task.md');
    if (stray.length > 0) {
      await ws.restore(state.base_commit, stray);
      state.notes.push(`The ${who} edited files ${why}; reverted: ${stray.join(', ')}`);
    }
  }

  /** A person-requested pass by the solo agent, then the checks. */
  private async soloFix(ctx: Context, d: Decision): Promise<boolean> {
    const state = this.state;
    const ws = ctx.workspace;
    const number = state.fix_passes + 1;
    const cap = this.config.limits.max_fix_passes;
    const pdir = this.soloDir();
    this.emit('round', `fix pass ${number}/${cap}: you asked for another pass`, { cap });
    this.runlog.writeJson(`${pdir}/request.json`, {
      fix_pass: number,
      note: d.note,
      findings: d.findings,
    });
    const prompt = authorFindingsPrompt(d.findings, ctx.lastGates, fixPassNote(number));
    const result = await callAgent(ctx, 'solo', prompt + fixPassExtra(d.note), 'solo');
    state.fix_passes = number;
    d.applied = true;
    this.runlog.writeText(`${pdir}/author.txt`, result.text);
    const taskPath = path.join(ws.path, 'task.md');
    if (existsSync(taskPath)) {
      let taskMd = readFileSync(taskPath, 'utf-8');
      if (answeredQuestions(state).length > 0) {
        taskMd = withAnswersSection(taskMd, state.questions);
        writeFileSync(taskPath, taskMd);
      }
      this.setTaskMd(ctx, taskMd, pdir);
    }
    return this.soloChecks(ctx, pdir);
  }

  /** The solo stage's checks: task.md exists, then the gates. Red stops and asks. */
  private async soloChecks(ctx: Context, pdir: string): Promise<boolean> {
    const state = this.state;
    const ws = ctx.workspace;
    const findings: Finding[] = [];
    if (!existsSync(path.join(ws.path, 'task.md'))) {
      findings.push(blocker('S1', 'guard:task-md', 'the solo agent did not produce task.md'));
    }
    const gates = await runGates(this.config, ws.path, runGateNames(state), this.signal);
    noteScannerSkipped(ctx, gates);
    ctx.lastGates = gates;
    this.runlog.writeJson(`${pdir}/gates.json`, gates);
    this.runlog.writeText(`${pdir}/diff.patch`, await ws.diff(state.base_commit, REVIEW_PATHS));
    this.emit('gates', `gates: ${gatesLine(gates)}`, { gates: gateStatuses(gates) });
    findings.push(...checkedFindings(ctx, gates));
    if (findings.length > 0) {
      this.askRed(
        findings,
        "the solo agent's pass",
        'solo agent',
        "The solo agent doesn't retry by itself.",
      );
      return false;
    }
    return true;
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
          this.fixer(author),
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
