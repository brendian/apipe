// `npm run check:prompts`: assets/prompts/<role>.md must equal the body of .claude/agents/<role>.md
// (everything after the second `---\n` line), and the frontmatter must say `name: <role>`.
// Port of the original's test_subagents_in_sync_with_prompts.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const promptsDir = join(root, 'assets', 'prompts');
const agentsDir = join(root, '.claude', 'agents');

const roles = readdirSync(promptsDir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3))
  .sort();

const problems = [];
for (const role of roles) {
  const prompt = readFileSync(join(promptsDir, `${role}.md`), 'utf8');
  let agent;
  try {
    agent = readFileSync(join(agentsDir, `${role}.md`), 'utf8');
  } catch {
    problems.push(`${role}: .claude/agents/${role}.md is missing`);
    continue;
  }
  const first = agent.indexOf('---\n');
  const second = first === 0 ? agent.indexOf('---\n', 4) : -1;
  if (second === -1) {
    problems.push(`${role}: .claude/agents/${role}.md has no frontmatter block`);
    continue;
  }
  const frontmatter = agent.slice(4, second);
  const body = agent.slice(second + 4).replace(/^\n/, '');
  if (!new RegExp(`^name: ${role}$`, 'm').test(frontmatter)) {
    problems.push(`${role}: frontmatter does not say "name: ${role}"`);
  }
  if (body !== prompt) {
    problems.push(`${role}: .claude/agents body differs from assets/prompts/${role}.md`);
  }
}
if (roles.length !== 9) problems.push(`expected 9 role prompts, found ${roles.length}`);

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`prompts in sync (${roles.length} roles)`);
