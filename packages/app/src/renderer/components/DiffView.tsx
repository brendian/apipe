import type { DiffViewData } from '@advpipe/contracts';

/** A unified diff, line by line as text (never HTML). Long ones are cut; the file has it all. */
export function DiffView({ diff }: { diff: DiffViewData }) {
  const added = diff.lines.filter((l) => l.kind === 'add').length;
  const removed = diff.lines.filter((l) => l.kind === 'del').length;
  const more = diff.total - diff.lines.length;
  return (
    <div className="diff">
      <p className="muted">
        <span className="mono">{diff.path}</span> · +{added} −{removed}
      </p>
      <pre className="diff-lines" tabIndex={0} aria-label={`Diff ${diff.path}`}>
        {diff.lines.map((l, i) => (
          <span key={i} className={`diff-${l.kind}`}>
            {l.text}
            {'\n'}
          </span>
        ))}
      </pre>
      {more > 0 ? (
        <p className="muted">
          {more} more line{more === 1 ? '' : 's'} in {diff.path}: open the run folder to read them.
        </p>
      ) : null}
    </div>
  );
}
