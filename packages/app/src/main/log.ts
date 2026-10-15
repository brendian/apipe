import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

// `<userData>/logs/main.log`, rotated at 5 MB × 3 (docs/04 §8). Never agent output, never file
// contents, never environment variables: only what went wrong in the host.

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

export function createLogger(dir: string): (message: string, err?: unknown) => void {
  const file = path.join(dir, 'main.log');
  return (message, err) => {
    try {
      mkdirSync(dir, { recursive: true });
      try {
        if (statSync(file).size > MAX_BYTES) {
          rmSync(`${file}.${KEEP - 1}`, { force: true });
          for (let i = KEEP - 2; i >= 1; i--) {
            try {
              renameSync(`${file}.${i}`, `${file}.${i + 1}`);
            } catch {
              // that generation doesn't exist yet
            }
          }
          renameSync(file, `${file}.1`);
        }
      } catch {
        // no log yet
      }
      const detail =
        err instanceof Error ? (err.stack ?? err.message) : err === undefined ? '' : String(err);
      appendFileSync(
        file,
        `${new Date().toISOString()} ${message}${detail ? `\n${detail}` : ''}\n`,
      );
    } catch {
      // a log that can't be written must never break the app
    }
  };
}
