import { runWorker } from './worker-core.js';
import { SdkAgentRunner } from './runner/sdk.js';
import { findClaudeBinary } from './readmodel/preflight.js';

// The hidden worker entry: `<node> worker.js --start <start.json>` (docs/04 §3.1). The only
// command line besides `advpipe [repo]`, started by the app itself and never typed.
// The Claude Code binary is named outright: in a packaged app it lives outside the asar (docs/06 §8).
process.exitCode = await runWorker(process.argv.slice(2), () => {
  const claude = findClaudeBinary();
  return new SdkAgentRunner(claude ? { pathToClaudeCodeExecutable: claude.path } : {});
});
