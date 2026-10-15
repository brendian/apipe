import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { Role } from '@advpipe/contracts';
import { Cancelled } from './core/cancel.js';
import { FakeAgentRunner, writes, type Scripts, type Step } from './runner/fake.js';
import type { AgentRequest, AgentResult } from './runner/types.js';
import { runWorker } from './worker-core.js';

// The test worker (docs/04 §3.1; the Python `advpipe_fake_child.py`): the real worker with a
// `FakeAgentRunner` scripted from the JSON file named by ADVPIPE_FAKE_SCRIPT. It is a separate
// entry, so no release build contains it. A script step is a literal reply, or `{writes, reply}`.

const ScriptStep = z.union([
  z.string(),
  z.strictObject({ writes: z.record(z.string(), z.string()), reply: z.string().default('done') }),
]);

export const FakeScript = z.strictObject({
  scripts: z.partialRecord(Role, z.array(ScriptStep)),
  cost_per_call: z.number().default(0.01),
  /** Hold every call to `role` until the file `until` exists (so a test can catch the run mid-way). */
  hold: z
    .strictObject({
      role: Role,
      until: z.string(),
      /** Keep waiting through a cancel, like a worker stuck in a section that can't be interrupted. */
      ignore_cancel: z.boolean().default(false),
    })
    .optional(),
});
export type FakeScript = z.infer<typeof FakeScript>;

class HoldingRunner extends FakeAgentRunner {
  constructor(
    scripts: Scripts,
    costPerCall: number,
    private readonly hold: FakeScript['hold'],
  ) {
    super(scripts, { costPerCall });
  }

  override async run(request: AgentRequest): Promise<AgentResult> {
    const hold = this.hold;
    if (hold !== undefined && hold.role === request.role) {
      while (!existsSync(hold.until)) {
        if (!hold.ignore_cancel && request.signal?.aborted) throw new Cancelled();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    return super.run(request);
  }
}

function makeRunner(): FakeAgentRunner {
  const file = process.env['ADVPIPE_FAKE_SCRIPT'];
  if (file === undefined) throw new Error('ADVPIPE_FAKE_SCRIPT is not set');
  const script = FakeScript.parse(JSON.parse(readFileSync(file, 'utf-8')));
  const scripts: Scripts = {};
  for (const [role, steps] of Object.entries(script.scripts)) {
    scripts[role as Role] = steps.map((s): Step =>
      typeof s === 'string' ? s : writes(s.writes, s.reply),
    );
  }
  return new HoldingRunner(scripts, script.cost_per_call, script.hold);
}

process.exitCode = await runWorker(process.argv.slice(2), makeRunner);
