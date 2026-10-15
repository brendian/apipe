import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { Config } from '@advpipe/contracts';
import { newRunId, startRun } from '@advpipe/engine';
import {
  happyJson,
  runRequest,
  scriptEnv,
  w,
  type JsonScript,
} from '../packages/engine/test/helpers/worker.js';
import { IMPL_WRONG, TASK_MD } from '../packages/engine/test/helpers/samples.js';
import { launch, makeRepo, root, workerEntry } from './support.js';

// `npm run screenshots` (docs/05 §10, docs/09 §9): drives the app against a demo repo, with
// scripted agents, and writes docs/screenshots/*.png. Not part of `npm run test:e2e` (the name
// doesn't match `*.spec.ts`); see playwright.screenshots.config.ts.

test.setTimeout(240_000);

const out = path.join(root, 'docs', 'screenshots');
const pass = JSON.stringify({ verdict: 'PASS', findings: [] });
const config = Config.parse({
  gates: { test: [process.execPath, '--test'], types: [], lint: [], security: [] },
});

function begin(repo: string, dir: string, title: string, script: JsonScript, level = 'full'): void {
  const request = {
    ...runRequest(repo, { work_item: `# ${title}\nclamp(x, lo, hi)` }),
    run_id: newRunId(),
    level: level as 'full',
  };
  startRun(repo, request, {
    workerEntry,
    config,
    env: scriptEnv(dir, script, `${request.run_id}.json`),
  });
}

const resize = (app: ElectronApplication, width: number): Promise<void> =>
  app.evaluate(({ BrowserWindow }, w) => {
    BrowserWindow.getAllWindows()[0]?.setSize(w, 900);
  }, width);

const theme = (page: Page, t: 'light' | 'dark'): Promise<void> =>
  page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), t);

test('screenshots of every main page', async () => {
  mkdirSync(out, { recursive: true });
  const repo = makeRepo();
  const dir = path.join(repo, '..', `shots-${path.basename(repo)}`);
  mkdirSync(dir, { recursive: true });
  const release = path.join(dir, 'release');
  writeFileSync(
    path.join(repo, 'pipeline.toml'),
    `[limits]\nbudget_usd_per_task = 8\n[gates]\ntest = [${JSON.stringify(process.execPath)}, "--test"]\ntypes = []\nlint = []\nsecurity = []\n`,
  );
  mkdirSync(path.join(repo, 'work-items', 'server'), { recursive: true });
  writeFileSync(
    path.join(repo, 'work-items', 'server', 's04-rounding.md'),
    '---\nname: s04-rounding\nlevel: tests\n---\nRounding rules\n\nRound half-up to two decimals.\n',
  );

  const blocked = TASK_MD.replace(
    '## Open questions\n- None',
    '## Open questions\n- BLOCKING: should lo > hi swap or throw?\n- BLOCKING: may lo equal hi?',
  );
  begin(repo, dir, 'S02 clamp', { scripts: happyJson() });
  begin(repo, dir, 'S01 database', {
    scripts: { ...happyJson(), 'spec-writer': [w({ 'task.md': blocked })] },
  });
  begin(repo, dir, 'S05 refunds', {
    scripts: {
      ...happyJson(),
      coder: [w(IMPL_WRONG), 'tried', 'tried', 'tried'],
      'code-critic': [pass, pass, pass],
    },
  });
  begin(repo, dir, 'S03 stock changes', {
    scripts: happyJson(),
    hold: { role: 'coder', until: release },
  });

  const { app, page } = await launch(repo);
  const shot = (name: string): Promise<unknown> =>
    page.screenshot({ path: path.join(out, `${name}.png`) });
  try {
    await resize(app, 1100);
    const row = (title: string) => page.getByRole('link', { name: new RegExp(title) });
    await expect(row('S02 clamp')).toContainText('complete', { timeout: 90_000 });
    await expect(row('S01 database')).toContainText('needs answers', { timeout: 90_000 });
    await expect(row('S05 refunds')).toContainText('needs a decision', { timeout: 90_000 });
    await expect(row('S03 stock changes')).toContainText('running', { timeout: 90_000 });
    await theme(page, 'light');
    await shot('runs');
    await theme(page, 'dark');
    await shot('runs-dark');

    await theme(page, 'light');
    await row('S01 database').click();
    await expect(page.getByRole('heading', { name: "Answer the spec's questions" })).toBeVisible();
    await shot('run-needs-you');

    await page.getByRole('link', { name: 'All runs' }).click();
    await row('S05 refunds').click();
    await expect(page.getByText('Fix pass 1 of 3.')).toBeVisible();
    await shot('run-decision');

    await page.getByRole('link', { name: 'All runs' }).click();
    await row('S02 clamp').click();
    await expect(page.getByRole('heading', { name: 'Report' })).toBeVisible();
    await page.getByText('Round 1').first().click();
    await shot('run-detail');
    await resize(app, 768);
    await theme(page, 'dark');
    await shot('run-detail-tablet-dark');
    await resize(app, 1100);
    await theme(page, 'light');

    await page.getByRole('link', { name: 'Spec & context' }).click();
    await expect(page.getByRole('heading', { name: 'Work item' })).toBeVisible();
    await shot('spec-context');

    await page.keyboard.press('g');
    await page.keyboard.press('i');
    await expect(page.getByRole('heading', { name: 'Work items' })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Edit server\/s04-rounding/ })).toBeVisible();
    await shot('work-items');

    await page.getByRole('link', { name: /^Edit server\/s04-rounding/ }).click();
    await expect(page.getByLabel(/^Work item/)).toBeVisible();
    await shot('item-editor');

    await page.getByRole('link', { name: 'Work items', exact: true }).click();
    await page.getByRole('link', { name: /^Run server\/s04-rounding/ }).click();
    await expect(page.getByText('This can spend up to')).toBeVisible();
    await shot('new-run');

    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Help' })
      .click();
    await expect(page.getByRole('heading', { name: 'How advpipe works' })).toBeVisible();
    await shot('help');
  } finally {
    writeFileSync(release, ''); // let the held run finish; nothing is left waiting
    await page.waitForTimeout(500);
    await app.close();
  }
});
