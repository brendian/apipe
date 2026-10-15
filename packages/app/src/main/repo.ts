import { statSync } from 'node:fs';
import path from 'node:path';

/**
 * The repo named on the command line (`advpipe [repo-path]`), resolved against `cwd`. Flags (the
 * ones Electron and Playwright add) are skipped; when run as `electron <app> [repo]` the app path
 * comes first and isn't the repo.
 */
export function repoArg(argv: readonly string[], cwd: string, defaultApp: boolean): string | null {
  const plain = argv.slice(1).filter((a) => a !== '' && !a.startsWith('-'));
  const arg = (defaultApp ? plain.slice(1) : plain)[0];
  return arg === undefined ? null : path.resolve(cwd, arg);
}

export const isDirectory = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};
