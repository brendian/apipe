// Build-time copy: assets/prompts/*.md -> packages/engine/prompts/ (byte-identical).
// Fails the build if any copied file differs from its source (docs/10 §4).
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'assets', 'prompts');
const to = join(root, 'packages', 'engine', 'prompts');

mkdirSync(to, { recursive: true });
const files = readdirSync(from).filter((f) => f.endsWith('.md'));
for (const f of files) copyFileSync(join(from, f), join(to, f));

const bad = files.filter((f) => !readFileSync(join(from, f)).equals(readFileSync(join(to, f))));
if (bad.length > 0) {
  console.error(`prompt copy mismatch: ${bad.join(', ')}`);
  process.exit(1);
}
console.log(`copied ${files.length} prompts to packages/engine/prompts`);
