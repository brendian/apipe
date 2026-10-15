import { spawn, spawnSync } from 'node:child_process';
import {
  gatePassed,
  GATE_NAMES,
  splitLines,
  type Config,
  type Finding,
  type GateName,
  type GateResult,
  gateSummary,
} from '@advpipe/contracts';
import { which } from './which.js';

// Run the configured check commands and turn failures into blocking findings (docs/02 §10).

export const TAIL_LINES = 60;
export const TAIL_CHARS = 4000;

/** Gates whose tool may be absent: skipped (and reported) rather than failed. */
export const OPTIONAL_GATES: ReadonlySet<string> = new Set(['security']);

// Keep at most this much of each stream in memory; only the tail is ever reported.
const KEEP_BYTES = 1024 * 1024;

export function tail(text: string): string {
  return splitLines(text.trimEnd()).slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS);
}

const skipped = (name: string, command: string[], reason: string): GateResult => ({
  name,
  command,
  returncode: null,
  output: '',
  skipped: true,
  skip_reason: reason,
});

const finished = (name: string, command: string[], code: number, output: string): GateResult => ({
  name,
  command,
  returncode: code,
  output,
  skipped: false,
  skip_reason: '',
});

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL'); // the gate leads its own process group
    }
  } catch {
    // already gone
  }
}

function collect(chunks: Buffer[]): { push(b: Buffer): void; text(): string } {
  let size = 0;
  return {
    push(b) {
      chunks.push(b);
      size += b.length;
      while (size > KEEP_BYTES && chunks.length > 1) size -= chunks.shift()!.length;
    },
    text: () => Buffer.concat(chunks).toString('utf-8'),
  };
}

/** Run one gate. Rejects only if `signal` aborts (the run was cancelled); a gate failing is a result. */
export async function runGate(
  name: string,
  command: string[],
  cwd: string,
  timeoutS: number,
  signal?: AbortSignal,
): Promise<GateResult> {
  const exe = command[0];
  if (exe === undefined) return skipped(name, command, 'not configured');
  signal?.throwIfAborted();
  const resolved = which(exe, cwd);
  if (resolved === null) {
    if (OPTIONAL_GATES.has(name)) return skipped(name, command, `${exe} not installed`);
    return finished(name, command, 127, `${exe}: command not found`);
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // must not leak into a gate (docs/04 §10)
  const child = spawn(resolved, command.slice(1), {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const out = collect([]);
  const err = collect([]);
  child.stdout.on('data', (b: Buffer) => out.push(b));
  child.stderr.on('data', (b: Buffer) => err.push(b));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) killTree(child.pid);
  }, timeoutS * 1000);
  const onAbort = (): void => {
    if (child.pid !== undefined) killTree(child.pid);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (c) => resolve(c ?? 1));
    }).catch((e: unknown) => {
      // Spawn failed after `which` found the file (not executable, bad interpreter, ...).
      return { failed: e instanceof Error ? e.message : String(e) };
    });
    signal?.throwIfAborted();
    if (typeof code !== 'number') return finished(name, command, 127, tail(code.failed));
    if (timedOut) return finished(name, command, 124, tail(out.text() + '\n[timed out]'));
    return finished(name, command, code, tail(out.text() + err.text()));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Run the named gates one after another (they may share caches or build output). */
export async function runGates(
  config: Config,
  cwd: string,
  names: readonly GateName[],
  signal?: AbortSignal,
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const name of names) {
    if (!GATE_NAMES.includes(name)) throw new Error(`unknown gate: ${name}`);
    results.push(
      await runGate(name, config.gates[name], cwd, config.limits.gate_timeout_s, signal),
    );
  }
  return results;
}

const blank = { file: null, line: null, evidence: '', suggested_check: '' } as const;

export function gateFinding(r: GateResult): Finding {
  return {
    ...blank,
    id: `G-${r.name}`,
    severity: 'blocking',
    category: 'correctness',
    criterion: `gate:${r.name}`,
    claim: `Gate '${r.name}' failed (exit ${r.returncode})`,
    evidence: r.output,
  };
}

/** Ground truth beats opinion: every failed gate is a blocking finding. */
export const gateFindings = (results: GateResult[]): Finding[] =>
  results.filter((r) => !gatePassed(r)).map(gateFinding);

/** Inverted TESTS gate: new tests must exist and must fail before implementation. */
export function redGateFindings(result: GateResult, newTestFiles: string[]): Finding[] {
  const coverage = (id: string, claim: string, evidence = ''): Finding[] => [
    {
      ...blank,
      id,
      severity: 'blocking',
      category: 'coverage',
      criterion: 'gate:test',
      claim,
      evidence,
    },
  ];
  if (newTestFiles.length === 0) {
    return coverage(
      'G-tests-missing',
      'No test files were added or changed',
      'git diff shows no changes under the configured test paths',
    );
  }
  if (result.skipped) {
    return coverage(
      'G-tests-skipped',
      "Test gate is not configured, so tests can't be shown to fail",
    );
  }
  if (result.returncode === 0) {
    return coverage(
      'G-tests-green',
      "Tests don't exercise the change: they pass before implementation",
      result.output,
    );
  }
  return [];
}

/** One-line summary for progress output, e.g. 'test FAIL, types pass, lint skipped'. */
export function gatesLine(results: GateResult[]): string {
  const parts = results.map(
    (r) => `${r.name} ${r.skipped ? 'skipped' : gatePassed(r) ? 'pass' : 'FAIL'}`,
  );
  return parts.join(', ') || 'none configured';
}

export const formatGates = (results: GateResult[]): string =>
  results.map(gateSummary).join('\n\n') || '(no gates run)';
