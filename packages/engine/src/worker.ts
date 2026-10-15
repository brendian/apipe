import { runWorker } from './worker-core.js';
import { SdkAgentRunner } from './runner/sdk.js';

// The hidden worker entry: `<node> worker.js --start <start.json>` (docs/04 §3.1). The only
// command line besides `advpipe [repo]`, started by the app itself and never typed.
process.exitCode = await runWorker(process.argv.slice(2), () => new SdkAgentRunner());
