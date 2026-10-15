import type { ReactNode } from 'react';

/** A boxed note. `bad` is announced at once (role=alert); the others are plain regions. */
export function Callout({
  tone,
  children,
}: {
  tone: 'info' | 'warn' | 'bad';
  children: ReactNode;
}) {
  return (
    <div className={`callout callout-${tone}`} role={tone === 'bad' ? 'alert' : 'note'}>
      {children}
    </div>
  );
}
