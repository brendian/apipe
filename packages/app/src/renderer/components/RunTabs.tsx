import { Link } from '../state/router.js';

/** Progress | Spec & context: two pages of one run. */
export function RunTabs({ runId, current }: { runId: string; current: 'progress' | 'context' }) {
  return (
    <nav className="tabs" aria-label="Run pages">
      <Link to={`/runs/${runId}`} aria-current={current === 'progress' ? 'page' : undefined}>
        Progress
      </Link>
      <Link to={`/runs/${runId}/context`} aria-current={current === 'context' ? 'page' : undefined}>
        Spec &amp; context
      </Link>
    </nav>
  );
}
