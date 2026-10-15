import type { UsageView } from '@advpipe/contracts';
import { costText } from './format.js';

/** `$1.89 of $8.00`, a bar, what kind of money it is, and the last known usage windows. */
export function CostMeter({
  cost,
  budget,
  usage,
}: {
  cost: number;
  budget: number | null;
  usage: UsageView;
}) {
  return (
    <div className="cost-meter">
      <div>{costText(cost, budget)}</div>
      {budget !== null ? (
        <meter min={0} max={budget} value={Math.min(cost, budget)} aria-label="Spent of budget">
          {costText(cost, budget)}
        </meter>
      ) : null}
      <div className="muted">{usage.cost_label}</div>
      {usage.meters.length > 0 ? (
        <ul className="usage-meters" aria-label="Usage windows">
          {usage.meters.map((m) => (
            <li key={m.window} className={m.status === 'allowed' ? '' : 'warn'}>
              {m.stale ? `${m.label}: reset since; usage unknown` : `${m.label}: ${m.text}`}
              {m.status !== 'allowed' && !m.stale ? ' ⚠' : ''}
            </li>
          ))}
        </ul>
      ) : (
        <div className="muted">{usage.note}</div>
      )}
    </div>
  );
}
