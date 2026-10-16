import { useState } from 'react';
import {
  CHOICE_VIEWS,
  DECISION_TITLES,
  MAX_NOTE_CHARS,
  decisionNotice,
  type RunDetail,
} from '@advpipe/contracts';
import { useApi } from '../state/api.js';
import { useDraft } from '../state/drafts.js';
import { Link, useRouter } from '../state/router.js';
import { Callout } from './Callout.js';
import { ConsoleWarning } from './ConsoleWarning.js';
import { DiffView } from './DiffView.js';
import { FindingCard } from './FindingCard.js';

/**
 * Where the run stopped to ask you to choose (docs/05 §5.2.5): the explanation, the findings, and
 * one control per choice. Choices that end the run go to their own confirmation page; the others
 * are sent from here and the run goes live again.
 */
export function DecisionPanel({ runId, detail: d }: { runId: string; detail: RunDetail }) {
  const api = useApi();
  const { replace } = useRouter();
  const view = d.decision_view;
  const [note, setNote] = useDraft(`note:${runId}`, '');
  const [specDraft, setSpecDraft] = useDraft<string | null>(`spec:${runId}`, null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (view === null) return null;
  const dec = view.decision;
  const canFix = view.fix_pass <= view.max_fix_passes;
  const review = dec.kind === 'review_step';
  const specText = specDraft ?? view.review_task_md ?? '';
  const specEdited = view.review_task_md !== null && specText !== view.review_task_md;
  const spent = `$${d.row.cost_usd.toFixed(2)}`;
  const of = d.row.budget_usd === null ? '' : ` of its $${d.row.budget_usd.toFixed(2)} budget`;

  async function choose(choice: string): Promise<void> {
    setBusy(true);
    const r = await api.run.decide({
      runId,
      choice,
      ...((choice === 'fix' || choice === 'revise') && note ? { note } : {}),
      ...(choice === 'approve' && specEdited ? { edited: specText } : {}),
    });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setError('');
    setNote('');
    setSpecDraft(null);
    replace(`/runs/${runId}?notice=${decisionNotice(choice)}`);
  }

  return (
    <section className="callout callout-info decision" aria-labelledby="decision-h">
      <h2 id="decision-h">{DECISION_TITLES[dec.kind]}</h2>
      <p className="explanation">{dec.explanation}</p>
      {dec.kind === 'usage_limit' && view.add_key !== '' ? (
        <p>
          <button
            type="button"
            className="btn"
            onClick={() =>
              void api.run.openLink({ key: view.add_key as 'add_usage' | 'add_credits' })
            }
          >
            {view.add_label}
          </button>{' '}
          <small className="muted">opens in your browser. {view.retry_warning}</small>
        </p>
      ) : null}
      <ConsoleWarning usage={d.usage} budget={d.row.budget_usd} />
      {view.pending.length > 0 ? (
        <ul className="asked">
          {view.pending.map((q) => (
            <li key={q.id}>
              <strong>{q.id}</strong> {q.text}
            </li>
          ))}
        </ul>
      ) : null}
      {dec.findings.map((f) => (
        <FindingCard key={f.id} finding={f} />
      ))}
      {view.review_diff !== null ? (
        <>
          <h3>What this step changed</h3>
          <DiffView diff={view.review_diff} />
        </>
      ) : null}
      {view.review_task_md !== null ? (
        <div className="field">
          <label htmlFor="decide-spec">
            The spec <span className="muted">(task.md: edit it here, then approve)</span>
          </label>
          <textarea
            id="decide-spec"
            className="mono spec-editor"
            rows={24}
            value={specText}
            onChange={(e) => setSpecDraft(e.target.value)}
            spellCheck
          />
          <small className="muted">
            {specEdited ? 'Edited: your version is the one used.' : 'Not edited yet.'}
          </small>
        </div>
      ) : null}
      {review ? (
        <div className="field">
          <label htmlFor="decide-review-note">
            Notes for the author{' '}
            <span className="muted">
              (only needed to send them back; passed along as you write them)
            </span>
          </label>
          <textarea
            id="decide-review-note"
            className="short"
            rows={3}
            maxLength={MAX_NOTE_CHARS}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      ) : null}
      {dec.kind === 'red_checks' ? (
        <div className="field">
          <label htmlFor="decide-note">
            A note for the author{' '}
            <span className="muted">(optional, passed along as you write it)</span>
          </label>
          <textarea
            id="decide-note"
            className="short"
            rows={3}
            maxLength={MAX_NOTE_CHARS}
            placeholder="e.g. the rounding should match invoices.py"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-describedby="decide-fix-count"
          />
          <small id="decide-fix-count" className="muted">
            {canFix
              ? `Fix pass ${view.fix_pass} of ${view.max_fix_passes}.`
              : `All ${view.max_fix_passes} fix passes are used: take over, or start a new run.`}
          </small>
        </div>
      ) : null}
      <div className="choices">
        {view.choices.map((c) => {
          const cv = CHOICE_VIEWS[c];
          if (cv === undefined) return null;
          return (
            <div className="choice-option" key={c}>
              {cv.confirm ? (
                <Link to={`/runs/${runId}/decide/${c}`} className="btn">
                  {cv.label}…
                </Link>
              ) : (
                <button
                  type="button"
                  className={cv.primary ? 'btn btn-primary' : 'btn'}
                  disabled={
                    busy ||
                    (c === 'fix' && !canFix) ||
                    (c === 'revise' && !note.trim()) ||
                    (c === 'revise' && specEdited)
                  }
                  onClick={() => void choose(c)}
                >
                  {cv.label}
                </button>
              )}{' '}
              <small className="muted">{cv.help}</small>
            </div>
          );
        })}
      </div>
      {error ? <Callout tone="bad">{error}</Callout> : null}
      <small className="muted">
        It has spent {spent}
        {of}
        {d.usage.login === 'subscription'
          ? " (API-equivalent: a subscription isn't billed per call)"
          : ''}
        . Carrying on happens in the background.
      </small>
    </section>
  );
}
