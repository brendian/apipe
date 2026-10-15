// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { App } from './app/App.js';
import { listOf, makeApi, prefsView, row } from './test-support.js';

afterEach(cleanup);
// axe asks for a canvas; jsdom has none and warns every time.
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { value: () => null });

const HOSTILE = [
  '<img src=x onerror=alert(1)>',
  '<script>window.__pwned = 1</script>',
  '[click](javascript:alert(1))',
  '‮evil\u0000rtl',
  'a'.repeat(5000),
];

async function noViolations(container: HTMLElement): Promise<void> {
  const results = await axe(container);
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

describe('runs list', () => {
  it('shows each run with its status word, level, cost and age, and is accessible', async () => {
    const { api } = makeApi({
      list: () =>
        listOf([
          row({ status: 'running', title: 'S03 stock changes', stage: 'CODE r2/3', cost_usd: 1.1 }),
          row({ run_id: 'r2', status: 'needs_human', title: 'S01 database', level: 'full' }),
        ]),
    });
    const { container } = render(<App api={api} />);
    const list = await screen.findByRole('list', { name: /runs/i });
    const first = within(list).getAllByRole('listitem')[0];
    expect(first?.textContent).toContain('running');
    expect(first?.textContent).toContain('S03 stock changes');
    expect(first?.textContent).toContain('Tests (3 of 5)');
    expect(first?.textContent).toContain('$1.10 of $8.00');
    expect(first?.textContent).toContain('3 min ago');
    expect(within(list).getAllByRole('listitem')[1]?.textContent).toContain('needs you');
    expect(screen.getByRole('button', { name: /All 2/ }).getAttribute('aria-pressed')).toBe('true');
    await noViolations(container);
  });

  it('renders hostile text as text and nothing else', async () => {
    const rows = HOSTILE.map((title, i) =>
      row({ run_id: `r${i}`, title, branch: HOSTILE[(i + 1) % HOSTILE.length] ?? '' }),
    );
    const { api } = makeApi({
      list: () => listOf(rows, [{ run_id: 'bad', error: HOSTILE[0] ?? '' }]),
    });
    const { container } = render(<App api={api} />);
    await screen.findByRole('list', { name: /runs/i });
    expect(container.querySelector('img, script, iframe')).toBeNull();
    expect(container.querySelector('[onerror], [style]')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('updates live when main says runs changed', async () => {
    let rows = [row({ status: 'running', title: 'First' })];
    const stub = makeApi({ list: () => listOf(rows) });
    render(<App api={stub.api} />);
    await screen.findByText('First');
    rows = [row({ run_id: 'r2', title: 'Second' }), ...rows];
    stub.emit('runs.changed', {});
    await screen.findByText('Second', {}, { timeout: 3000 });
  });

  it('filters ask main for that filter and remember it; empty states say what to do', async () => {
    const stub = makeApi();
    render(<App api={stub.api} />);
    await screen.findByText(/No runs yet in this repo/);
    expect(screen.getByRole('button', { name: 'New work item' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Complete/ }));
    await waitFor(() => expect(stub.fns.runsList).toHaveBeenLastCalledWith({ show: 'complete' }));
    expect(stub.fns.prefsSet).toHaveBeenCalledWith({ run_filter: 'complete' });
    await screen.findByText(/No runs match this filter|No runs yet/);
  });
});

describe('run page and welcome', () => {
  it('a starting run shows its console; "no such run" and "can\'t read" differ', async () => {
    const open = async (stub: ReturnType<typeof makeApi>) => {
      render(<App api={stub.api} />);
      fireEvent.click(await screen.findByRole('link', { name: /Add clamp/ }));
    };
    const rows = () => listOf([row({ run_id: 'r1' })]);
    await open(
      makeApi({
        list: rows,
        detail: () => ({
          kind: 'starting',
          run_id: 'r1',
          alive: false,
          console_tail: 'boom: no tool',
        }),
      }),
    );
    await screen.findByText("The run didn't start. Here is why:");
    expect(screen.getByLabelText('Console output').textContent).toBe('boom: no tool');
    cleanup();
    await open(makeApi({ list: rows, detail: () => null }));
    await screen.findByRole('heading', { name: 'No such run' });
    cleanup();
    await open(makeApi({ list: rows, detailError: "Can't read this run: bad json" }));
    expect((await screen.findByRole('alert')).textContent).toBe("Can't read this run: bad json");
  });

  it('a window with no repo opens on the welcome page, with recents and the picker', async () => {
    const stub = makeApi({
      repo: null,
      prefs: prefsView({
        recent: [
          { index: 0, name: 'alpha', path: '/code/alpha', exists: true },
          { index: 1, name: 'gone', path: '/code/gone', exists: false },
        ],
      }),
    });
    const { container } = render(<App api={stub.api} />);
    await screen.findByRole('heading', { name: 'advpipe' });
    fireEvent.click(screen.getByRole('button', { name: 'Open a repo…' }));
    expect(stub.fns.pick).toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'gone' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('(not found)')).toBeTruthy();
    await noViolations(container);
  });

  it('failing setup checks send a repo window to welcome and say what to do', async () => {
    const bad = {
      git: { ok: true, level: 'ok' as const, version: '2.56', text: 'git 2.56 found' },
      repo: {
        ok: false,
        level: 'bad' as const,
        is_git: false,
        has_commit: false,
        branch: '',
        dirty: 0,
        text: "This folder isn't a git repo. Run `git init` and make a first commit.",
      },
      claude: {
        ok: true,
        level: 'ok' as const,
        login: 'subscription' as const,
        version: '1',
        text: 'Claude Code found.',
      },
      items_dir: {
        ok: true,
        level: 'ok' as const,
        path: 'work-items',
        exists: true,
        text: 'Work items live in work-items/.',
      },
    };
    const stub = makeApi({ preflight: bad });
    const { container } = render(<App api={stub.api} />);
    await screen.findByText(/make a first commit/);
    expect(screen.queryByRole('link', { name: 'Go to runs' })).toBeNull();
    await noViolations(container);
  });
});
