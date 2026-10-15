// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { App } from './app/App.js';
import { makeApi } from './test-support.js';

afterEach(cleanup);
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { value: () => null });
// The slider (New run) needs this and jsdom has none.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const goTo = async (stub: ReturnType<typeof makeApi>, keys: string[]) => {
  render(<App api={stub.api} />);
  await screen.findByRole('heading', { name: 'Runs' });
  for (const key of keys) fireEvent.keyDown(document.body, { key });
};

describe('help page', () => {
  it('is built from what the app sends, lists every section, and opens the log folder', async () => {
    const stub = makeApi();
    const { container } = render(<App api={stub.api} />);
    await screen.findByRole('heading', { name: 'Runs' });
    fireEvent.click(screen.getByRole('link', { name: 'Help' }));
    await screen.findByRole('heading', { name: 'How advpipe works' });
    await screen.findByText('Merge it yourself.'); // a status row, from the data
    expect(screen.getByText('claude-opus-5-5')).toBeTruthy();
    const toc = screen.getByRole('navigation', { name: 'On this page' });
    expect(toc.querySelectorAll('a').length).toBeGreaterThanOrEqual(12);
    for (const a of toc.querySelectorAll('a')) {
      expect(container.querySelector(a.getAttribute('href') ?? '#none')).not.toBeNull();
    }
    await screen.findByText(/advpipe 0\.0\.0/);
    // No command line to point at, no browser to point at.
    expect(container.textContent).not.toMatch(/advpipe (run|resume|ui)\b|127\.0\.0\.1/);
    fireEvent.click(screen.getByRole('button', { name: 'Open log folder' }));
    expect(stub.fns.openLogs).toHaveBeenCalled();
    const results = await axe(container);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe('keyboard shortcuts', () => {
  it('g then i / h / r navigate; n starts a new run', async () => {
    await goTo(makeApi(), ['g', 'i']);
    await screen.findByRole('heading', { name: 'Work items' });
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'h' });
    await screen.findByRole('heading', { name: 'How advpipe works' });
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'r' });
    await screen.findByRole('heading', { name: 'Runs' });
    fireEvent.keyDown(document.body, { key: 'n' });
    await screen.findByRole('heading', { name: 'New run' });
  });

  it('are ignored while typing, with a modifier held, and for a stray g', async () => {
    const stub = makeApi();
    render(<App api={stub.api} />);
    await screen.findByRole('heading', { name: 'Runs' });
    const box = document.createElement('input');
    document.body.append(box);
    fireEvent.keyDown(box, { key: 'n' });
    fireEvent.keyDown(document.body, { key: 'n', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'x' });
    fireEvent.keyDown(document.body, { key: 'n' }); // the g was used up by x: this one counts
    await screen.findByRole('heading', { name: 'New run' });
    box.remove();
  });
});
