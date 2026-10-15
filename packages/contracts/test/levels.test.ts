import { describe, expect, it } from 'vitest';
import {
  Config,
  droppedSafeguards,
  LEVEL_ORDER,
  levelTag,
  maxAgentCalls,
  parseLevel,
  rolesFor,
  stepsFor,
  type Level,
} from '../src/index.js';

const limits = Config.parse({}).limits;

describe('levels', () => {
  it('parses names and numbers, and says what it accepts otherwise', () => {
    expect(parseLevel('Tests')).toBe('tests');
    expect(parseLevel(' 3 ')).toBe('tests');
    expect(parseLevel(5)).toBe('full');
    expect(() => parseLevel('x')).toThrow(
      "unknown level 'x': use one of basic, reviewer, tests, adversarial, full, or 1 to 5",
    );
    expect(() => parseLevel(6)).toThrow('unknown level 6');
  });

  it('counts agent calls the way the original does (happy, worst)', () => {
    const calls = Object.fromEntries(LEVEL_ORDER.map((l) => [l, maxAgentCalls(l, limits)]));
    expect(calls).toEqual({
      basic: [1, 1],
      reviewer: [2, 4],
      tests: [4, 11],
      adversarial: [5, 23],
      full: [7, 30],
    });
  });

  it('derives roles, steps and dropped safeguards from the shape', () => {
    expect(rolesFor('basic')).toEqual(['solo']);
    expect(rolesFor('full')).toHaveLength(8);
    expect(rolesFor('full')).not.toContain('solo');
    expect(stepsFor('basic')).toEqual(['SOLO', 'FINAL_GATES']);
    expect(stepsFor('adversarial')).toEqual(['SPEC', 'TESTS', 'CODE', 'ARBITER', 'FINAL_GATES']);
    expect(droppedSafeguards('full', true)).toEqual([]);
    for (const level of LEVEL_ORDER.filter((l): l is Level => l !== 'full')) {
      expect(droppedSafeguards(level, false).length).toBeGreaterThan(0);
    }
    expect(droppedSafeguards('tests', false).at(-1)).toBe('No security scan');
  });

  it('tags a level only when the scan differs from the default', () => {
    expect(levelTag({ level: 'full', security_scan: true })).toBe('');
    expect(levelTag({ level: 'full', security_scan: null })).toBe('');
    expect(levelTag({ level: 'tests', security_scan: false })).toBe('tests');
    expect(levelTag({ level: 'tests', security_scan: true })).toBe('tests, scan');
    expect(levelTag({ level: 'full', security_scan: false })).toBe('full, no scan');
  });
});
