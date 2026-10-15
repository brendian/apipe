import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Config, Role } from '@advpipe/contracts';
import type { AgentRequest } from './types.js';

// Which tools and which model each role gets (docs/06 §2), and the role system prompts.

export const READ_ONLY: readonly string[] = ['Read', 'Glob', 'Grep'];
export const WRITER: readonly string[] = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];

export type ModelTier = 'author' | 'critic' | 'arbiter';

export const ROLE_TOOLS: Readonly<Record<Role, readonly string[]>> = {
  'spec-writer': ['Read', 'Glob', 'Grep', 'Write'],
  'test-author': WRITER,
  'test-critic': READ_ONLY,
  coder: WRITER,
  'code-critic': READ_ONLY,
  'standards-reviewer': READ_ONLY,
  'security-reviewer': READ_ONLY,
  arbiter: READ_ONLY,
  solo: WRITER,
};

export const ROLE_MODEL: Readonly<Record<Role, ModelTier>> = {
  'spec-writer': 'author',
  'test-author': 'author',
  coder: 'author',
  solo: 'author',
  'test-critic': 'critic',
  'code-critic': 'critic',
  'standards-reviewer': 'critic',
  'security-reviewer': 'critic',
  arbiter: 'arbiter',
};

// `packages/engine/prompts/` is a build-time copy of `assets/prompts/` (scripts/copy-prompts.mjs).
// This file is `src/runner/` or `dist/runner/`: two levels below the package root either way.
const PROMPTS_DIR = new URL('../../prompts/', import.meta.url);
const cache = new Map<Role, string>();

/** The role's system prompt, read once. */
export function loadPrompt(role: Role): string {
  let text = cache.get(role);
  if (text === undefined) {
    text = readFileSync(fileURLToPath(new URL(`${role}.md`, PROMPTS_DIR)), 'utf-8');
    cache.set(role, text);
  }
  return text;
}

export function buildRequest(
  role: Role,
  prompt: string,
  config: Config,
  cwd: string,
  remainingBudget: number | null,
  signal?: AbortSignal,
): AgentRequest {
  return {
    role,
    prompt,
    system_prompt: loadPrompt(role),
    model: config.models[ROLE_MODEL[role]],
    tools: [...ROLE_TOOLS[role]],
    cwd,
    max_turns: config.limits.max_turns_per_agent,
    max_budget_usd: remainingBudget,
    signal,
  };
}
