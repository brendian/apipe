import { describe, expect, it } from 'vitest';
import { DISPLAY_STATUSES, HelpView, LEVEL_ORDER, Role, STEP_STATE_KEYS } from '@advpipe/contracts';
import { loadHelp, ROLE_TOOLS } from '../src/index.js';

// Port of `test_ui_polish.py`'s help tests: the Help page is built from the code's own tables, so
// these check that it covers everything and shows the real defaults.

describe('help view', () => {
  const help = loadHelp();

  it('is a valid view that covers every status, role, check, step state and level', () => {
    expect(HelpView.safeParse(help).success).toBe(true);
    expect(help.statuses.map((s) => s.key)).toEqual([...DISPLAY_STATUSES]);
    expect(help.statuses.every((s) => s.help && s.next)).toBe(true);
    expect(help.roles.map((r) => r.role).sort()).toEqual([...Role.options].sort());
    expect(help.roles.every((r) => r.job && r.inputs && r.model)).toBe(true);
    expect(help.step_states).toHaveLength(STEP_STATE_KEYS.length);
    expect(help.checks.map((c) => c.name)).toEqual(['test', 'types', 'lint', 'security']);
    expect(help.checks.every((c) => c.help)).toBe(true);
    expect(help.levels.map((l) => l.name)).toEqual([...LEVEL_ORDER]);
    for (const row of help.rule_marks) expect(row.marks).toHaveLength(LEVEL_ORDER.length);
  });

  it('shows the real defaults: models, tools, limits, calls, the scan', () => {
    expect(help.limits).toMatchObject({
      max_rounds_spec: 3,
      max_rounds_tests: 2,
      max_rounds_code: 3,
      max_fix_passes: 3,
      budget_usd_per_task: 15,
    });
    const role = (name: string) => help.roles.find((r) => r.role === name);
    expect(role('coder')).toMatchObject({ model: 'claude-opus-5-5', writes: true });
    expect(role('code-critic')).toMatchObject({ model: 'claude-sonnet-5-5', writes: false });
    expect(role('arbiter')?.tools).toEqual([...ROLE_TOOLS.arbiter]);
    const level = (name: string) => help.levels.find((l) => l.name === name);
    expect(level('basic')).toMatchObject({ number: 1, agents: 1, calls: '1', scan: 'off' });
    expect(level('full')).toMatchObject({ number: 5, scan: 'on', dropped: [] });
    expect(level('full')?.steps).toBe('SPEC → TESTS → CODE → REVIEW → ARBITER → FINAL CHECKS');
    // The rules table: tests-before-code is the one thing a solo level can't do.
    expect(help.rule_marks[1]?.marks.slice(0, 2)).toEqual(['✘ one agent', '✘ one agent']);
    expect(help.rule_marks[3]?.marks[0]).toBe('n/a');
  });

  it("says nothing about a command line, a browser or a token (there's none)", () => {
    const text = JSON.stringify(help);
    expect(text).not.toMatch(/advpipe (run|resume|answer|decide|cancel|clean|ui)\b/);
    expect(text).not.toMatch(/browser|token/i);
  });
});
