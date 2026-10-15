import { Cancelled } from '../src/core/cancel.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isGrounded, type GateResult } from '@advpipe/contracts';
import {
  formatGates,
  gateFindings,
  gatesLine,
  redGateFindings,
  runGate,
  TAIL_LINES,
  tail,
} from '../src/index.js';

const node = (code: string): string[] => [process.execPath, '-e', code];
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'advpipe-gates-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('runGate', () => {
  it('skips an empty command, and a missing optional tool', async () => {
    const empty = await runGate('lint', [], dir, 10);
    expect(empty.skipped && gateFindings([empty]).length === 0).toBe(true);
    const scan = await runGate('security', ['definitely-not-a-tool-xyz'], dir, 10);
    expect(scan.skipped).toBe(true);
    expect(scan.skip_reason).toContain('not installed');
  });

  it('fails a missing required tool with exit 127', async () => {
    const r = await runGate('lint', ['definitely-not-a-tool-xyz'], dir, 10);
    expect(r.returncode).toBe(127);
    expect(r.output).toBe('definitely-not-a-tool-xyz: command not found');
  });

  it('turns a failed gate into a grounded blocking finding with only the output tail', async () => {
    const r = await runGate(
      'test',
      node("console.log(Array.from({length:200},(_, i)=>i).join('\\n')); process.exit(3)"),
      dir,
      10,
    );
    expect(r.returncode).toBe(3);
    const [f] = gateFindings([r]);
    expect(f).toMatchObject({ id: 'G-test', severity: 'blocking', criterion: 'gate:test' });
    expect(isGrounded(f!)).toBe(true);
    expect(f!.evidence.split('\n')[0]).toBe('140');
    expect(f!.evidence.split('\n').at(-1)).toBe('199');
  });

  it('passes a good gate and merges stderr after stdout', async () => {
    const r = await runGate('test', node("console.log('out'); console.error('err')"), dir, 10);
    expect(r.returncode).toBe(0);
    expect(r.output).toBe('out\nerr');
    expect(gateFindings([r])).toEqual([]);
  });

  it('times out with exit 124 and kills the process', async () => {
    const r = await runGate('test', node('setTimeout(() => {}, 30000)'), dir, 1);
    expect(r.returncode).toBe(124);
    expect(r.output).toContain('[timed out]');
  });

  it('rejects when the run is cancelled', async () => {
    const ac = new AbortController();
    const p = runGate('test', node('setTimeout(() => {}, 30000)'), dir, 60, ac.signal);
    setTimeout(() => ac.abort(), 200);
    await expect(p).rejects.toBeInstanceOf(Cancelled);
  });
});

describe('pure helpers', () => {
  const result = (rc: number | null, skipped = false): GateResult => ({
    name: 'test',
    command: ['pytest'],
    returncode: rc,
    output: 'boom',
    skipped,
    skip_reason: skipped ? 'x' : '',
  });

  it('tail keeps the last 60 lines', () => {
    expect(tail(Array(500).fill('x').join('\n')).split('\n')).toHaveLength(TAIL_LINES);
  });

  it('red gate: needs new tests, a configured gate, and a failure', () => {
    expect(redGateFindings(result(1), [])[0]!.id).toBe('G-tests-missing');
    expect(redGateFindings(result(null, true), ['t.js'])[0]!.id).toBe('G-tests-skipped');
    expect(redGateFindings(result(0), ['t.js'])[0]!.claim).toContain('pass before implementation');
    expect(redGateFindings(result(1), ['t.js'])).toEqual([]);
  });

  it('summaries', () => {
    expect(gatesLine([result(1), result(0), result(null, true)])).toBe(
      'test FAIL, test pass, test skipped',
    );
    expect(gatesLine([])).toBe('none configured');
    expect(formatGates([])).toBe('(no gates run)');
  });
});
