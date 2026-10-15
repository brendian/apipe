import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { Config } from '@advpipe/contracts';
import { newRunId, RunLog, startRun } from '@advpipe/engine';
import {
  happyJson,
  runRequest,
  scriptEnv,
  type JsonScript,
} from '../packages/engine/test/helpers/worker.js';
import { check } from './a11y.js';
import { launch, makeRepo, scratch, workerEntry } from './support.js';

// Scenarios 8-10 (docs/09 §9): closing the window mid-run, the CSP/console/network check across the
// pages, and a keyboard + accessibility pass over every page in both themes at two widths.

test.setTimeout(180_000);

const config = (): Config =>
  Config.parse({
    gates: { test: [process.execPath, '--test'], types: [], lint: [], security: [] },
  });

/** Starts a scripted run in a real detached worker. */
function begin(repo: string, userData: string, script: JsonScript): RunLog {
  const runId = newRunId();
  const request = {
    ...runRequest(repo, { work_item: '# Add clamp\nclamp(x, lo, hi)' }),
    run_id: runId,
  };
  startRun(repo, request, { workerEntry, config: config(), env: scriptEnv(userData, script) });
  return RunLog.forRun(repo, runId);
}

const resize = (app: ElectronApplication, width: number): Promise<void> =>
  app.evaluate(({ BrowserWindow }, w) => {
    BrowserWindow.getAllWindows()[0]?.setSize(w, 900);
  }, width);

test('every page is accessible in both themes at 1100 and 768 px, with a clean console and no network', async () => {
  const repo = makeRepo();
  const itemsDir = path.join(repo, 'work-items');
  mkdirSync(itemsDir);
  writeFileSync(
    path.join(itemsDir, 'add-clamp.md'),
    '---\nlevel: tests\n---\nAdd clamp\n\nclamp()\n',
  );
  const userData = scratch();
  begin(repo, userData, { scripts: happyJson() });
  const { app, page, problems } = await launch(repo, { ADVPIPE_USER_DATA: userData });
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  const failures: string[] = [];
  try {
    await expect(page.getByRole('link', { name: /Add clamp/ })).toContainText('complete', {
      timeout: 60_000,
    });
    for (const width of [1100, 768]) {
      await resize(app, width);
      const at = (name: string): string => `${name} @${width}`;
      const nav = (name: string) =>
        page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });

      await nav('Runs').click();
      await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
      await check(page, at('runs'), failures);

      await page.getByRole('link', { name: /Add clamp/ }).click();
      await expect(page.getByRole('heading', { name: 'Report' })).toBeVisible();
      await page.getByText('Round 1').first().click();
      await check(page, at('run'), failures);

      await page.getByRole('link', { name: /Spec & context/ }).click();
      await expect(page.getByRole('heading', { name: 'Work item' })).toBeVisible();
      await check(page, at('context'), failures);

      await nav('Work items').click();
      await expect(page.getByRole('link', { name: /^Run add-clamp/ })).toBeVisible();
      await check(page, at('items'), failures);

      await page.getByRole('link', { name: /^Edit add-clamp/ }).click();
      await expect(page.getByLabel('Work item (markdown)')).toBeVisible();
      await check(page, at('item editor'), failures);

      await nav('Runs').click();
      await page.getByRole('button', { name: 'New run' }).click();
      await expect(page.getByRole('heading', { name: 'New run' })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Start/ })).toBeVisible();
      await check(page, at('new run'), failures);

      await nav('Help').click();
      await expect(page.getByRole('heading', { name: 'How advpipe works' })).toBeVisible();
      await check(page, at('help'), failures);
    }
    expect(failures).toEqual([]);
    expect(problems).toEqual([]); // no CSP violation, no console error
    expect(requests.filter((u) => !u.startsWith('app://'))).toEqual([]); // nothing left the window
  } finally {
    await app.close();
  }
});

test('the welcome page is accessible in both themes', async () => {
  const { app, page, problems } = await launch();
  const failures: string[] = [];
  try {
    await expect(page.getByRole('heading', { name: 'advpipe' })).toBeVisible();
    await check(page, 'welcome', failures);
    expect(failures).toEqual([]);
    expect(problems).toEqual([]);
  } finally {
    await app.close();
  }
});

test('closing the app mid-run does not stop the run; reopening the repo shows it finish', async () => {
  const repo = makeRepo();
  const userData = scratch();
  const release = path.join(userData, 'release');
  const log = begin(repo, userData, {
    scripts: happyJson(),
    hold: { role: 'coder', until: release },
  });
  const first = await launch(repo);
  try {
    await expect(first.page.getByRole('link', { name: /Add clamp/ })).toContainText('running', {
      timeout: 30_000,
    });
  } finally {
    await first.app.close(); // the window goes, the worker is detached and carries on
  }
  const state = (): string => readFileSync(log.path('run.json'), 'utf-8');
  expect(JSON.parse(state()).status).toBe('running');

  const second = await launch(repo);
  try {
    const row = second.page.getByRole('link', { name: /Add clamp/ });
    await expect(row).toContainText('running', { timeout: 30_000 }); // still going, picked up live
    writeFileSync(release, '');
    await expect(row).toContainText('complete', { timeout: 60_000 });
    expect(second.problems).toEqual([]);
  } finally {
    await second.app.close();
  }
});

test('keyboard: skip link, shortcuts, focus follows the page, and the theme sticks', async () => {
  const repo = makeRepo();
  const userData = scratch();
  const first = await launch(repo, { ADVPIPE_USER_DATA: userData });
  try {
    const { page } = first;
    await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
    // The test build keeps its window hidden; give the page keyboard focus anyway.
    await first.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.focus();
    });

    // The skip link is the first Tab stop and moves focus into the page.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();

    // `g i` goes to the work items, and focus lands on that page's heading.
    await page.keyboard.press('g');
    await page.keyboard.press('i');
    await expect(page.getByRole('heading', { name: 'Work items' })).toBeFocused();
    await page.keyboard.press('n');
    await expect(page.getByRole('heading', { name: 'New run' })).toBeFocused();
    await page.keyboard.press('g');
    await page.keyboard.press('h');
    await expect(page.getByRole('heading', { name: 'How advpipe works' })).toBeFocused();
    await page.keyboard.press('g');
    await page.keyboard.press('r');
    await expect(page.getByRole('heading', { name: 'Runs' })).toBeFocused();

    // Theme: system → dark, and it survives a restart (applied before the page is drawn).
    await page.getByRole('button', { name: /^Theme: System/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  } finally {
    await first.app.close();
  }
  const second = await launch(repo, { ADVPIPE_USER_DATA: userData });
  try {
    await expect(second.page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(second.page.getByRole('button', { name: /^Theme: Dark/ })).toBeVisible();
    // Reduced motion is honoured: nothing is animated.
    await second.page.emulateMedia({ reducedMotion: 'reduce' });
    const animated = await second.page.evaluate(() => document.getAnimations().length);
    expect(animated).toBe(0);
  } finally {
    await second.app.close();
  }
});
