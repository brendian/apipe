import { STATUSES, ageOf } from '@advpipe/contracts';
import { Callout } from '../components/Callout.js';
import { EmptyState } from '../components/EmptyState.js';
import { LevelChip } from '../components/LevelChip.js';
import { PageHeading } from '../components/PageHeading.js';
import { StatusChip } from '../components/StatusChip.js';
import { costText } from '../components/format.js';
import { useNow } from '../components/useNow.js';
import { useApi } from '../state/api.js';
import { useRemote } from '../state/remote.js';
import { Link } from '../state/router.js';

/**
 * A run's page. M7 builds the part the list needs: the starting-up panel and a header. The
 * timeline, checks, report and live log are M8 (docs/11).
 */
export function RunPage({ runId }: { runId: string }) {
  const api = useApi();
  const { state } = useRemote(() => api.runs.detail({ runId }), [api, runId], {
    'run.changed': (p) => p.runId === runId,
    'runs.changed': () => true, // the starting-up panel waits for run.json to appear
  });
  const now = useNow();
  const back = <Link to="/runs">← All runs</Link>;

  if (state.status === 'loading') return <p>Loading…</p>;
  if (state.status === 'error' && state.value === undefined) {
    return (
      <>
        <p>{back}</p>
        <PageHeading>Run</PageHeading>
        <Callout tone="bad">{state.error}</Callout>
      </>
    );
  }
  const detail = state.status === 'ready' ? state.value : (state.value ?? null);
  if (detail === null) {
    return (
      <>
        <p>{back}</p>
        <PageHeading>No such run</PageHeading>
        <EmptyState
          actions={
            <Link to="/runs" className="btn">
              See all runs
            </Link>
          }
        >
          There is no run with this id in this repo. It may have been cleaned up.
        </EmptyState>
      </>
    );
  }
  if (detail.kind === 'starting') {
    return (
      <>
        <p>{back}</p>
        <PageHeading>Starting…</PageHeading>
        <p>
          {detail.alive
            ? 'Starting… the run is setting up its working copy.'
            : "The run didn't start. Here is why:"}
        </p>
        {detail.console_tail ? <pre aria-label="Console output">{detail.console_tail}</pre> : null}
      </>
    );
  }
  const r = detail.row;
  return (
    <>
      <p>{back}</p>
      <PageHeading>{r.title}</PageHeading>
      <p>{STATUSES[r.status].help}</p>
      <dl className="facts">
        <div>
          <dt>Status</dt>
          <dd>
            <StatusChip status={r.status} />
          </dd>
        </div>
        <div>
          <dt>Stage</dt>
          <dd>{r.stage}</dd>
        </div>
        <div>
          <dt>Level</dt>
          <dd>
            <LevelChip level={r.level} />
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{costText(r.cost_usd, r.budget_usd)}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{ageOf(r.started_at, now)}</dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd className="mono">{r.branch || '—'}</dd>
        </div>
        <div>
          <dt>Run id</dt>
          <dd className="mono">{r.run_id}</dd>
        </div>
      </dl>
      <Callout tone="info">
        The timeline, checks, report and live log for this run arrive in the next build.
      </Callout>
    </>
  );
}
