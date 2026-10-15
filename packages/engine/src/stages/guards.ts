import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Finding, type GateResult } from '@advpipe/contracts';
import { DecisionNeeded } from '../core/decisions.js';
import { gateFindings, redGateFindings, runGates } from '../core/gates.js';
import type { Context } from './context.js';
import { runGateNames, type StageKind } from './prompts.js';

// Rules enforced in code, not asked for in prompts (docs/02 §12), and the gate runs that use them.

/** Coder may not modify tests: revert any change under the test paths and flag it. */
export async function testFileGuard(ctx: Context, base: string): Promise<Finding[]> {
  const changed = await ctx.workspace.changedFiles(base, ctx.config.paths.tests);
  if (changed.length === 0) return [];
  await ctx.workspace.restore(base, changed);
  return [
    Finding.parse({
      id: 'T-guard',
      severity: 'blocking',
      category: 'scope',
      file: changed[0],
      line: 1,
      criterion: 'guard:tests',
      claim: 'coder modified test files; the changes were reverted',
      evidence: `Reverted: ${changed.join(', ')}`,
    }),
  ];
}

/** How many issues a scanner's output says it found, when it says (semgrep: "2 findings"). */
export function scanHitCount(output: string): number | null {
  const m = /(\d+)\s+(?:code\s+)?findings?\b/i.exec(output);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

/**
 * Blocking findings for failed gates (ground truth). The security scan below full goes through
 * the run's scan policy first: `block` makes its hits blocking like a failing test, `ignore`
 * records them as a minor finding marked as ignored by the person, and `ask` throws
 * `DecisionNeeded`, so the run stops and asks.
 */
export function checkedFindings(ctx: Context, results: GateResult[]): Finding[] {
  const failed = (r: GateResult): boolean => !r.skipped && r.returncode !== 0;
  const hits = results.filter((r) => r.name === 'security' && failed(r));
  const findings = gateFindings(results.filter((r) => !hits.includes(r)));
  const first = hits[0];
  if (first === undefined) return findings;
  const hitFindings = gateFindings(hits);
  const policy = ctx.state.scan_policy;
  if (policy === 'block') return [...findings, ...hitFindings];
  if (policy === 'ask') {
    const count = scanHitCount(first.output);
    const found = count !== null ? `${count} issue(s)` : 'issues';
    throw new DecisionNeeded(
      'scan_hits',
      hitFindings,
      `The security scan reported ${found}. No security reviewer checks them at this ` +
        'level, so some may not be real problems.',
    );
  }
  const ignored: Finding = {
    ...(hitFindings[0] as Finding),
    id: 'G-security-ignored',
    severity: 'minor',
    category: 'security',
    claim: 'Security scan reported issues; ignored by you',
  };
  ctx.state.minor_findings = [
    ...ctx.state.minor_findings.filter((f) => f.id !== ignored.id),
    ignored,
  ];
  return findings;
}

/**
 * Say once in the report when the security scan was meant to run but couldn't (below full; at
 * full the review stage says so).
 */
export function noteScannerSkipped(ctx: Context, results: GateResult[]): void {
  for (const r of results) {
    if (r.name === 'security' && r.skipped) {
      const note = `Security scanner not run (${r.skip_reason}).`;
      if (!ctx.state.notes.includes(note)) ctx.state.notes.push(note);
    }
  }
}

/** The gates a stage runs and the findings they raise: the red gate for tests, all checks for code. */
export async function stageGates(
  ctx: Context,
  kind: StageKind,
): Promise<{ gates: GateResult[]; findings: Finding[] }> {
  if (kind === 'tests') {
    const [result] = await runGates(ctx.config, ctx.workspace.path, ['test'], ctx.signal);
    const newTests = await ctx.workspace.changedFiles(ctx.specCommit, ctx.config.paths.tests);
    return {
      gates: [result as GateResult],
      findings: redGateFindings(result as GateResult, newTests),
    };
  }
  const gates = await runGates(
    ctx.config,
    ctx.workspace.path,
    runGateNames(ctx.state) as ('test' | 'types' | 'lint' | 'security')[],
    ctx.signal,
  );
  noteScannerSkipped(ctx, gates);
  return { gates, findings: checkedFindings(ctx, gates) };
}

export const prefixIds = (findings: Finding[], prefix: string): Finding[] =>
  findings.map((f) => ({ ...f, id: `${prefix}${f.id}` }));

export const inPaths = (file: string, paths: string[]): boolean =>
  paths.some((p) => {
    const dir = p.replace(/\/+$/, '');
    return file === dir || file.startsWith(`${dir}/`);
  });

export const readBytes = (file: string): Buffer | null =>
  existsSync(file) ? readFileSync(file) : null;

/** Put a file back to bytes captured earlier (`null`: it didn't exist, so remove it). */
export function writeBytes(file: string, bytes: Buffer | null): void {
  if (bytes === null) {
    if (existsSync(file)) unlinkSync(file);
  } else {
    writeFileSync(file, bytes);
  }
}

export const taskMdPath = (ctx: Context): string => path.join(ctx.workspace.path, 'task.md');
