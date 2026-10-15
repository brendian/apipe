import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { Config } from '@advpipe/contracts';
import { newRunId, startRun } from '@advpipe/engine';
import {
  happyJson,
  runRequest,
  scriptEnv,
  type JsonScript,
} from '../packages/engine/test/helpers/worker.js';
import { launch, makeRepo, workerEntry } from './support.js';

test('watch a run complete: timeline, live log, report and next steps update without a reload', async () => {
  const repo = makeRepo();
  const { app, page, problems, userData } = await launch(repo);
  try {
    const release = path.join(userData, 'release');
    const script: JsonScript = { scripts: happyJson(), hold: { role: 'coder', until: release } };
    const config = Config.parse({
      gates: { test: [process.execPath, '--test'], types: [], lint: [], security: [] },
    });
    const request = {
      ...runRequest(repo, { work_item: '# Add clamp\nclamp(x, lo, hi)' }),
      run_id: newRunId(),
    };
    startRun(repo, request, { workerEntry, config, env: scriptEnv(userData, script) });

    await page.getByRole('link', { name: /Add clamp/ }).click({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Add clamp' })).toBeVisible();

    // Held at the coder: the strip shows where it is, and the log has the earlier stages.
    const strip = page.locator('.timeline-strip');
    await expect(strip).toContainText('SPEC');
    await expect(strip.locator('li', { hasText: 'CODE' })).toContainText('in progress', {
      timeout: 20_000,
    });
    const log = page.getByRole('list', { name: 'Run log' });
    await expect(log).toContainText('test-author', { timeout: 20_000 });
    await expect(page.getByText(/Live log/)).toBeVisible();

    writeFileSync(release, '');
    await expect(
      page.getByRole('status').filter({ hasText: 'This run is now complete.' }),
    ).toHaveCount(1, { timeout: 40_000 });
    await expect(strip.locator('li', { hasText: 'CODE' })).toContainText('done');
    await expect(strip.locator('li', { hasText: 'ARBITER' })).toContainText('not needed');
    await expect(page.getByRole('heading', { name: 'Report' })).toBeVisible();
    await expect(page.locator('.report')).toContainText(request.run_id);

    // Next steps are git commands with a Copy button; the app never runs them.
    const merge = page.locator('code', { hasText: /git -C .* merge advpipe\// });
    await expect(merge).toBeVisible();
    await page.getByRole('button', { name: /Copy Merge it/ }).click();
    await expect(page.getByText('Copied')).toBeAttached();

    // A round panel opens to show what the critic saw.
    await page.getByText('Round 1').first().click();
    await expect(page.getByText(/Diff the critic judged/).first()).toBeVisible();

    // The Spec & context tab.
    await page.getByRole('link', { name: 'Spec & context' }).click();
    await expect(page.getByRole('heading', { name: 'Work item' })).toBeVisible();
    await expect(page.locator('#ctx-task')).toContainText('3 acceptance criteria');
    expect(problems).toEqual([]);
  } finally {
    await app.close();
  }
});
