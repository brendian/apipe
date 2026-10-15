import type { ReactNode } from 'react';

/** The page's h1. Focus moves here on navigation, so a screen reader announces the new page. */
export function PageHeading({ children }: { children: ReactNode }) {
  return (
    <h1 tabIndex={-1} data-page-heading>
      {children}
    </h1>
  );
}
