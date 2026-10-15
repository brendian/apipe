import { useState } from 'react';
import { allowed, decisionNotice, type CleanInfoView } from '@advpipe/contracts';
import { Callout } from '../components/Callout.js';
import { PageHeading } from '../components/PageHeading.js';
import { useApi } from '../state/api.js';
import { useRemote } from '../state/remote.js';
import { Link, useRouter } from '../state/router.js';

// The pages that ask first (docs/05 §5.7): taking over, stopping, finishing, and cleaning up. Each
// says exactly what will happen, the safe button comes first and has the focus, and only this
// page's own button sends `confirm: true` (the host refuses these actions without it).

const crumb = (runId: string) => (
  <p className="crumbs">
    <Link to={`/runs/${runId}`}>← Back to the run</Link>
  </p>
);

const code = (text: string) => <code>{text}</code>;

export function DecideConfirm({ runId, choice }: { runId: string; choice: string }) {
  const api = useApi();
  const { replace } = useRouter();
  const { state } = useRemote(() => api.run.cleanInfo({ runId }), [api, runId]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!['takeover', 'stop', 'finish'].includes(choice)) {
    return (
      <>
        {crumb(runId)}
        <PageHeading>Nothing to confirm</PageHeading>
        <Callout tone="bad">
          That isn't a choice that needs confirming. Open the run's page to see where it is.
        </Callout>
      </>
    );
  }
  if (state.status === 'loading') return <p>Loading…</p>;
  if (state.status === 'error') {
    return (
      <>
        {crumb(runId)}
        <PageHeading>Nothing to confirm</PageHeading>
        <Callout tone="bad">{state.error}</Callout>
      </>
    );
  }
  const info = state.value;
  const waiting = choice === 'finish' ? 'paused' : 'waiting';
  async function confirm(): Promise<void> {
    setBusy(true);
    const r = await api.run.decide({ runId, choice, confirm: true });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    replace(`/runs/${runId}?notice=${decisionNotice(choice)}`);
  }
  return (
    <>
      {crumb(runId)}
      <PageHeading>
        {choice === 'takeover'
          ? 'Take over this run?'
          : choice === 'finish'
            ? 'Finish this run as it is?'
            : 'Stop this run here?'}
      </PageHeading>
      {choice === 'takeover' ? (
        <>
          <p>You'll finish this by hand. Taking over ends the run:</p>
          <ul>
            <li>
              the work as it is now, checks failing or not, is committed to its branch
              {info.branch ? <> {code(info.branch)}</> : null} (nothing is committed if there's
              nothing new);
            </li>
            {info.worktree ? (
              <li>
                its working copy {code(info.worktree)} is removed, so you can check the branch out;
              </li>
            ) : null}
            <li>the run can't be resumed or decided again. The branch stays.</li>
          </ul>
        </>
      ) : choice === 'finish' ? (
        <>
          <p>A usage limit stopped this run part-way through. Finishing ends it here:</p>
          <ul>
            <li>
              nothing is committed: the work so far stays in its working copy
              {info.worktree ? <> {code(info.worktree)}</> : null}, uncommitted, for you to look at
              and do with as you please;
            </li>
            <li>
              the branch{info.branch ? <> {code(info.branch)}</> : null} keeps the commits of the
              steps that finished;
            </li>
            <li>
              the run can't be resumed or decided again. Cleaning it up later refuses to delete the
              uncommitted work unless you say so.
            </li>
          </ul>
        </>
      ) : (
        <p>
          Stopping ends the run: nothing is written to the branch, and it can't be resumed. Its log
          and the last <code>task.md</code> stay in {code(`.advpipe/runs/${runId}/`)}.
        </p>
      )}
      {error ? <Callout tone="bad">{error}</Callout> : null}
      <div className="form-actions">
        <button type="button" className="btn" autoFocus onClick={() => replace(`/runs/${runId}`)}>
          Keep it {waiting}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy}
          onClick={() => void confirm()}
        >
          {choice === 'takeover'
            ? 'Take over'
            : choice === 'finish'
              ? 'Finish as is'
              : 'Stop the run'}
        </button>
      </div>
    </>
  );
}

/** What cleaning one run up throws away, as list items; used by the page and the bulk panel. */
export function CleanWhat({ info }: { info: CleanInfoView }) {
  return (
    <ul>
      {info.worktree ? (
        <li>
          its working copy {code(info.worktree)}
          {info.dirty_finished ? (
            <>
              , with <strong>uncommitted work</strong> that you finished the run with: nothing else
              has a copy of it
            </>
          ) : null}
        </li>
      ) : null}
      {info.branch ? (
        <li>
          its branch {code(info.branch)}
          {info.unmerged_commits > 0 ? (
            <>
              , with{' '}
              <strong>
                {info.unmerged_commits} commit{info.unmerged_commits === 1 ? '' : 's'}
              </strong>{' '}
              that no other branch has
            </>
          ) : null}
        </li>
      ) : null}
      {!info.worktree && !info.branch ? (
        <li className="muted">
          nothing: its working copy and branch are already gone. You can still delete its log.
        </li>
      ) : null}
    </ul>
  );
}

export function CleanConfirm({ runId }: { runId: string }) {
  const api = useApi();
  const { navigate, replace } = useRouter();
  const { state } = useRemote(() => api.run.cleanInfo({ runId }), [api, runId]);
  const [force, setForce] = useState(false);
  const [logs, setLogs] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (state.status === 'loading') return <p>Loading…</p>;
  if (state.status === 'error') {
    return (
      <>
        {crumb(runId)}
        <PageHeading>Can't clean up this run</PageHeading>
        <Callout tone="bad">{state.error}</Callout>
      </>
    );
  }
  const info = state.value;
  const needsForce = info.dirty_finished || info.unmerged_commits > 0;
  async function clean(): Promise<void> {
    setBusy(true);
    const r = await api.run.clean({ runId, force, logs, confirm: true });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    if (logs) navigate('/runs');
    else replace(`/runs/${runId}?notice=cleaned`);
  }
  return (
    <>
      {crumb(runId)}
      <PageHeading>Clean up this run?</PageHeading>
      <p className="muted">{info.title}</p>
      {info.refusal !== null ? (
        <Callout tone="bad">{info.refusal}</Callout>
      ) : (
        <>
          <p>This throws away what the run made, so it no longer clutters your repo:</p>
          <CleanWhat info={info} />
          <form
            className="item-form"
            onSubmit={(e) => {
              e.preventDefault();
              void clean();
            }}
          >
            {needsForce ? (
              <label className="choice">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                />
                Delete anyway.{' '}
                {info.dirty_finished
                  ? "Its uncommitted work (and any commits only this branch has) can't be got back afterwards; look at the work first in its working copy."
                  : `Its commits can't be got back afterwards${info.base ? `; look at them first with git log --oneline ${info.base}..${info.branch ?? ''}` : ''}.`}
              </label>
            ) : null}
            <label className="choice">
              <input type="checkbox" checked={logs} onChange={(e) => setLogs(e.target.checked)} />
              Also delete the run's log ({code(`.advpipe/runs/${runId}/`)}), so it leaves the runs
              list.
            </label>
            {error ? <Callout tone="bad">{error}</Callout> : null}
            <div className="form-actions">
              <button
                type="button"
                className="btn"
                autoFocus
                onClick={() => replace(`/runs/${runId}`)}
              >
                Keep it
              </button>
              <button type="submit" className="btn btn-danger" disabled={busy}>
                Clean it up
              </button>
            </div>
          </form>
        </>
      )}
    </>
  );
}

/** Clean up…: pick several runs from the list; each gets the same checks as its own page. */
export function CleanAll() {
  const api = useApi();
  const { navigate } = useRouter();
  const { state } = useRemote(() => api.runs.list({ show: 'all' }), [api], {
    'runs.changed': () => true,
  });
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [infos, setInfos] = useState<CleanInfoView[] | null>(null);
  const [force, setForce] = useState(false);
  const [logs, setLogs] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const rows =
    state.status === 'ready' ? state.value.rows.filter((r) => allowed(r.status, 'clean')) : [];
  const toggle = (id: string): void =>
    setPicked((p) => {
      const next = new Set(p);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  async function review(): Promise<void> {
    setBusy(true);
    const found = await Promise.all([...picked].map((runId) => api.run.cleanInfo({ runId })));
    setBusy(false);
    setInfos(found.flatMap((r) => (r.ok ? [r.value] : [])));
    setProblems(found.flatMap((r) => (r.ok ? [] : [r.error])));
  }
  async function clean(): Promise<void> {
    if (infos === null) return;
    setBusy(true);
    const failed: string[] = [];
    for (const info of infos) {
      if (info.refusal !== null) continue;
      const r = await api.run.clean({ runId: info.run_id, force, logs, confirm: true });
      if (!r.ok) failed.push(`${info.title}: ${r.error}`);
    }
    setBusy(false);
    if (failed.length === 0) return navigate('/runs');
    setProblems(failed);
    setInfos(null);
    setPicked(new Set());
  }

  return (
    <>
      <p className="crumbs">
        <Link to="/runs">← All runs</Link>
      </p>
      <PageHeading>Clean up runs</PageHeading>
      {state.status === 'error' ? <Callout tone="bad">{state.error}</Callout> : null}
      {problems.map((p) => (
        <Callout tone="bad" key={p}>
          {p}
        </Callout>
      ))}
      {infos === null ? (
        rows.length === 0 ? (
          <p className="muted">
            Nothing to clean up: only runs that stopped without finishing can be cleaned up.
          </p>
        ) : (
          <form
            className="item-form"
            onSubmit={(e) => {
              e.preventDefault();
              void review();
            }}
          >
            <fieldset>
              <legend>Runs that can be cleaned up</legend>
              {rows.map((r) => (
                <label className="choice" key={r.run_id}>
                  <input
                    type="checkbox"
                    checked={picked.has(r.run_id)}
                    onChange={() => toggle(r.run_id)}
                  />
                  {r.title}{' '}
                  <span className="muted">
                    ({r.status.replaceAll('_', ' ')}, {r.branch || 'no branch'})
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="form-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={picked.size === 0 || busy}
              >
                Review {picked.size} selected…
              </button>
            </div>
          </form>
        )
      ) : (
        <>
          <p>This throws away what these runs made:</p>
          {infos.map((i) => (
            <section key={i.run_id}>
              <h2>{i.title}</h2>
              {i.refusal !== null ? (
                <Callout tone="warn">{i.refusal}</Callout>
              ) : (
                <CleanWhat info={i} />
              )}
            </section>
          ))}
          {infos.some((i) => i.dirty_finished || i.unmerged_commits > 0) ? (
            <label className="choice">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              Delete anyway, including uncommitted work and commits only these branches have. They
              can't be got back afterwards.
            </label>
          ) : null}
          <label className="choice">
            <input type="checkbox" checked={logs} onChange={(e) => setLogs(e.target.checked)} />
            Also delete their logs, so they leave the runs list.
          </label>
          <div className="form-actions">
            <button type="button" className="btn" autoFocus onClick={() => setInfos(null)}>
              Back
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => void clean()}
            >
              Clean them up
            </button>
          </div>
        </>
      )}
    </>
  );
}
