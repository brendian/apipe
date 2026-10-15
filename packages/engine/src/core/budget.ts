// Cost tracking with a hard abort when the per-task budget is crossed (docs/02 §13).

export class BudgetExceeded extends Error {
  override name = 'BudgetExceeded';
  constructor(
    readonly spent: number,
    readonly limit: number,
  ) {
    super(`budget exceeded: $${spent.toFixed(2)} spent, limit $${limit.toFixed(2)}`);
  }
}

export class Budget {
  spent: number;
  readonly byStage: Record<string, number>;
  readonly callsByStage: Record<string, number>;

  constructor(
    public limit: number,
    spent = 0,
    byStage: Record<string, number> = {},
    callsByStage: Record<string, number> = {},
  ) {
    this.spent = spent;
    this.byStage = { ...byStage };
    this.callsByStage = { ...callsByStage };
  }

  /** Record a cost. Throws BudgetExceeded as soon as the limit is crossed. */
  add(costUsd: number, stage = ''): void {
    this.spent += costUsd;
    this.byStage[stage] = (this.byStage[stage] ?? 0) + costUsd;
    this.callsByStage[stage] = (this.callsByStage[stage] ?? 0) + 1;
    if (this.spent > this.limit) throw new BudgetExceeded(this.spent, this.limit);
  }

  /** What is left of the task budget (passed to each agent as its own cap). */
  get remaining(): number {
    return Math.max(this.limit - this.spent, 0);
  }
}
