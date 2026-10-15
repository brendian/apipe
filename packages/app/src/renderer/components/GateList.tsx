import type { GatesViewData } from '@advpipe/contracts';

const ICON = { pass: '✔', fail: '✖', skipped: '–' } as const;

/** The checks of one step: name, result, command, and the output of a failing one. */
export function GateList({ label, view }: { label: string; view: GatesViewData }) {
  if (!view.readable) {
    return (
      <p>
        <strong>{label}:</strong> couldn't read the results ({view.path}).
      </p>
    );
  }
  return (
    <div className="gates">
      <h4>{label}</h4>
      <ul>
        {view.results.map((g, i) => (
          <li key={`${g.name}-${i}`}>
            <span
              className={`chip ${g.status === 'fail' ? 'chip-bad' : g.status === 'pass' ? 'chip-ok' : 'chip-neutral'}`}
            >
              <span aria-hidden="true">{ICON[g.status]}</span>
              {g.name}:{' '}
              {g.status === 'fail'
                ? `fail (exit ${g.returncode ?? '?'})`
                : g.status === 'skipped'
                  ? `skipped${g.skip_reason ? ` (${g.skip_reason})` : ''}`
                  : 'pass'}
            </span>{' '}
            {g.command ? <code className="mono">{g.command}</code> : null}
            {g.status === 'fail' && g.output ? (
              <pre className="scroll-box" tabIndex={0} aria-label={`${g.name} output`}>
                {g.output}
              </pre>
            ) : null}
          </li>
        ))}
        {view.results.length === 0 ? <li className="muted">No checks.</li> : null}
      </ul>
    </div>
  );
}
