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
  | { name: 'run'; id: string; notice: string | null }
  | { name: 'run-context'; id: string }
  | { name: 'run-decide'; id: string; choice: string }
  | { name: 'run-clean'; id: string }
  | { name: 'clean-all' }
  | { name: 'items'; notice: string | null }
  | { name: 'item-new'; folder: string }
  | { name: 'item-edit'; path: string; notice: string | null }
  | { name: 'item-rename'; path: string }
  | { name: 'item-delete'; path: string }
  | { name: 'help' }
  | { name: 'not-found'; path: string };

/** `/runs/abc?x=1` → a route. Anything unknown is `not-found`, never a crash. */
export function parseRoute(path: string): Route {
  const [pathname = '', query = ''] = path.split('?');
  const parts = pathname.split('/').filter(Boolean);
  const [a, b, c, d] = parts;
  if (parts.length === 0 || (a === 'runs' && parts.length === 1)) return { name: 'runs' };
  if (a === 'boot' && parts.length === 1) return { name: 'boot' };
  if (a === 'welcome' && parts.length === 1) return { name: 'welcome' };
  if (a === 'help' && parts.length === 1) return { name: 'help' };
  const q = new URLSearchParams(query);
  if (a === 'items' && parts.length === 1) return { name: 'items', notice: q.get('notice') };
  if (a === 'items' && b === 'new' && parts.length === 2) {
    return { name: 'item-new', folder: q.get('folder') ?? '' };
  }
  if (a === 'items' && parts.length === 2 && q.has('path')) {
    const path = q.get('path') ?? '';
    if (b === 'edit') return { name: 'item-edit', path, notice: q.get('notice') };
    if (b === 'rename') return { name: 'item-rename', path };
    if (b === 'delete') return { name: 'item-delete', path };
  }
  if (a === 'runs' && b === 'new' && parts.length === 2) {
    return { name: 'new-run', item: q.get('item') };
  }
  if (a === 'clean-up' && parts.length === 1) return { name: 'clean-all' };
  if (a === 'runs' && b && parts.length === 2)
    return { name: 'run', id: b, notice: q.get('notice') };
  if (a === 'runs' && b && c === 'context' && parts.length === 3)
    return { name: 'run-context', id: b };
  if (a === 'runs' && b && c === 'clean' && parts.length === 3) return { name: 'run-clean', id: b };
  if (a === 'runs' && b && c === 'decide' && d && parts.length === 4) {
    return { name: 'run-decide', id: b, choice: d };
  }
  return { name: 'not-found', path: pathname };
}

/** `/items/edit` + `{path: 'a b.md'}` → `/items/edit?path=a+b.md`: values are encoded, never joined raw. */
export function withQuery(path: string, query: Record<string, string>): string {
  const q = new URLSearchParams(query).toString();
  return q ? `${path}?${q}` : path;
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
