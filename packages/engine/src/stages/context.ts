import type { Config, EventKind, GateResult, RunState } from '@advpipe/contracts';
import type { Budget } from '../core/budget.js';
import { emit } from '../core/events.js';
import type { RunLog } from '../core/runlog.js';
import type { Workspace } from '../core/workspace.js';
import type { AgentRunner } from '../runner/types.js';

/** Everything a stage needs, and the few things stages share (port of `stages.Context`). */
export class Context {
  /** The current task.md, with its Answers section. */
  taskMd = '';
  lastGates: GateResult[] = [];
  /**
   * A person just decided something about the work in the worktree (the scan policy): the next
   * author step judges that work as it is, instead of calling its author first.
   */
  judgeExisting = false;
  /**
   * A person pressed *Try again* after a usage limit cut a step off: the next author call says
   * so, and carries on from the partial work in the worktree.
   */
  cutOff = false;
  /** The Console-credits warning was already shown, so don't show it again. */
  consoleWarned: boolean;
  readonly progress: (message: string) => void;
  /** Fires when the run is cancelled; checked after every agent call and between gates. */
  readonly signal: AbortSignal | undefined;

  constructor(
    readonly config: Config,
    readonly runner: AgentRunner,
    readonly workspace: Workspace,
    readonly budget: Budget,
    readonly runlog: RunLog,
    readonly state: RunState,
    opts: {
      progress?: (message: string) => void;
      consoleWarned?: boolean;
      signal?: AbortSignal | undefined;
    } = {},
  ) {
    this.progress = opts.progress ?? ((): void => undefined);
    this.consoleWarned = opts.consoleWarned ?? false;
    this.signal = opts.signal;
  }

  /** Record a progress event in events.jsonl and pass `message` to the live printer. */
  emit(kind: EventKind, message: string, data: Record<string, unknown> = {}, echo = true): void {
    emit(this.runlog, this.state, this.progress, kind, message, data, echo);
  }

  get specCommit(): string {
    return this.state.commits['spec'] ?? '';
  }

  get testsCommit(): string {
    return this.state.commits['tests'] ?? '';
  }

  /** Copy the budget into the state and write run.json. */
  save(): void {
    this.state.cost_usd = this.budget.spent;
    this.state.cost_by_stage = { ...this.budget.byStage };
    this.state.calls_by_stage = { ...this.budget.callsByStage };
    this.runlog.writeState(this.state);
  }
}
