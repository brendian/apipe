import { useEffect, useRef, type ReactNode } from 'react';
import type { ThemePref } from '@advpipe/contracts';
import { useApi } from '../state/api.js';
import { Link, useRouter, type Route } from '../state/router.js';
import { nextTheme, useTheme } from '../state/theme.js';
import { useWindow } from '../state/window.js';

export function titleOf(route: Route): string {
  switch (route.name) {
    case 'runs':
      return 'Runs';
    case 'new-run':
      return 'New run';
    case 'run':
    case 'run-context':
    case 'run-decide':
    case 'run-clean':
      return 'Run';
    case 'clean-all':
      return 'Clean up runs';
    case 'items':
    case 'item-new':
    case 'item-edit':
    case 'item-rename':
    case 'item-delete':
      return 'Work items';
    case 'help':
      return 'Help';
    case 'welcome':
      return 'Welcome';
    case 'not-found':
      return 'Page not found';
    default:
      return 'advpipe';
  }
}

const THEME_LABEL: Record<ThemePref, string> = { system: 'System', dark: 'Dark', light: 'Light' };

/** Skip link, top bar and the page frame. Navigation moves focus to the new page's heading. */
export function Shell({
  theme: initialTheme,
  children,
}: {
  theme: ThemePref;
  children: ReactNode;
}) {
  const api = useApi();
  const { route, navigate, back, forward, canBack, canForward } = useRouter();
  const { repo } = useWindow();
  const { theme, setTheme } = useTheme(initialTheme);
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Route changes: move focus to the page heading (or the page) and set the document title.
  useEffect(() => {
    document.title = repo
      ? `${titleOf(route)} — advpipe — ${repo.name}`
      : `${titleOf(route)} — advpipe`;
    // The first page shown (after the boot screen) keeps the focus where it is, so the skip link
    // is the first Tab stop of a fresh window; later navigations move focus to the new heading.
    if (route.name === 'boot') return;
    if (first.current) {
      first.current = false;
      return;
    }
    const heading = main.current?.querySelector<HTMLElement>('[data-page-heading]');
    (heading ?? main.current)?.focus();
  }, [route, repo]);

  // Native menu items arrive as pushes and only navigate.
  useEffect(
    () =>
      api.on('app.menu', ({ action }) => {
        if (action === 'runs') navigate('/runs');
        else if (action === 'new-run') navigate('/runs/new');
        else if (action === 'items') navigate('/items');
        else if (action === 'new-item') navigate('/items/new');
        else if (action === 'help') navigate('/help');
        else setTheme(action.slice('theme-'.length) as ThemePref);
      }),
    [api, navigate, setTheme],
  );

  // A clicked desktop notification opens its run.
  useEffect(
    () => api.on('app.openRun', ({ runId }) => navigate(`/runs/${runId}`)),
    [api, navigate],
  );

  // ⌘/Ctrl+[ and ⌘/Ctrl+] are Back and Forward.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '[') back();
      else if (e.key === ']') forward();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [back, forward]);

  // Single-key shortcuts (docs/05 §4.3): `g r`, `g i`, `g h`, `n`. They never fire while someone is
  // typing, with a modifier held, or on the welcome page (no repo to go to).
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!repo) return;
    const clear = (): void => {
      if (pending.current) clearTimeout(pending.current);
      pending.current = null;
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) {
        return;
      }
      if (pending.current) {
        clear();
        const to = { r: '/runs', i: '/items', h: '/help' }[e.key];
        if (to) {
          e.preventDefault();
          navigate(to);
        }
      } else if (e.key === 'g') {
        pending.current = setTimeout(clear, 1500);
      } else if (e.key === 'n' && !el?.closest('dialog')) {
        e.preventDefault();
        navigate('/runs/new');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clear();
    };
  }, [navigate, repo]);

  const current = (name: string): 'page' | undefined =>
    (name === 'runs' &&
      ['runs', 'run', 'run-context', 'run-decide', 'run-clean', 'clean-all', 'new-run'].includes(
        route.name,
      )) ||
    (name === 'items' && route.name.startsWith('item')) ||
    (name === 'help' && route.name === 'help')
      ? 'page'
      : undefined;

  return (
    <>
      <a
        className="skip-link"
        href="#content"
        onClick={(e) => {
          e.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="topbar">
        <Link to="/runs" className="brand">
          advpipe
        </Link>
        {repo ? <span className="repo">{repo.name}</span> : null}
        <span className="history">
          <button type="button" onClick={back} disabled={!canBack} aria-label="Back">
            ‹
          </button>
          <button type="button" onClick={forward} disabled={!canForward} aria-label="Forward">
            ›
          </button>
        </span>
        {repo ? (
          <nav aria-label="Main">
            <Link to="/runs" aria-current={current('runs')}>
              Runs
            </Link>
            <Link to="/items" aria-current={current('items')}>
              Work items
            </Link>
            <Link to="/help" aria-current={current('help')}>
              Help
            </Link>
          </nav>
        ) : null}
        <button
          type="button"
          onClick={() => setTheme(nextTheme(theme))}
          aria-label={`Theme: ${THEME_LABEL[theme]}. Switch to ${THEME_LABEL[nextTheme(theme)]}.`}
        >
          Theme: {THEME_LABEL[theme]}
        </button>
      </header>
      <main id="content" tabIndex={-1} ref={main}>
        {children}
      </main>
      <div role="status" aria-live="polite" className="visually-hidden">
        {titleOf(route)}
      </div>
    </>
  );
}
