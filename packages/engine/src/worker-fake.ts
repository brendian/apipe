import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Role } from '@advpipe/contracts';
import { Cancelled } from './core/cancel.js';
import { FakeAgentRunner, limitHit, writes, type Scripts, type Step } from './runner/fake.js';
import type { AgentRequest, AgentResult } from './runner/types.js';
import { runWorker } from './worker-core.js';

// The test worker (docs/04 §3.1; the Python `advpipe_fake_child.py`): the real worker with a
// `FakeAgentRunner` scripted from the JSON file named by ADVPIPE_FAKE_SCRIPT. It is a separate
// entry, so no release build contains it. A script step is a literal reply, `{writes, reply}`, or
// `{limit: {billing?, files?}}` (a usage limit).

const ScriptStep = z.union([
  z.string(),
  z.strictObject({ writes: z.record(z.string(), z.string()), reply: z.string().default('done') }),
  // A usage limit hit by this call: `files` are partial work it wrote first.
  z.strictObject({
    limit: z.strictObject({
      billing: z.boolean().default(false),
      files: z.record(z.string(), z.string()).default({}),
    }),
  }),
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
  // The script comes from the environment, or else from `fake-script.json` beside start.json, so a
  // resume the app starts (which has no script in its environment) still gets its run's script.
  const startAt = process.argv.indexOf('--start');
  const beside =
    startAt >= 0 && process.argv[startAt + 1] !== undefined
      ? path.join(path.dirname(process.argv[startAt + 1] as string), 'fake-script.json')
      : undefined;
  const file = process.env['ADVPIPE_FAKE_SCRIPT'] ?? beside;
  if (file === undefined || !existsSync(file)) {
    throw new Error(
      'no fake script: set ADVPIPE_FAKE_SCRIPT or put fake-script.json beside start.json',
    );
  }
  const script = FakeScript.parse(JSON.parse(readFileSync(file, 'utf-8')));
  const scripts: Scripts = {};
  for (const [role, steps] of Object.entries(script.scripts)) {
    scripts[role as Role] = steps.map((s): Step => {
      if (typeof s === 'string') return s;
      if ('limit' in s) return limitHit({ billing: s.limit.billing, files: s.limit.files });
      return writes(s.writes, s.reply);
    });
  }
  return new HoldingRunner(scripts, script.cost_per_call, script.hold);
}

process.exitCode = await runWorker(process.argv.slice(2), makeRunner);
