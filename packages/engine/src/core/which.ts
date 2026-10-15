import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform === 'win32') return true;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve `command` the way a shell would (PATH, and PATHEXT on Windows), without using a shell. */
export function which(command: string, cwd: string = process.cwd()): string | null {
  if (!command) return null;
  const exts =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
      : [''];
  const dirs = /[\\/]/.test(command)
    ? [path.resolve(cwd, path.dirname(command))] // has a directory part: don't search PATH
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const name = /[\\/]/.test(command) ? path.basename(command) : command;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}
