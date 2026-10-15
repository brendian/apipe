import type { DisplayStatus, RunRow } from '@advpipe/contracts';

// Which run status changes are worth a desktop notification, and the dock badge count (docs/05
// §5.9). Pure: the window code does the showing. A notification says the run's title and its status
// and nothing an agent wrote, because it can be read over a shoulder.

/** A run in one of these needs the person (the badge counts them). */
export const NEEDS_YOU: ReadonlySet<DisplayStatus> = new Set<DisplayStatus>([
  'needs_human',
  'needs_answers',
  'needs_decision',
  'paused',
  'error',
  'budget_exceeded',
]);

export type Note = { runId: string; title: string; status: DisplayStatus };

/**
 * Remembers each run's last status. `update` returns the runs that just moved to "needs you" or
 * "complete", once per change; the first call only learns the starting point, so reopening a repo
 * doesn't announce what was already waiting.
 */
export class StatusTracker {
  private seen: Map<string, DisplayStatus> | null = null;

  update(rows: readonly RunRow[]): { notes: Note[]; badge: number } {
    const previous = this.seen;
    const next = new Map(rows.map((r) => [r.run_id, r.status] as const));
    const notes: Note[] = [];
    if (previous !== null) {
      for (const r of rows) {
        const worth = r.status === 'complete' || NEEDS_YOU.has(r.status);
        if (worth && previous.get(r.run_id) !== r.status) {
          notes.push({ runId: r.run_id, title: r.title, status: r.status });
        }
      }
    }
    this.seen = next;
    return { notes, badge: rows.filter((r) => NEEDS_YOU.has(r.status)).length };
  }
}
