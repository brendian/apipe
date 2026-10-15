// Helpers for the process tests: scripts for the fake-agent worker, polling, a run request.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Level, StartRun } from '@advpipe/contracts';
import type { RunLog } from '../../src/index.js';
import { newRunId, pidAlive } from '../../src/index.js';
import { IMPL_OK, TASK_MD, TEST_CLAMP } from './samples.js';

/** The built test worker; `test/global-setup.ts` builds it before the tests run. */
export const WORKER = path.resolve(import.meta.dirname, '../../dist/src/worker-fake.js');

export const scratch = (): string => mkdtempSync(path.join(tmpdir(), 'advpipe-proc-'));

export type JsonStep =
  | string
  | { writes: Record<string, string>; reply?: string }
  | { limit: { billing?: boolean; files?: Record<string, string> } };
export type JsonScript = {
  scripts: Partial<Record<string, JsonStep[]>>;
  hold?: { role: string; until: string; ignore_cancel?: boolean };
};

const pass = JSON.stringify({ verdict: 'PASS', findings: [] });
export const w = (files: Record<string, string>, reply = 'done'): JsonStep => ({
  writes: files,
  reply,
});

/** From the coder onward: what a resumed Full run still needs after tests are committed. */
export const codeOnward = (): JsonScript['scripts'] => ({
  coder: [w(IMPL_OK)],
  'code-critic': [pass],
  'standards-reviewer': [pass],
  'security-reviewer': [pass],
});

/** Every Full-level stage passes on the first round. */
export const happyJson = (): JsonScript['scripts'] => ({
  'spec-writer': [w({ 'task.md': TASK_MD })],
  'test-author': [w({ 'tests/clamp.test.js': TEST_CLAMP })],
  'test-critic': [pass],
  ...codeOnward(),
});

/** Write `script` and return the env that points a worker at it. */
export function scriptEnv(
  dir: string,
  script: JsonScript,
  name = 'script.json',
): Record<string, string> {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(script));
  return { ADVPIPE_FAKE_SCRIPT: file };
}

export function runRequest(repo: string, over: Partial<StartRun> = {}): StartRun {
  return {
    command: 'run',
    run_id: newRunId(),
    repo,
    work_item: 'add clamp',
    work_item_file: '',
    name: null,
    config_path: null,
    keep_worktree: false,
    level: 'full' satisfies Level,
    security_scan: null,
    scan_failures: 'ask',
    bypass_questions: false,
    budget_usd: null,
    ...over,
  };
}

export async function waitFor(cond: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const eventsText = (log: RunLog): string =>
  existsSync(log.path('events.jsonl')) ? readFileSync(log.path('events.jsonl'), 'utf-8') : '';

/** The run's agent has started `role` (the worker is then held there, if the script says so). */
export const agentStarted = (log: RunLog, role: string): boolean =>
  eventsText(log).includes(`"kind":"agent_start"`) && eventsText(log).includes(`"role":"${role}"`);

/** The worker has stopped driving the run: no live process holds the lock. */
export const stopped = (log: RunLog): boolean => log.lockHolder() === null;

/** The run's recorded status, or '' before the worker has written run.json. */
export const statusOf = (log: RunLog): string =>
  existsSync(log.path('run.json')) ? log.readState().status : '';

/** The worker has stopped, and left the run somewhere other than `running` (final or waiting). */
export const settled = (log: RunLog): boolean =>
  stopped(log) && !['', 'running'].includes(statusOf(log));

export { pidAlive };
