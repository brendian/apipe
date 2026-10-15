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
      return 'Run';
    case 'items':
      return 'Work items';
    case 'help':
      return 'Help';
    case 'welcome':
      return 'Welcome';
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

  const current = (name: string): 'page' | undefined =>
    (name === 'runs' && ['runs', 'run', 'run-context', 'new-run'].includes(route.name)) ||
    (name === 'items' && route.name === 'items') ||
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
