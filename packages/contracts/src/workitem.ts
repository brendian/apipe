import { parseLevel } from './levels.js';
import { pyRepr, splitLines } from './text.js';

// Work-item files: a markdown body with an optional front-matter block of defaults (docs/02 §16).
// Only simple `key: value` lines are parsed (no YAML). Unknown or repeated keys are an error, and
// every error names `file:line`. `formatWorkItem` writes the same layout back; the editor uses it.

export const FENCE = '---';

/** Front-matter keys, in the order they are written, and what they set. */
export const KEYS = {
  name: 'branch name: advpipe/<name>',
  config: 'pipeline config file, relative to the repo root',
  level: 'how much checking: basic, reviewer, tests, adversarial, full (or 1-5)',
  security_scan: 'run the security scan: yes or no (default: on at level full only)',
  scan_failures: 'below level full, what a failing security scan means: ask, ignore, block',
  bypass_questions: 'yes: the agent answers blocking questions itself, without asking you',
} as const;
export type WorkItemKey = keyof typeof KEYS;
export const KEY_NAMES = Object.keys(KEYS) as WorkItemKey[];

/** The keys that set how the run goes (the rest say where it starts from). */
export const RUN_KEYS = ['level', 'security_scan', 'scan_failures', 'bypass_questions'] as const;

export const SCAN_FAILURES = ['ask', 'ignore', 'block'] as const;
const SWITCH: Record<string, boolean> = { yes: true, true: true, no: false, false: false };
const LINE_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/;

export class WorkItemError extends Error {
  override name = 'WorkItemError';
}

/** Values are kept AS WRITTEN (validated on parse); callers use `parseLevel`/`switchValue`. */
export type WorkItem = {
  body: string;
  name?: string;
  config?: string;
  level?: string;
  security_scan?: string;
  scan_failures?: string;
  bypass_questions?: string;
};

/** A front-matter yes/no value. Throws an Error otherwise. */
export function switchValue(value: string): boolean {
  const found = SWITCH[value.trim().toLowerCase()];
  if (found === undefined) throw new Error(`expected yes or no, got ${pyRepr(value)}`);
  return found;
}

function checkScanFailures(value: string): string {
  if (!(SCAN_FAILURES as readonly string[]).includes(value)) {
    throw new Error(`expected one of ${SCAN_FAILURES.join(', ')}, got ${pyRepr(value)}`);
  }
  return value;
}

// Checks for the keys whose values are more than text. Each throws an Error.
const CHECKS: Partial<Record<WorkItemKey, (value: string) => unknown>> = {
  level: parseLevel,
  security_scan: switchValue,
  scan_failures: checkScanFailures,
  bypass_questions: switchValue,
};

/** Split optional front matter from the body. Throws WorkItemError on any problem. */
export function parseWorkItem(text: string, source = 'work item'): WorkItem {
  const lines = splitLines(text);
  const fields: Partial<Record<WorkItemKey, string>> = {};
  let bodyLines = lines;
  if (lines.length > 0 && lines[0]?.trim() === FENCE) {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === FENCE);
    if (end === -1) {
      throw new WorkItemError(`${source}: front matter starts with '---' but never ends`);
    }
    for (let i = 1; i < end; i++) {
      const raw = (lines[i] ?? '').trim();
      if (!raw) continue;
      const n = i + 1;
      const match = LINE_RE.exec(raw);
      if (!match) {
        throw new WorkItemError(`${source}:${n}: expected 'key: value', got ${pyRepr(raw)}`);
      }
      const key = match[1] as string;
      const value = (match[2] ?? '').trim();
      if (!Object.hasOwn(KEYS, key)) {
        const known = KEY_NAMES.join(', ');
        throw new WorkItemError(
          `${source}:${n}: unknown key ${pyRepr(key)} (known keys: ${known})`,
        );
      }
      const k = key as WorkItemKey;
      if (Object.hasOwn(fields, k))
        throw new WorkItemError(`${source}:${n}: ${pyRepr(k)} is given twice`);
      if (!value) throw new WorkItemError(`${source}:${n}: ${pyRepr(k)} has no value`);
      const check = CHECKS[k];
      if (check) {
        try {
          check(value);
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          throw new WorkItemError(`${source}:${n}: ${pyRepr(k)}: ${why}`);
        }
      }
      fields[k] = value;
    }
    bodyLines = lines.slice(end + 1);
  }
  const body = bodyLines.join('\n').trim();
  if (!body) throw new WorkItemError(`${source}: the work item is empty`);
  return { body, ...fields };
}

/**
 * The file text for `item`: front matter for the fields that are set, then the body, with exactly
 * one trailing newline. `parseWorkItem` reads it back as an equal item (body trimmed). Throws
 * WorkItemError if it couldn't: an empty body, or a value that's blank or not one line.
 */
export function formatWorkItem(item: WorkItem): string {
  const body = item.body.trim();
  if (!body) throw new WorkItemError('the work item is empty');
  const fields: string[] = [];
  for (const key of KEY_NAMES) {
    const value = item[key];
    if (value === undefined) continue;
    if (!value.trim() || value !== value.trim() || value.includes('\n') || value.includes('\r')) {
      throw new WorkItemError(`${pyRepr(key)} must be one line of text with no spaces around it`);
    }
    fields.push(`${key}: ${value}`);
  }
  // A body whose first line is '---' would read as front matter: give it an empty block.
  if (fields.length > 0 || splitLines(body)[0]?.trim() === FENCE) {
    return [FENCE, ...fields, FENCE, body].join('\n') + '\n';
  }
  return body + '\n';
}

/**
 * Best-effort split of a file `parseWorkItem` rejects, so an editor can open it to fix it: the
 * known front-matter keys it can read (first value wins), and the body. Front matter that never
 * closes is left in the body.
 */
export function salvageWorkItem(text: string): {
  fields: Partial<Record<WorkItemKey, string>>;
  body: string;
} {
  const lines = splitLines(text);
  if (lines.length === 0 || lines[0]?.trim() !== FENCE) return { fields: {}, body: text.trim() };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === FENCE);
  if (end === -1) return { fields: {}, body: text.trim() };
  const fields: Partial<Record<WorkItemKey, string>> = {};
  for (const raw of lines.slice(1, end)) {
    const match = LINE_RE.exec(raw.trim());
    const key = match?.[1];
    const value = (match?.[2] ?? '').trim();
    if (key !== undefined && Object.hasOwn(KEYS, key) && value && !Object.hasOwn(fields, key)) {
      fields[key as WorkItemKey] = value;
    }
  }
  return {
    fields,
    body: lines
      .slice(end + 1)
      .join('\n')
      .trim(),
  };
}
