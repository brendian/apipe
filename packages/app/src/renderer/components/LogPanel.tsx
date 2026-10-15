import { useEffect, useRef, useState } from 'react';
import { isLogLine, type EventLine } from '@advpipe/contracts';
import { useApi } from '../state/api.js';
import { usePanel } from '../state/panels.js';

/** Lines kept in memory; a longer log says so. */
export const MAX_LOG_LINES = 5_000;

const clock = (ts: string): string => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
};

/**
 * The run's events, `HH:MM:SS message`. Subscribes from byte 0 and appends what main pushes; the
 * window keeps only the offset it has been sent, so nothing shows twice (docs/04 §6). Scrolls to the
 * newest line only while the reader is already at the bottom.
 */
export function LogPanel({ runId, live }: { runId: string; live: boolean }) {
  const api = useApi();
  const [lines, setLines] = useState<EventLine[]>([]);
  const [cut, setCut] = useState(false);
  const offset = useRef(0);
  const box = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);
  const [open, setOpen] = usePanel(`${runId}/log`, live);

  useEffect(() => {
    offset.current = 0;
    setLines([]);
    setCut(false);
    const off = api.on('run.log', (p) => {
      if (p.runId !== runId || p.next_offset <= offset.current) return;
      offset.current = p.next_offset;
      const fresh = p.lines.filter(isLogLine);
      if (fresh.length === 0) return;
      setLines((prev) => {
        const all = [...prev, ...fresh];
        if (all.length <= MAX_LOG_LINES) return all;
        setCut(true);
        return all.slice(-MAX_LOG_LINES);
      });
    });
    void api.runs.log.subscribe({ runId, offset: 0 });
    return () => {
      off();
      void api.runs.log.unsubscribe({ runId });
    };
  }, [api, runId]);

  useEffect(() => {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <details
      className="log-panel"
      open={open}
      onToggle={(e) => {
        if (e.currentTarget.open !== open) setOpen(e.currentTarget.open);
      }}
    >
      <summary>
        <strong>{live ? 'Live log' : 'Log'}</strong>
        <span className="muted"> · {lines.length} event(s)</span>
      </summary>
      {cut ? (
        <p className="muted">Showing the last {MAX_LOG_LINES.toLocaleString('en')} events.</p>
      ) : null}
      <ol
        ref={box}
        className="log"
        tabIndex={0}
        aria-label="Run log"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {lines.map((l, i) => (
          <li key={i} className={l.kind === 'usage' ? 'log-usage' : ''}>
            <span className="mono muted">{clock(l.ts)}</span>{' '}
            {l.kind === 'decision' ? <span aria-hidden="true">◆ </span> : null}
            {l.message}
          </li>
        ))}
        {lines.length === 0 ? <li className="muted">No events yet.</li> : null}
      </ol>
    </details>
  );
}
