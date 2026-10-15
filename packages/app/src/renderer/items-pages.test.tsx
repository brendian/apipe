// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { App } from './app/App.js';
import { checksOf, draftOf, itemList, makeApi, ok, planOf } from './test-support.js';

afterEach(cleanup);
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { value: () => null });
// Radix's slider measures itself.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

const HOSTILE = '<img src=x onerror=alert(1)>';

const row = (over: Record<string, unknown> = {}) => ({
  rel: 'server/s01.md',
  title: 'Do S01',
  name: null,
  config: null,
  problem: null,
  last_run: null,
  git: '' as const,
  ...over,
});

async function noViolations(container: HTMLElement): Promise<void> {
  expect((await axe(container)).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

describe('work items list', () => {
  it('groups by folder with last run and git state; text stays text; accessible', async () => {
    const { api } = makeApi({
      items: {
        list: async () =>
          ok(
            itemList({
              groups: [
                { folder: '', items: [row({ rel: 'top.md', title: HOSTILE, git: 'untracked' })] },
                {
                  folder: 'server',
                  items: [
                    row({
                      last_run: {
                        run_id: 'r1',
                        status: 'complete',
                        started_at: new Date(Date.now() - 3.5 * 3600_000).toISOString(),
                      },
                    }),
                    row({ rel: 'server/bad.md', title: 'Bad', problem: 'unknown key x' }),
                  ],
                },
              ],
              skipped: ['odd!.md'],
            }),
          ),
      },
    });
    const { container } = render(<App api={api} />);
    fireEvent.click(await screen.findByRole('link', { name: 'Work items' }));
    expect(await screen.findByText('Top level')).toBeTruthy();
    expect(container.textContent).toContain(HOSTILE);
    expect(container.querySelector('img, [onerror]')).toBeNull();
    expect(screen.getByText('not in git')).toBeTruthy();
    expect(screen.getByText('3 h ago')).toBeTruthy();
    expect(screen.getByText(/Can't be run as it is: unknown key x/)).toBeTruthy();
    expect(screen.getByText(/odd!\.md/)).toBeTruthy();
    // A file with a problem has no Run link.
    const bad = screen.getByText('Bad').closest('tr') as HTMLElement;
    expect(within(bad).queryByRole('link', { name: /^Run/ })).toBeNull();
    await noViolations(container);
  });

  it('says what to do when there are no items', async () => {
    const { api } = makeApi({
      items: { list: async () => ok(itemList({ folder_exists: false })) },
    });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole('link', { name: 'Work items' }));
    expect(await screen.findByText(/no work-items\/ folder|There's no/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Write your first work item' })).toBeTruthy();
  });
});

async function openEditor(stub: ReturnType<typeof makeApi>) {
  const view = render(<App api={stub.api} />);
  fireEvent.click(await screen.findByRole('link', { name: 'Work items' }));
  fireEvent.click(await screen.findByRole('link', { name: 'Do S01' }));
  await screen.findByRole('button', { name: 'Save' });
  return view;
}
const withItem = {
  list: async () => ok(itemList({ groups: [{ folder: 'server', items: [row()] }] })),
};

describe('work item editor', () => {
  it('checks as you type, blocks Save on a problem, and sanitises the preview', async () => {
    const check = vi.fn(async (input: { body?: string }) =>
      ok(
        input.body === ''
          ? checksOf({
              ok: false,
              checks: [
                { level: 'error', text: 'The body is empty: a run would have nothing to build.' },
              ],
              preview_html: null,
            })
          : checksOf({ preview_html: `<p>hi</p>${HOSTILE}<script>window.__pwned=1</script>` }),
      ),
    );
    const stub = makeApi({
      items: { ...withItem, read: async () => ok(draftOf({ rel: 'server/s01.md' })), check },
    });
    const { container } = await openEditor(stub);
    await waitFor(() => expect(container.querySelector('.preview')?.textContent).toContain('hi'), {
      timeout: 3000,
    });
    expect(container.querySelector('.preview img, .preview script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();

    fireEvent.change(screen.getByLabelText(/Work item/), { target: { value: '' } });
    await waitFor(() => expect(screen.getByText(/The body is empty/)).toBeTruthy(), {
      timeout: 3000,
    });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Fix the problems marked above/)).toBeTruthy();
    await noViolations(container);
  });

  it('sends the digest it loaded, keeps what was typed when the save is refused', async () => {
    const save = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'server/s01.md was changed on disk since you opened it',
      })
      .mockResolvedValueOnce(ok({ changed: false }));
    const stub = makeApi({
      items: {
        ...withItem,
        read: async () => ok(draftOf({ rel: 'server/s01.md', base: 'c'.repeat(64) })),
        save,
      },
    });
    await openEditor(stub);
    fireEvent.change(screen.getByLabelText(/Work item/), { target: { value: 'my edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toContain('changed on disk');
    expect((screen.getByLabelText(/Work item/) as HTMLTextAreaElement).value).toBe('my edit');
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      rel: 'server/s01.md',
      base: 'c'.repeat(64),
      body: 'my edit',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('No changes to save.')).toBeTruthy();
  });
});

describe('delete confirmation', () => {
  it('focuses the safe button, says what git has, and only its button sends confirm', async () => {
    const del = vi.fn(async () => ok({ deleted: 'server/s01.md' }));
    const stub = makeApi({
      items: {
        ...withItem,
        read: async () => ok(draftOf({ rel: 'server/s01.md' })),
        deleteInfo: async () =>
          ok({ rel: 'server/s01.md', git: 'untracked', items_dir: 'work-items' }),
        delete: del,
      },
    });
    await openEditor(stub);
    fireEvent.click(screen.getByRole('link', { name: 'Delete' }));
    expect(await screen.findByText("It isn't in git, so this can't be undone.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep it' }));
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    await screen.findByText('Work item deleted.');
    expect(del).toHaveBeenCalledWith({ rel: 'server/s01.md', confirm: true });
  });
});

describe('new run', () => {
  const open = async (stub: ReturnType<typeof makeApi>) => {
    const view = render(<App api={stub.api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'New run' }));
    await screen.findByRole('heading', { name: 'New run' });
    return view;
  };

  it('shows the budget and level, starts at the inherited level, and sends what was shown', async () => {
    const start = vi.fn(async () => ok({ runId: '20261015-100000-abcdef' }));
    const plan = vi.fn(async () => ok(planOf()));
    const stub = makeApi({ newrun: { plan, start }, items: withItem });
    const { container } = await open(stub);
    expect(await screen.findByText('$15.00')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Tests/ })).toBeTruthy();
    expect(screen.getByText('No standards review')).toBeTruthy();
    const thumb = screen.getByRole('slider');
    expect(thumb.getAttribute('aria-valuetext')).toBe('Tests');
    expect(thumb.getAttribute('aria-valuenow')).toBe('3');
    await noViolations(container);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'server/s01.md' } });
    const startBtn = (): HTMLButtonElement => screen.getByRole('button', { name: /^Start/ });
    await waitFor(() =>
      expect(plan).toHaveBeenLastCalledWith(
        expect.objectContaining({ item: 'server/s01.md', level: '' }),
      ),
    );
    await waitFor(() => expect(startBtn().disabled).toBe(false));
    expect(startBtn().textContent).toBe('Start (up to $15.00)');
    fireEvent.click(startBtn());
    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(start.mock.calls[0]).toEqual([
      expect.objectContaining({
        item: 'server/s01.md',
        level: '',
        shown: 'tests;off;ask;ask',
        budget_shown: '15.00',
      }),
    ]);
  });

  it('a moved slider overrides the item and is sent as a number', async () => {
    const plan = vi.fn(async () => ok(planOf()));
    const stub = makeApi({ newrun: { plan }, items: withItem });
    await open(stub);
    const thumb = await screen.findByRole('slider');
    thumb.focus();
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    await waitFor(
      () => expect(plan).toHaveBeenLastCalledWith(expect.objectContaining({ level: '4' })),
      { timeout: 3000 },
    );
  });

  it('cannot start with problems, shows them, and a refused start says why', async () => {
    const stub = makeApi({
      newrun: {
        plan: async () =>
          ok(
            planOf({ ok: false, errors: ['Pick a work item, or choose to type a one-off task.'] }),
          ),
      },
    });
    await open(stub);
    expect(await screen.findByText(/Pick a work item/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Start/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('warns about real money on a Console login', async () => {
    const stub = makeApi({
      usage: {
        login: 'console',
        login_label: 'Anthropic Console credits (real money)',
        cost_label: 'real money',
        console: true,
        warn: '',
        note: '',
        meters: [],
      },
    });
    await open(stub);
    expect(
      await screen.findByText(/uses Anthropic Console credits, which is real money/),
    ).toBeTruthy();
  });
});
