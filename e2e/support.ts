import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const appDir = path.join(root, 'packages', 'app');
export const workerEntry = path.join(root, 'packages', 'engine', 'dist', 'src', 'worker-fake.js');

export const scratch = (): string => mkdtempSync(path.join(tmpdir(), 'advpipe-e2e-'));

/** A copy of the sample project as a git repo with one commit. The fixture itself is never touched. */
export function makeRepo(): string {
  const dir = scratch();
  cpSync(path.join(root, 'fixtures', 'sample_repo'), dir, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  return dir;
}

/** The app, on `repo` (or with no repo), with its own preferences folder and a hidden window. */
export async function launch(
  repo?: string,
  env: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page; problems: string[]; userData: string }> {
  const userData = scratch();
  const app = await electron.launch({
    args: [appDir, ...(repo ? [repo] : [])],
    env: { ...process.env, ADVPIPE_E2E: '1', ADVPIPE_USER_DATA: userData, ...env },
  });
  const page = await app.firstWindow();
  const problems: string[] = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));
  return { app, page, problems, userData };
}
