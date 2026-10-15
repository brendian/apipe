import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';

// There is no URL bar, so routes live in memory: a history list with Back and Forward (docs/05 §2).

export type Route =
  | { name: 'boot' }
  | { name: 'welcome' }
  | { name: 'runs' }
  | { name: 'new-run'; item: string | null }
  | { name: 'run'; id: string }
  | { name: 'run-context'; id: string }
  | { name: 'items' }
  | { name: 'help' }
  | { name: 'not-found'; path: string };

/** `/runs/abc?x=1` → a route. Anything unknown is `not-found`, never a crash. */
export function parseRoute(path: string): Route {
  const [pathname = '', query = ''] = path.split('?');
  const parts = pathname.split('/').filter(Boolean);
  const [a, b, c] = parts;
  if (parts.length === 0 || (a === 'runs' && parts.length === 1)) return { name: 'runs' };
  if (a === 'boot' && parts.length === 1) return { name: 'boot' };
  if (a === 'welcome' && parts.length === 1) return { name: 'welcome' };
  if (a === 'help' && parts.length === 1) return { name: 'help' };
  if (a === 'items') return { name: 'items' };
  if (a === 'runs' && b === 'new' && parts.length === 2) {
    return { name: 'new-run', item: new URLSearchParams(query).get('item') };
  }
  if (a === 'runs' && b && parts.length === 2) return { name: 'run', id: b };
  if (a === 'runs' && b && c === 'context' && parts.length === 3)
    return { name: 'run-context', id: b };
  return { name: 'not-found', path: pathname };
}

type RouterApi = {
  route: Route;
  path: string;
  navigate: (path: string) => void;
  replace: (path: string) => void;
  back: () => void;
  forward: () => void;
  canBack: boolean;
  canForward: boolean;
};

const RouterContext = createContext<RouterApi | null>(null);

export function RouterProvider({
  initial = '/',
  children,
}: {
  initial?: string;
  children: ReactNode;
}) {
  const [history, setHistory] = useState({ stack: [initial], index: 0 });
  const navigate = useCallback(
    (path: string) =>
      setHistory((h) => ({ stack: [...h.stack.slice(0, h.index + 1), path], index: h.index + 1 })),
    [],
  );
  const replace = useCallback(
    (path: string) =>
      setHistory((h) => ({
        stack: h.stack.map((p, i) => (i === h.index ? path : p)),
        index: h.index,
      })),
    [],
  );
  const back = useCallback(
    () => setHistory((h) => ({ ...h, index: Math.max(0, h.index - 1) })),
    [],
  );
  const forward = useCallback(
    () => setHistory((h) => ({ ...h, index: Math.min(h.stack.length - 1, h.index + 1) })),
    [],
  );
  const path = history.stack[history.index] ?? '/';
  const value = useMemo<RouterApi>(
    () => ({
      route: parseRoute(path),
      path,
      navigate,
      replace,
      back,
      forward,
      canBack: history.index > 0,
      canForward: history.index < history.stack.length - 1,
    }),
    [path, navigate, replace, back, forward, history],
  );
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterApi {
  const router = useContext(RouterContext);
  if (!router) throw new Error('RouterProvider is missing');
  return router;
}

/** A link that navigates in memory. A real <a>, so it is focusable and announced as a link. */
export function Link({
  to,
  children,
  ...rest
}: { to: string; children: ReactNode } & Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  'href' | 'onClick'
>) {
  const { navigate } = useRouter();
  const onClick = (e: MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} {...rest}>
      {children}
    </a>
  );
}
