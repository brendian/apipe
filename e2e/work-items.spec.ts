import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { happyJson, scriptEnv, type JsonScript } from '../packages/engine/test/helpers/worker.js';
import { launch, makeRepo, workerEntry } from './support.js';

// Scenario 7 (docs/09 §9): work items, byte-exact round trips, the stale-file guard, and starting
// a run from an item with what was shown.

test.setTimeout(60_000);

test('work items: create, edit without touching, rename, delete; stale save refused', async () => {
  const repo = makeRepo();
  const { app, page, problems } = await launch(repo);
  const items = path.join(repo, 'work-items');
  try {
    await page.getByRole('link', { name: 'Work items', exact: true }).click();
    await expect(page.getByText(/no work-items\/ folder/)).toBeVisible();

    // Create, with a run setting from the select.
    await page.getByRole('button', { name: 'New work item' }).click();
    await page.getByLabel('File name').fill('server/s05-refund');
    await page.getByLabel('Branch name').fill('s05-refund');
    await page.getByLabel('Level', { exact: true }).selectOption('tests');
    await page.getByLabel(/^Work item/).fill('Refund window\n\nAllow refunds for 30 days.');
    await expect(page.getByText(/a run would make/)).toBeVisible();
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText('Created.', { exact: true })).toBeVisible();
    const file = path.join(items, 'server', 's05-refund.md');
    expect(readFileSync(file, 'utf-8')).toBe(
      '---\nname: s05-refund\nlevel: tests\n---\nRefund window\n\nAllow refunds for 30 days.\n',
    );

    // A hand-formatted file is left byte for byte when nothing changed.
    const odd =
      '---\nname:   s05-refund\n\nlevel : tests\n---\n\nRefund window\n\nAllow refunds.\n\n';
    writeFileSync(file, odd);
    await page.getByRole('link', { name: 'Work items', exact: true }).click();
    await page.getByRole('link', { name: 'Refund window' }).first().click();
    await expect(page.getByLabel(/^Work item/)).toHaveValue('Refund window\n\nAllow refunds.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('No changes to save.')).toBeVisible();
    expect(readFileSync(file, 'utf-8')).toBe(odd);

    // Someone else changes the file: the save is refused and what was typed stays.
    await page.getByLabel(/^Work item/).fill('my edit');
    writeFileSync(file, 'changed elsewhere\n');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('changed on disk');
    await expect(page.getByLabel(/^Work item/)).toHaveValue('my edit');
    expect(readFileSync(file, 'utf-8')).toBe('changed elsewhere\n');

    // Rename, then delete behind its confirmation page.
    await page.getByRole('link', { name: 'Rename' }).click();
    await page.getByLabel('New name').fill('server/renamed');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(page.getByText('Renamed.', { exact: true })).toBeVisible();
    expect(existsSync(path.join(items, 'server', 'renamed.md'))).toBe(true);
    expect(existsSync(file)).toBe(false);

    await page.getByRole('link', { name: 'Delete' }).click();
    await expect(page.getByRole('button', { name: 'Keep it' })).toBeFocused();
    await expect(page.getByText("It isn't in git, so this can't be undone.")).toBeVisible();
    await page.getByRole('button', { name: 'Delete it' }).click();
    await expect(page.getByText('Work item deleted.')).toBeVisible();
    expect(existsSync(path.join(items, 'server', 'renamed.md'))).toBe(false);
    expect(problems).toEqual([]);
  } finally {
    await app.close();
  }
});

test('new run from a work item: shows the budget, starts what was shown, and the run goes live', async () => {
  const repo = makeRepo();
  writeFileSync(
    path.join(repo, 'pipeline.toml'),
    `[limits]\nbudget_usd_per_task = 6\n[gates]\ntest = [${JSON.stringify(process.execPath)}, "--test"]\ntypes = []\nlint = []\nsecurity = []\n`,
  );
  const itemsDir = path.join(repo, 'work-items');
  mkdirSync(itemsDir);
  writeFileSync(
    path.join(itemsDir, 'add-clamp.md'),
    '---\nlevel: tests\n---\nAdd clamp\n\nclamp(x, lo, hi)\n',
  );

  const dir = path.join(repo, '..', `e2e-${path.basename(repo)}`);
  mkdirSync(dir, { recursive: true });
  const release = path.join(dir, 'release');
  const all = happyJson();
  const script: JsonScript = {
    scripts: {
      'spec-writer': all['spec-writer'],
      'test-author': all['test-author'],
      coder: all['coder'],
      'code-critic': all['code-critic'],
    },
    hold: { role: 'coder', until: release },
  };
  const { app, page, problems } = await launch(repo, {
    ADVPIPE_WORKER_ENTRY: workerEntry,
    ...scriptEnv(dir, script),
  });
  try {
    await page.getByRole('link', { name: 'Work items', exact: true }).click();
    await page.getByRole('link', { name: /^Run add-clamp/ }).click();
    await expect(page.getByRole('heading', { name: 'New run' })).toBeVisible();
    await expect(page.getByLabel('Work item', { exact: true })).toHaveValue('add-clamp.md');

    // The summary: the budget from pipeline.toml, the level from the item, nothing started yet.
    await expect(page.getByText('This can spend up to')).toContainText('$6.00');
    await expect(page.getByRole('heading', { name: /Tests/ })).toBeVisible();
    await expect(page.getByRole('slider')).toHaveAttribute('aria-valuetext', 'Tests');
    await expect(page.getByText(/from the work item's front matter/).first()).toBeVisible();
    expect(existsSync(path.join(repo, '.advpipe', 'runs'))).toBe(false);

    const start = page.getByRole('button', { name: 'Start (up to $6.00)' });
    await expect(start).toBeEnabled();
    await start.click();

    // The run page, live: held at the coder, then complete.
    await expect(page.getByRole('heading', { name: 'Add clamp' })).toBeVisible({ timeout: 20_000 });
    const strip = page.locator('.timeline-strip');
    await expect(strip.locator('li', { hasText: 'CODE' })).toContainText('in progress', {
      timeout: 30_000,
    });
    const runs = path.join(repo, '.advpipe', 'runs');
    const [runId] = readdirSync(runs);
    const request = JSON.parse(readFileSync(path.join(runs, runId ?? '', 'start.json'), 'utf-8'));
    expect(request).toMatchObject({
      command: 'run',
      level: 'tests',
      security_scan: null,
      scan_failures: 'ask',
      bypass_questions: false,
      budget_usd: 6,
      work_item: 'Add clamp\n\nclamp(x, lo, hi)',
      work_item_file: expect.stringMatching(/work-items[/\\]add-clamp\.md$/),
    });
    writeFileSync(release, '');
    await expect(
      page.getByRole('status').filter({ hasText: 'This run is now complete.' }),
    ).toHaveCount(1, { timeout: 40_000 });

    // The item now shows its last run.
    await page.getByRole('link', { name: 'Work items', exact: true }).click();
    await expect(page.locator('.items-table')).toContainText('complete');
    expect(problems).toEqual([]);
  } finally {
    await app.close();
  }
});
