import { useEffect, useRef, useState } from 'react';
import { STATUSES, levelText, type RunDetail } from '@advpipe/contracts';
import { Callout } from '../components/Callout.js';
import { CommandBox } from '../components/CommandBox.js';
import { CostMeter } from '../components/CostMeter.js';
import { DecisionSummary } from '../components/DecisionSummary.js';
import { EmptyState } from '../components/EmptyState.js';
import { LogPanel } from '../components/LogPanel.js';
import { Markdown } from '../components/Markdown.js';
import { PageHeading } from '../components/PageHeading.js';
import { RunTabs } from '../components/RunTabs.js';
import { StatusChip } from '../components/StatusChip.js';
import { Timeline } from '../components/Timeline.js';
import { useApi } from '../state/api.js';
import { useRemote } from '../state/remote.js';
import { Link } from '../state/router.js';

/** A run's Progress page (docs/05 §5.2). */
export function RunPage({ runId }: { runId: string }) {
  const api = useApi();
  const { state } = useRemote(() => api.runs.detail({ runId }), [api, runId], {
    'run.changed': (p) => p.runId === runId,
    'runs.changed': () => true, // the starting-up panel waits for run.json to appear
  });
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
  return (
    <Detail
      runId={runId}
      detail={detail}
      refreshError={state.status === 'error' ? state.error : null}
      back={back}
    />
  );
}

function Detail({
  runId,
  detail: d,
  refreshError,
  back,
}: {
  runId: string;
  detail: RunDetail;
  refreshError: string | null;
  back: React.ReactNode;
}) {
  const r = d.row;
  const info = STATUSES[r.status];
  const [announce, setAnnounce] = useState('');
  const last = useRef(r.status);
  useEffect(() => {
    if (last.current !== r.status) setAnnounce(`This run is now ${info.label}.`);
    last.current = r.status;
  }, [r.status, info.label]);

  return (
    <>
      <p>{back}</p>
      <PageHeading>{d.title}</PageHeading>
      <RunTabs runId={runId} current="progress" />
      <p role="status" className="visually-hidden">
        {announce}
      </p>
      {refreshError ? (
        <Callout tone="warn">Couldn't refresh this page: {refreshError}</Callout>
      ) : null}
      <p>{info.help}</p>
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
            {levelText(r.level)} · security scan {d.scan ? 'on' : 'off'}
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>
            <CostMeter cost={r.cost_usd} budget={r.budget_usd} usage={d.usage} />
          </dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd>{d.elapsed}</dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd className="mono">{r.branch || '—'}</dd>
        </div>
        <div>
          <dt>Run id</dt>
          <dd className="mono">{r.run_id}</dd>
        </div>
        {d.work_item_file ? (
          <div>
            <dt>Work item</dt>
            <dd className="mono">{d.work_item_file}</dd>
          </div>
        ) : null}
      </dl>
      {d.decision_view ? <DecisionSummary view={d.decision_view} /> : null}
      {d.decision_view || r.status === 'needs_answers' ? (
        <Callout tone="info">
          The buttons to answer, choose, resume and cancel arrive in the next build. Until then this
          page shows what the run is waiting for.
        </Callout>
      ) : null}
      <Timeline runId={runId} steps={d.timeline} />
      <LogPanel runId={runId} live={d.live} />
      <section aria-labelledby="report-h">
        <h2 id="report-h">Report</h2>
        {d.report_html !== null ? (
          <Markdown html={d.report_html} className="report" />
        ) : (
          <p className="muted">
            {d.live
              ? 'The report is written when the run finishes or stops.'
              : 'No report was written for this run.'}
          </p>
        )}
      </section>
      {d.next_steps.length > 0 ? (
        <section aria-labelledby="next-h">
          <h2 id="next-h">Next steps</h2>
          <ol className="next-steps">
            {d.next_steps.map((s) => (
              <li key={s.label}>
                <div>{s.label}</div>
                <CommandBox command={s.command} label={s.label} />
              </li>
            ))}
          </ol>
          {r.status === 'complete' ? (
            <p className="muted">advpipe never merges or pushes. These are for you to run.</p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
