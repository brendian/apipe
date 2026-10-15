import { describe, expect, it } from 'vitest';
import {
  DISPLAY_STATUSES,
  VALID,
  allowed,
  decisionNotice,
  parseBudget,
  suggestedBudget,
} from '../src/index.js';

describe('which actions are valid when (docs/05 §7)', () => {
  it('matches the table, and a complete run has none', () => {
    expect(DISPLAY_STATUSES.map((s) => [s, VALID[s].join('+')])).toEqual([
      ['running', 'cancel'],
      ['stopped', 'resume+clean'],
      ['complete', ''],
      ['needs_human', 'clean'],
      ['needs_answers', 'answer+clean'],
      ['needs_decision', 'decide+clean'],
      ['paused', 'decide+clean'],
      ['handed_over', 'clean'],
      ['ended', 'clean'],
      ['finished', 'clean'],
      ['budget_exceeded', 'resume+clean'],
      ['error', 'resume+clean'],
    ]);
    expect(allowed('running', 'resume')).toBe(false);
  });
});

describe('the resume budget', () => {
  it('suggests double, at least $5 more than spent, rounded up', () => {
    expect(suggestedBudget(15.2, 15)).toBe(30);
    expect(suggestedBudget(14, 3)).toBe(19);
    expect(suggestedBudget(1, null)).toBe(30);
  });

  it('parses what was typed and says what is wrong with the rest', () => {
    expect(parseBudget('', 1, false)).toBeNull();
    expect(() => parseBudget(' ', 1, true)).toThrow('ran out of budget');
    expect(parseBudget('$ 20.456', 1, true)).toBe(20.46);
    expect(() => parseBudget('lots', 1, false)).toThrow("'lots' isn't an amount in dollars.");
    expect(() => parseBudget('0', 0, false)).toThrow('positive amount');
    expect(() => parseBudget('-3', 0, false)).toThrow('positive amount');
    expect(() => parseBudget('2', 2.5, false)).toThrow('has spent $2.50 already');
  });

  it('names the notice for a decision', () => {
    expect([decisionNotice('takeover'), decisionNotice('stop'), decisionNotice('fix')]).toEqual([
      'handed_over',
      'ended',
      'decided',
    ]);
  });
});
