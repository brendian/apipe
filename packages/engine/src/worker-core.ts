import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '@advpipe/contracts';
import { StartRequest } from '@advpipe/contracts';
import { Cancelled } from './core/cancel.js';
import { CANCEL_FILE, effectiveConfig, START_FILE, summaryLines } from './core/control.js';
import { loadConfig } from './core/config.js';
import { RunLog } from './core/runlog.js';
import { Orchestrator } from './orchestrator/index.js';
import type { AgentRunner } from './runner/types.js';

// The body of the hidden worker (docs/04 §3.1): read start.json, drive one run, exit. Kept apart
// from the entry files so the release worker (`worker.ts`, the SDK) and the test worker
// (`worker-fake.ts`, scripted agents) share every line but the runner.

export const EXIT_OK = 0;
export const EXIT_NOT_COMPLETE = 1;
export const EXIT_BAD_START = 2;
export const EXIT_INTERRUPTED = 130;
/** How often the worker looks for the `cancel` file. */
export const CANCEL_POLL_MS = 500;

const say = (line: string): void => void process.stdout.write(line + '\n');

/** The effective config of a new run: what the host wrote to config.json, with the request on top. */
function configFor(
  runlog: RunLog,
  repo: string,
  request: StartRequest & { command: 'run' },
): Config {
  const base =
    runlog.readConfig() ??
    loadConfig({
      repo,
      ...(request.config_path !== null ? { file: request.config_path } : {}),
    }).config;
  return effectiveConfig(base, request);
}

/**
 * Run the worker for `argv` (`['--start', '<abs path to start.json>']` and nothing else). Returns
 * the process exit code: 0 complete, 1 any other final status, 2 bad start.json, 130 interrupted.
 */
export async function runWorker(argv: string[], makeRunner: () => AgentRunner): Promise<number> {
  // Electron's binary runs as plain Node only because of this variable; nothing we start may see it.
  delete process.env['ELECTRON_RUN_AS_NODE'];

  const startPath = argv.length === 2 && argv[0] === '--start' ? argv[1] : undefined;
  if (startPath === undefined) {
    process.stderr.write('usage: worker --start <path to start.json>\n');
    return EXIT_BAD_START;
  }
  let request: StartRequest;
  let runlog: RunLog;
  try {
    request = StartRequest.parse(JSON.parse(readFileSync(startPath, 'utf-8')));
    runlog = RunLog.forRun(request.repo, request.run_id);
    // The one input is the run's own start.json, so a request can't name some other file.
    if (path.resolve(startPath) !== path.resolve(runlog.path(START_FILE))) {
      throw new Error(`${startPath} isn't the start.json of run ${request.run_id}`);
    }
  } catch (e) {
    process.stderr.write(`worker: can't use ${startPath}: ${e instanceof Error ? e.message : e}\n`);
    return EXIT_BAD_START;
  }

  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const poll = setInterval(() => {
    if (existsSync(runlog.path(CANCEL_FILE))) stop();
  }, CANCEL_POLL_MS);

  try {
    const orchestrator =
      request.command === 'run'
        ? new Orchestrator(
            configFor(runlog, request.repo, request),
            makeRunner(),
            request.repo,
            request.work_item,
            {
              runId: request.run_id,
              keepWorktree: request.keep_worktree,
              workItemFile: request.work_item_file,
              signal: abort.signal,
              ...(request.name !== null ? { name: request.name } : {}),
            },
          )
        : await Orchestrator.resume(makeRunner(), request.repo, request.run_id, {
            budgetUsd: request.budget_usd,
            lockedForMe: request.locked_for_me,
            signal: abort.signal,
          });
    const state = await orchestrator.run();
    for (const line of summaryLines(state, runlog)) say(line);
    return state.status === 'complete' ? EXIT_OK : EXIT_NOT_COMPLETE;
  } catch (e) {
    if (e instanceof Cancelled) {
      say(`${request.run_id}  interrupted; press Resume to continue`);
      return EXIT_INTERRUPTED;
    }
    // The run never got going (e.g. it can't be resumed): say why, and don't leave our pid locked.
    process.stderr.write(`worker: ${e instanceof Error ? e.message : String(e)}\n`);
    runlog.releaseLock();
    return EXIT_NOT_COMPLETE;
  } finally {
    clearInterval(poll);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    rmSync(runlog.path(CANCEL_FILE), { force: true });
  }
}
