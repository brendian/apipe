import { CHOICE_VIEWS, DECISION_TITLES, type DecisionViewData } from '@advpipe/contracts';
import { FindingCard } from './FindingCard.js';

/**
 * What the run is waiting for you to decide, read-only: the controls (and the confirmation pages)
 * come with the actions milestone (docs/11 M10).
 */
export function DecisionSummary({ view }: { view: DecisionViewData }) {
  const d = view.decision;
  return (
    <section className="decision" aria-labelledby="decision-h">
      <h2 id="decision-h">{DECISION_TITLES[d.kind]}</h2>
      <p>{d.explanation}</p>
      {view.pending.length > 0 ? (
        <ul>
          {view.pending.map((q) => (
            <li key={q.id}>
              <strong>{q.id}</strong> {q.text}
            </li>
          ))}
        </ul>
      ) : null}
      {d.findings.map((f) => (
        <FindingCard key={f.id} finding={f} />
      ))}
      {view.retry_warning ? <p>{view.retry_warning}</p> : null}
      <ul className="choices" aria-label="Choices">
        {view.choices.map((c) => (
          <li key={c}>
            <strong>{CHOICE_VIEWS[c]?.label ?? c}</strong>: {CHOICE_VIEWS[c]?.help ?? ''}
          </li>
        ))}
      </ul>
    </section>
  );
}
