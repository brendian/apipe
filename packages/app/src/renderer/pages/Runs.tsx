import { useState } from 'react';
import { ageOf, type FilterKey } from '@advpipe/contracts';
import { Callout } from '../components/Callout.js';
import { EmptyState } from '../components/EmptyState.js';
import { FilterTabs } from '../components/FilterTabs.js';
import { LevelChip } from '../components/LevelChip.js';
import { PageHeading } from '../components/PageHeading.js';
import { StatusChip } from '../components/StatusChip.js';
import { UsageLine } from '../components/UsageLine.js';
import { costText } from '../components/format.js';
import { useNow } from '../components/useNow.js';
import { useApi } from '../state/api.js';
import { useRemote } from '../state/remote.js';
import { Link, useRouter } from '../state/router.js';
import { useWindow } from '../state/window.js';

/** The runs list (docs/05 §5.1): newest first, live, filtered. */
export function Runs() {
  const api = useApi();
  const { navigate } = useRouter();
  const { initialFilter } = useWindow();
  const [show, setShow] = useState<FilterKey>(initialFilter);
  const now = useNow();
  const { state } = useRemote(() => api.runs.list({ show }), [api, show], {
    'runs.changed': () => true,
  });

  function choose(key: FilterKey): void {
    setShow(key);
    void api.app.prefs.set({ run_filter: key }); // remembered per repo
  }

  const list = state.status === 'ready' ? state.value : null;
  return (
    <>
      <div className="page-head">
        <PageHeading>Runs</PageHeading>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => navigate('/runs/new')}>
            New run
          </button>
        </div>
      </div>
      <UsageLine />
      {state.status === 'error' ? <Callout tone="bad">{state.error}</Callout> : null}
      {list ? (
        <>
          <FilterTabs value={show} counts={list.counts} onChange={choose} />
          {list.rows.length > 0 ? (
            <ul className="runs" aria-label="Runs, newest first">
              {list.rows.map((r) => (
                <li key={r.run_id}>
                  <Link to={`/runs/${r.run_id}`} className="run-row">
                    <StatusChip status={r.status} />
                    <span className="title">{r.title}</span>
                    <span className="trail">
                      <span>{costText(r.cost_usd, r.budget_usd)}</span>
                      <span>{ageOf(r.started_at, now)}</span>
                    </span>
                    <span className="meta">
                      <LevelChip level={r.level} />
                      <span>{r.stage}</span>
                      {r.branch ? <span className="mono">{r.branch}</span> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : list.counts.all === 0 ? (
            <EmptyState
              actions={
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => navigate('/runs/new')}
                  >
                    New run
                  </button>
                  <button type="button" className="btn" onClick={() => navigate('/items/new')}>
                    New work item
                  </button>
                </>
              }
            >
              No runs yet in this repo. Start one from a work item or type a one-off task.
            </EmptyState>
          ) : (
            <EmptyState>No runs match this filter.</EmptyState>
          )}
          {list.unreadable.length > 0 ? (
            <details>
              <summary>
                {list.unreadable.length} run{list.unreadable.length === 1 ? '' : 's'} couldn't be
                read
              </summary>
              <ul>
                {list.unreadable.map((u) => (
                  <li key={u.run_id}>
                    <span className="mono">{u.run_id}</span>: {u.error}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : state.status === 'loading' ? (
        <p>Loading runs…</p>
      ) : null}
    </>
  );
}
