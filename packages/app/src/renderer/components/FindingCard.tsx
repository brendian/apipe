import type { Finding } from '@advpipe/contracts';

/** One finding: severity, category, where, what and the evidence. All text, never HTML. */
export function FindingCard({ finding: f }: { finding: Finding }) {
  const where = f.file ? (f.line !== null ? `${f.file}:${f.line}` : f.file) : '';
  return (
    <article className={`finding finding-${f.severity}`}>
      <header>
        <span className={`chip ${f.severity === 'blocking' ? 'chip-bad' : 'chip-warn'}`}>
          <span aria-hidden="true">{f.severity === 'blocking' ? '✖' : '⚠'}</span>
          {f.severity}
        </span>{' '}
        <span className="chip chip-level">{f.category}</span>{' '}
        {where ? <span className="mono">{where}</span> : null}
        {f.criterion ? <span className="mono"> {f.criterion}</span> : null}{' '}
        <span className="muted">{f.id}</span>
      </header>
      <p className="claim">{f.claim}</p>
      {f.evidence ? (
        <p>
          <strong>Evidence:</strong> {f.evidence}
        </p>
      ) : null}
      {f.suggested_check ? (
        <p>
          <strong>Suggested check:</strong> {f.suggested_check}
        </p>
      ) : null}
    </article>
  );
}
