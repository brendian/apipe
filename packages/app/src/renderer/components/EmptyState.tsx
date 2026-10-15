import type { ReactNode } from 'react';

/** Says what to do next (docs/05 §1): every empty state has an action. */
export function EmptyState({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      <p>{children}</p>
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}
