import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';

// axe-core in the real window (colour contrast needs real layout, which jsdom can't do), run in both
// themes. A test collects what it finds in `failures` and asserts it is empty at the end, so one run
// reports every page at once.

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf-8',
);
type AxeResult = { violations: { id: string; help: string; nodes: { target: unknown[] }[] }[] };

export async function violations(page: Page): Promise<string[]> {
  // page.evaluate isn't subject to the page's CSP, so axe can be injected as source text.
  await page.evaluate(axeSource);
  const result = await page.evaluate(
    async () =>
      (await (window as unknown as { axe: { run(): Promise<unknown> } }).axe.run()) as AxeResult,
  );
  return result.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => String(n.target[0])).join(', ')})`,
  );
}

/** Axe in both themes, and no horizontal scroll on the page itself. Findings go into `failures`. */
export async function check(page: Page, name: string, failures: string[]): Promise<void> {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    for (const v of await violations(page)) failures.push(`${name} [${theme}] ${v}`);
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 0) failures.push(`${name}: the page scrolls sideways by ${overflow}px`);
}
