import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { ZodError } from 'zod';
import { Config } from '@advpipe/contracts';

// Load and validate pipeline.toml (docs/02 §17).

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** The tables whose explicitly-set keys are tracked (the original used `model_fields_set`). */
export type Explicit = Readonly<Record<string, ReadonlySet<string>>>;

export type LoadedConfig = {
  config: Config;
  /** Which keys the file set explicitly, per table: `explicit.pipeline.has('level')`. */
  explicit: Explicit;
};

function explicitKeys(raw: unknown): Explicit {
  const out: Record<string, Set<string>> = {};
  if (raw !== null && typeof raw === 'object') {
    for (const [table, value] of Object.entries(raw)) {
      out[table] = new Set(
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? Object.keys(value)
          : [],
      );
    }
  }
  return out;
}

function describeIssues(error: ZodError): string {
  return error.issues
    .map((i) => {
      const where = i.path.map(String).join('.');
      return where ? `${where}: ${i.message}` : i.message;
    })
    .join('; ');
}

/** Validate a parsed config object. `source` names it in the error. */
export function parseConfig(raw: unknown, source = 'config'): LoadedConfig {
  const parsed = Config.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`${source}: ${describeIssues(parsed.error)}`);
  return { config: parsed.data, explicit: explicitKeys(raw) };
}

/** Load config from `file`, else `<repo>/pipeline.toml`, else defaults. */
export function loadConfig(opts: { file?: string; repo?: string } = {}): LoadedConfig {
  let file = opts.file;
  if (file === undefined && opts.repo !== undefined) {
    const candidate = path.join(opts.repo, 'pipeline.toml');
    if (existsSync(candidate)) file = candidate;
  }
  if (file === undefined) return parseConfig({}, 'defaults');
  let raw: unknown;
  try {
    raw = parseToml(readFileSync(file, 'utf-8'));
  } catch (e) {
    throw new ConfigError(`can't read config ${file}: ${e instanceof Error ? e.message : e}`);
  }
  return parseConfig(raw, file);
}
