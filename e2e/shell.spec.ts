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

test('the window is hardened: no Node, named bridge only, CSP enforced, clean console', async () => {
  const { app, page, problems } = await launch(makeRepo());
  try {
    await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();

    // Nothing logged as an error so far (a CSP violation would show up here). The probe below
    // causes violations on purpose, so this is checked first.
    expect(problems).toEqual([]);

    const surface = await page.evaluate(() => ({
      require: typeof (globalThis as { require?: unknown }).require,
      process: typeof (globalThis as { process?: unknown }).process,
      bridge: Object.keys(window.advpipe).sort(),
      appMethods: Object.keys(window.advpipe.app).sort(),
    }));
    expect(surface).toEqual({
      require: 'undefined',
      process: 'undefined',
      bridge: ['app', 'on', 'runs', 'usage'],
      appMethods: ['preflight', 'prefs', 'repo', 'window'],
    });

    // CSP: an injected inline script and a network fetch are both blocked. (page.evaluate itself
    // bypasses the CSP, so probe through the DOM.)
    const violated = await page.evaluate(async () => {
      const seen: string[] = [];
      document.addEventListener('securitypolicyviolation', (e) => seen.push(e.violatedDirective));
      const script = document.createElement('script');
      script.textContent = 'window.__inlineRan = true';
      document.body.append(script);
      await fetch('https://example.com/').catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { ran: '__inlineRan' in window, seen };
    });
    expect(violated.ran).toBe(false);
    expect(violated.seen.join(' ')).toMatch(/script-src/);
    expect(violated.seen.join(' ')).toMatch(/connect-src/);
    const csp = await page.evaluate(
      () =>
        document
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute('content') ?? '',
    );
    expect(csp).not.toMatch(/unsafe-/);
  } finally {
    await app.close();
  }
});

test('open a repo: empty list, then a scripted run appears live and completes', async () => {
  const repo = makeRepo();
  const { app, page, problems, userData } = await launch(repo);
  try {
    await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
    await expect(page.getByText('No runs yet in this repo.')).toBeVisible();
    await expect(page).toHaveTitle(/Runs — advpipe — /);

    // Start a fake-agent run in a real detached worker, held at the coder so it can be watched.
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

    const row = page.getByRole('link', { name: /Add clamp/ });
    await expect(row).toBeVisible({ timeout: 20_000 }); // appears without a reload
    await expect(row).toContainText('running');
    await expect(row).toContainText('Full (5 of 5)');
    await expect(page.getByRole('button', { name: /Running 1/ })).toBeVisible();

    writeFileSync(release, '');
    await expect(row).toContainText('complete', { timeout: 40_000 });

    // The row opens the run's page, which says where the run is.
    await row.click();
    await expect(page.getByRole('heading', { name: 'Add clamp' })).toBeVisible();
    await expect(page.locator('dd.mono', { hasText: request.run_id })).toBeVisible();
    expect(problems).toEqual([]);
  } finally {
    await app.close();
  }
});

test('a window with no repo opens on the welcome page', async () => {
  const { app, page, problems } = await launch();
  try {
    await expect(page.getByRole('heading', { name: 'advpipe' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open a repo…' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    expect(problems).toEqual([]);
  } finally {
    await app.close();
  }
});
