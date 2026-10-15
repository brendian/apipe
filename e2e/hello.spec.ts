import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'app');

test('hello world: window, typed bridge, CSP', async () => {
  const app = await electron.launch({
    args: [appDir],
    env: { ...process.env, ADVPIPE_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    const problems: string[] = [];
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    page.on('pageerror', (e) => problems.push(e.message));
    await page.waitForSelector('button');

    // The bridge works end to end (renderer -> preload -> main -> zod -> back).
    await page.getByRole('button', { name: 'Ping' }).click();
    await expect(page.getByTestId('reply')).toHaveText('pong: hello');

    // The renderer has no Node and sees only the named methods.
    const surface = await page.evaluate(() => ({
      require: typeof (globalThis as { require?: unknown }).require,
      process: typeof (globalThis as { process?: unknown }).process,
      bridge: Object.keys(window.advpipe).sort(),
      appMethods: Object.keys(window.advpipe.app).sort(),
    }));
    expect(surface).toEqual({
      require: 'undefined',
      process: 'undefined',
      bridge: ['app'],
      appMethods: ['ping'],
    });

    // A clean page: nothing logged as an error (a CSP violation would show up here) so far.
    expect(problems).toEqual([]);

    // CSP is enforced: an injected inline script and a network fetch are both blocked.
    // (page.evaluate itself bypasses the CSP, so probe through the DOM instead.)
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
