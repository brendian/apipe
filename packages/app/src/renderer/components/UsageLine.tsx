import { useApi } from '../state/api.js';
import { useRemote } from '../state/remote.js';

/**
 * "Claude subscription · 5-hour: 62% used, resets 14:00 · weekly: 30%": last known, with its
 * age, never a live gauge (docs/05 §5.1). Says nothing at all until something is known.
 */
export function UsageLine() {
  const api = useApi();
  const { state } = useRemote(() => api.usage.get({}), [api], { 'usage.changed': () => true });
  if (state.status !== 'ready') return null;
  const u = state.value;
  const known = u.login !== 'unknown' || u.meters.length > 0;
  if (!known) return null;
  const meters = u.meters.map((m) =>
    m.stale ? `${m.label}: reset since; usage unknown` : `${m.label}: ${m.text}`,
  );
  return (
    <p className="usage-line">
      {[u.login_label, ...meters].join(' · ')}
      {u.warn ? (
        <>
          {' '}
          <span className="warn">{u.warn}</span>
        </>
      ) : null}
    </p>
  );
}
