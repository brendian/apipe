import { spawnSync } from 'node:child_process';
import path from 'node:path';

// The process tests run the built worker (`dist/src/worker-fake.js`) in real child processes, so make
// sure `dist` is current. `tsc -b` is incremental: a no-op when nothing changed.
export default function setup(): void {
  const root = path.resolve(import.meta.dirname, '../../..');
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const r = spawnSync(process.execPath, [tsc, '-b', 'packages/contracts', 'packages/engine'], {
    cwd: root,
    encoding: 'utf-8',
  });
  if (r.status !== 0)
    throw new Error(`building the engine for the process tests failed:\n${r.stdout}${r.stderr}`);
}
