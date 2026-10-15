import { describe, expect, it } from 'vitest';
import {
  ADD_CREDITS_URL,
  ADD_USAGE_URL,
  consoleWarning,
  describe as describeWindow,
  limitExplanation,
  RateLimitSnapshot,
} from '../src/index.js';

const snap = (over: Record<string, unknown> = {}) =>
  RateLimitSnapshot.parse({
    window: 'five_hour',
    status: 'rejected',
    seen_at: '2026-10-08T10:00:00Z',
    ...over,
  });

describe('usage wording', () => {
  it('says what a window has used, or that it has reset since', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    expect(
      describeWindow(snap({ utilization: 0.62, resets_at: '2026-10-09T12:00:00Z' }), now),
    ).toMatch(/^5-hour: 62% used, resets /);
    expect(describeWindow(snap({ resets_at: '2026-10-08T11:00:00Z' }), now)).toBe(
      '5-hour: reset since; usage unknown',
    );
    expect(describeWindow(snap({ window: 'seven_day' }), now)).toBe('weekly: limit reached');
  });

  it('explains each kind of limit with the fixed links only', () => {
    const credits = limitExplanation('CODE', null, true);
    expect(credits).toContain('Console credit balance ran out during the CODE step');
    expect(credits).toContain(ADD_CREDITS_URL);
    const sub = limitExplanation('SPEC', snap(), false);
    expect(sub).toContain("Your Claude subscription's 5-hour usage limit was reached");
    expect(sub).toContain(ADD_USAGE_URL);
    expect(limitExplanation('SPEC', null, false)).toContain('(no details were given)');
  });

  it('points at resuming, not at a command, in the Console warning', () => {
    expect(consoleWarning(15)).toBe(
      'Warning: this run uses Anthropic Console credits, which is real money. It can spend up ' +
        'to $15.00 (the budget; change it when you resume the run).',
    );
  });
});
