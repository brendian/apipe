import { useState } from 'react';
import { Callout } from '../components/Callout.js';
import { PageHeading } from '../components/PageHeading.js';
import { useApi } from '../state/api.js';
import { useRemote } from '../state/remote.js';
import { Link } from '../state/router.js';
import { useWindow } from '../state/window.js';

const ICON = { ok: '✔', warn: '⚠', bad: '✖' } as const;
const WORD = { ok: 'Passed', warn: 'Note', bad: 'Problem' } as const;

/** The first screen of a window with no repo, and the setup checks (docs/05 §5.0). */
export function Welcome() {
  const api = useApi();
  const { repo } = useWindow();
  const [error, setError] = useState('');
  const prefs = useRemote(() => api.app.prefs.get({}), [api]);
  const checks = useRemote(
    () => (repo ? api.app.preflight({}) : Promise.resolve({ ok: true as const, value: null })),
    [api, repo?.path],
  );

  async function run(action: () => ReturnType<typeof api.app.repo.pick>): Promise<void> {
    setError('');
    const r = await action();
    if (!r.ok) setError(r.error);
  }

  const recent = prefs.state.status === 'ready' ? prefs.state.value.recent : [];
  const pf = checks.state.status === 'ready' ? checks.state.value : null;
  const ready = pf !== null && pf.git.ok && pf.repo.ok;

  return (
    <>
      <PageHeading>advpipe</PageHeading>
      <p>Drive a task through AI agents that check each other, and get a branch to review.</p>
      {error ? <Callout tone="bad">{error}</Callout> : null}
      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void run(() => api.app.repo.pick({}))}
        >
          Open a repo…
        </button>
        {ready ? (
          <Link to="/runs" className="btn">
            Go to runs
          </Link>
        ) : null}
      </div>

      {recent.length > 0 ? (
        <>
          <h2>Recent</h2>
          <ul className="recent">
            {recent.map((r) => (
              <li key={r.path} className={r.exists ? '' : 'missing'}>
                <button
                  type="button"
                  className="btn-link"
                  disabled={!r.exists}
                  onClick={() => void run(() => api.app.repo.openRecent({ index: r.index }))}
                >
                  {r.name}
                </button>
                <span className="mono">{r.path}</span>
                {r.exists ? null : <span>(not found)</span>}
                <button
                  type="button"
                  className="btn-link"
                  aria-label={`Remove ${r.name} from the recent list`}
                  onClick={() => {
                    void api.app.repo.forgetRecent({ index: r.index }).then(() => prefs.reload());
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {repo ? (
        <>
          <h2>Checking your setup</h2>
          {checks.state.status === 'error' ? (
            <Callout tone="bad">{checks.state.error}</Callout>
          ) : null}
          {pf ? (
            <ul className="checks">
              {[pf.git, pf.repo, pf.claude, pf.items_dir].map((c) => (
                <li key={c.text}>
                  <span aria-hidden="true">{ICON[c.level]}</span>
                  <span className="visually-hidden">{WORD[c.level]}: </span>
                  <span>{c.text}</span>
                </li>
              ))}
            </ul>
          ) : checks.state.status === 'loading' ? (
            <p>Checking…</p>
          ) : null}
        </>
      ) : null}
    </>
  );
}
