import { useCallback, useEffect, useState } from 'react';
import type { ThemePref } from '@advpipe/contracts';
import { useApi } from './api.js';

const ORDER: ThemePref[] = ['system', 'dark', 'light'];
export const nextTheme = (t: ThemePref): ThemePref =>
  ORDER[(ORDER.indexOf(t) + 1) % ORDER.length] ?? 'system';

/** `system` leaves the OS in charge (no attribute); light/dark force it (docs/05 §4.3). */
export function applyTheme(theme: ThemePref): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/** The theme preference: applied to the page and saved in the preferences file. */
export function useTheme(initial: ThemePref): {
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
} {
  const api = useApi();
  const [theme, set] = useState<ThemePref>(initial);
  useEffect(() => applyTheme(initial), [initial]);
  const setTheme = useCallback(
    (t: ThemePref) => {
      set(t);
      applyTheme(t);
      void api.app.prefs.set({ theme: t });
    },
    [api],
  );
  return { theme, setTheme };
}
