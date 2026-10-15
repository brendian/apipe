import { describe, expect, it } from 'vitest';
import type { DisplayStatus, RunRow } from '@advpipe/contracts';
import { StatusTracker } from '../src/main/notify.js';

const row = (run_id: string, status: DisplayStatus): RunRow => ({
  run_id,
  status,
  title: `Run ${run_id}`,
  branch: '',
  stage: 'CODE',
  cost_usd: 0,
  budget_usd: null,
  started_at: '2026-10-15T10:00:00Z',
  work_item_file: '',
  level: 'full',
});

describe('desktop notifications and the badge', () => {
  it('announces a run once when it needs you or completes, never what was already waiting', () => {
    const t = new StatusTracker();
    // The first look only learns where things are (and counts the badge).
    expect(t.update([row('a', 'needs_answers'), row('b', 'running')])).toEqual({
      notes: [],
      badge: 1,
    });
    expect(t.update([row('a', 'needs_answers'), row('b', 'running')]).notes).toEqual([]);

    const moved = t.update([row('a', 'needs_answers'), row('b', 'needs_decision')]);
    expect(moved.notes).toEqual([{ runId: 'b', title: 'Run b', status: 'needs_decision' }]);
    expect(moved.badge).toBe(2);
    expect(t.update([row('a', 'needs_answers'), row('b', 'needs_decision')]).notes).toEqual([]);

    // Resuming and finishing are two changes; only the second is worth a notification.
    expect(t.update([row('b', 'running')]).notes).toEqual([]);
    const done = t.update([row('b', 'complete'), row('c', 'stopped')]);
    expect(done.notes.map((n) => [n.runId, n.status])).toEqual([['b', 'complete']]);
    expect(done.badge).toBe(0); // complete and stopped runs don't count as needing you
  });
});
