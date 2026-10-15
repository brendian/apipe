import { useState } from 'react';
import { type RunDetail } from '@advpipe/contracts';
import { useApi } from '../state/api.js';
import { Link, useRouter } from '../state/router.js';
import { Callout } from './Callout.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { ConsoleWarning } from './ConsoleWarning.js';

/** The buttons that are valid for this run's status (docs/05 §5.2.2). The host checks again. */
export function RunActions({ runId, detail: d }: { runId: string; detail: RunDetail }) {
  const api = useApi();
  const { replace } = useRouter();
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const over = d.row.status === 'budget_exceeded';
  const [budget, setBudget] = useState(over ? String(d.suggested_budget) : '');
  const can = (a: (typeof d.actions)[number]): boolean => d.actions.includes(a);

  async function cancel(): Promise<void> {
    setAsking(false);
    setBusy(true);
    const r = await api.run.cancel({ runId });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setError('');
    replace(`/runs/${runId}?notice=cancelled`);
  }
  async function resume(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    const r = await api.run.resume({ runId, budget });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setError('');
    replace(`/runs/${runId}?notice=resumed`);
  }
  async function reveal(what: 'worktree' | 'runDir' | 'report'): Promise<void> {
    const r = await api.run.reveal({ runId, what });
    setError(r.ok ? '' : r.error);
  }

  const spent = `$${d.row.cost_usd.toFixed(2)}`;
  const total = d.row.budget_usd === null ? null : `$${d.row.budget_usd.toFixed(2)}`;
  return (
    <section className="run-actions" aria-label="Actions">
      {can('resume') ? (
        <form className="inline-form" onSubmit={(e) => void resume(e)}>
          <ConsoleWarning usage={d.usage} budget={d.row.budget_usd} />
          <label htmlFor="resume-budget">{over ? 'New budget' : 'Budget'} $</label>
          <input
            id="resume-budget"
            inputMode="decimal"
            size={7}
            maxLength={20}
            autoComplete="off"
            value={budget}
            required={over}
            placeholder={!over && d.row.budget_usd !== null ? d.row.budget_usd.toFixed(2) : ''}
            onChange={(e) => setBudget(e.target.value)}
            aria-describedby="resume-help"
          />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Resume
          </button>
          <small id="resume-help" className="muted">
            The total for the run: it has spent {spent}
            {over
              ? ' and ran out, so it needs more to continue'
              : total !== null
                ? ` of ${total}. Empty keeps that`
                : ''}
            . Resuming carries on in the background.
          </small>
        </form>
      ) : null}
      {can('cancel') ? (
        <button type="button" className="btn" disabled={busy} onClick={() => setAsking(true)}>
          Cancel run
        </button>
      ) : null}
      {can('clean') ? (
        <Link to={`/runs/${runId}/clean`} className="btn">
          Clean up…
        </Link>
      ) : null}
      {d.worktree_kept ? (
        <button type="button" className="btn" onClick={() => void reveal('worktree')}>
          Open working copy
        </button>
      ) : null}
      <button type="button" className="btn" onClick={() => void reveal('report')}>
        Open report.md
      </button>
      <button type="button" className="btn" onClick={() => void reveal('runDir')}>
        Open run folder
      </button>
      {error ? <Callout tone="bad">{error}</Callout> : null}
      {asking ? (
        <ConfirmDialog
          title="Cancel this run?"
          safeLabel="Keep it running"
          confirmLabel="Cancel the run"
          onClose={() => setAsking(false)}
          onConfirm={() => void cancel()}
        >
          <p>Stop this run at the next safe point? It can be resumed.</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
