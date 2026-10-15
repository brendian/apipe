import { describe, expect, it } from 'vitest';
import {
  ageOf,
  DISPLAY_STATUSES,
  FILTERS,
  IPC_TABLE,
  levelText,
  STATUSES,
  titleOf,
} from '../src/index.js';

describe('IPC table', () => {
  it('rejects extra fields, bad run ids and bad filters', () => {
    expect(IPC_TABLE['runs.list'].input.safeParse({ show: 'all' }).success).toBe(true);
    expect(IPC_TABLE['runs.list'].input.safeParse({ show: 'bogus' }).success).toBe(false);
    expect(IPC_TABLE['runs.list'].input.safeParse({ show: 'all', extra: 1 }).success).toBe(false);
    const { input } = IPC_TABLE['runs.detail'];
    expect(input.safeParse({ runId: '20261008-091500-ab12cd' }).success).toBe(true);
    for (const runId of ['../x', 'a/b', '', '.hidden', 'a..b', 'x'.repeat(101)]) {
      expect(input.safeParse({ runId }).success).toBe(false);
    }
  });
});

describe('status tables', () => {
  it('every status has a label, icon and help, and "all" shows every status', () => {
    for (const key of DISPLAY_STATUSES) {
      expect(STATUSES[key].label && STATUSES[key].icon && STATUSES[key].help).toBeTruthy();
      expect(FILTERS.all.statuses.has(key)).toBe(true);
      expect(STATUSES[key].help).not.toMatch(/advpipe (resume|answer|decide)/);
    }
  });

  it('titleOf, ageOf and levelText follow the Python wording', () => {
    expect(titleOf('\n\n## Add clamp\nmore')).toBe('Add clamp');
    expect(titleOf('   ')).toBe('(empty work item)');
    expect(titleOf('x'.repeat(90))).toBe(`${'x'.repeat(79)}…`);
    const now = '2026-10-15T12:00:00Z';
    expect(ageOf('2026-10-15T11:59:30Z', now)).toBe('just now');
    expect(ageOf('2026-10-15T11:55:00Z', now)).toBe('5 min ago');
    expect(ageOf('2026-10-15T09:00:00Z', now)).toBe('3 h ago');
    expect(ageOf('2026-10-14T11:00:00Z', now)).toBe('1 day ago');
    expect(ageOf('2026-10-12T11:00:00Z', now)).toBe('3 days ago');
    expect(levelText('tests')).toBe('Tests (3 of 5)');
  });
});
