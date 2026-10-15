import { useState } from 'react';
import { ageOf, GIT_STATES, type ItemRow } from '@advpipe/contracts';
import { Callout } from '../components/Callout.js';
import { Field } from '../components/Field.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeading } from '../components/PageHeading.js';
import { StatusChip } from '../components/StatusChip.js';
import { useNow } from '../components/useNow.js';
import { useApi } from '../state/api.js';
import { useRemote } from '../state/remote.js';
import { Link, useRouter, withQuery } from '../state/router.js';

// Notice keys map to fixed texts: nothing from the route is ever shown (docs/05 §8).
const NOTICES: Record<string, string> = { item_deleted: 'Work item deleted.' };

/** Where work items live, and a way to change it for this repo (it must stay inside the repo). */
function FolderSetting({ current, onSaved }: { current: string; onSaved: () => void }) {
  const api = useApi();
  const [value, setValue] = useState(current);
  const [error, setError] = useState('');
  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const r = await api.app.prefs.set({ items_dir: value });
    if (r.ok) {
      setError('');
      onSaved();
    } else {
      setError(r.error);
    }
  }
  return (
    <details className="folder-setting">
      <summary>Folder: change…</summary>
      <form onSubmit={(e) => void save(e)} className="inline-form">
        <Field
          label={<>Work-items folder</>}
          help={<>A folder inside this repo, like work-items or tasks/open.</>}
        >
          {(props) => (
            <input
              {...props}
              value={value}
              maxLength={300}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </Field>
        <button type="submit" className="btn">
          Use this folder
        </button>
      </form>
      {error ? <Callout tone="bad">{error}</Callout> : null}
    </details>
  );
}

function ItemTableRow({ row, now }: { row: ItemRow; now: Date }) {
  const edit = withQuery('/items/edit', { path: row.rel });
  const filename = row.rel.slice(row.rel.lastIndexOf('/') + 1);
  const git = row.git === '' ? null : GIT_STATES[row.git];
  return (
    <tr>
      <td>
        <div className="title">
          <Link to={edit}>{row.title}</Link>
        </div>
        <div className="sub">
          <code>{filename}</code>
          {row.name ? (
            <>
              {' '}
              · branch name <code>{row.name}</code>
            </>
          ) : null}
          {row.config ? (
            <>
              {' '}
              · config <code>{row.config}</code>
            </>
          ) : null}
        </div>
        {row.problem ? (
          <div className="warning small">Can't be run as it is: {row.problem}</div>
        ) : null}
      </td>
      <td>
        {row.last_run ? (
          <>
            <Link to={`/runs/${row.last_run.run_id}`} className="plain">
              <StatusChip status={row.last_run.status} />
            </Link>
            <div className="sub muted">{ageOf(row.last_run.started_at, now)}</div>
          </>
        ) : (
          <span className="muted">never run</span>
        )}
      </td>
      <td>
        {git ? (
          <span className="chip chip-neutral" title={git.help}>
            {git.label}
          </span>
        ) : null}
      </td>
      <td>
        <div className="row-actions">
          {row.problem ? null : (
            <Link to={withQuery('/runs/new', { item: row.rel })}>
              Run<span className="visually-hidden"> {row.rel}</span>
            </Link>
          )}
          <Link to={edit}>
            Edit<span className="visually-hidden"> {row.rel}</span>
          </Link>
          <Link to={withQuery('/items/rename', { path: row.rel })}>
            Rename<span className="visually-hidden"> {row.rel}</span>
          </Link>
          <Link to={withQuery('/items/delete', { path: row.rel })} className="danger-link">
            Delete<span className="visually-hidden"> {row.rel}</span>
          </Link>
        </div>
      </td>
    </tr>
  );
}

/** The work items in the repo's items folder, grouped by sub-folder (docs/05 §5.5). */
export function Items() {
  const api = useApi();
  const { navigate, route } = useRouter();
  const now = useNow();
  const { state, reload } = useRemote(() => api.items.list({}), [api]);
  const notice = route.name === 'items' && route.notice ? NOTICES[route.notice] : undefined;
  const list = state.status === 'ready' ? state.value : null;
  const count = list ? list.groups.reduce((n, g) => n + g.items.length, 0) : 0;

  return (
    <>
      <div className="page-head">
        <PageHeading>Work items</PageHeading>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => navigate('/items/new')}>
            New work item
          </button>
        </div>
      </div>
      {list ? (
        <p>
          The task files in <code>{list.items_dir}/</code> that you start runs from. Saving here
          writes the file; committing it to git is up to you.
        </p>
      ) : null}
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      {state.status === 'error' ? <Callout tone="bad">{state.error}</Callout> : null}
      {list ? (
        <FolderSetting key={list.items_dir} current={list.items_dir} onSaved={reload} />
      ) : null}
      {state.status === 'loading' ? <p>Loading work items…</p> : null}
      {list && !list.folder_exists ? (
        <EmptyState
          actions={
            <Link to="/items/new" className="btn btn-primary">
              Write your first work item
            </Link>
          }
        >
          There's no <code>{list.items_dir}/</code> folder in this repo yet. Writing a work item
          makes it.
        </EmptyState>
      ) : null}
      {list && list.folder_exists && count === 0 ? (
        <EmptyState
          actions={
            <Link to="/items/new" className="btn btn-primary">
              Create your first
            </Link>
          }
        >
          No work items yet. A work item is a markdown file describing one task.
        </EmptyState>
      ) : null}
      {list && count > 0 ? (
        <>
          {!list.git_known ? (
            <p className="muted">
              Git status isn't shown: <code>{list.items_dir}/</code> isn't inside a git repository.
            </p>
          ) : null}
          {list.groups.map((g) => (
            <section key={g.folder} className="item-group">
              <h2>
                {g.folder ? <code>{g.folder}/</code> : 'Top level'}{' '}
                <Link
                  to={g.folder ? withQuery('/items/new', { folder: g.folder }) : '/items/new'}
                  className="small"
                >
                  + new here
                </Link>
              </h2>
              <div className="table-wrap">
                <table className="items-table">
                  <thead>
                    <tr>
                      <th scope="col">Work item</th>
                      <th scope="col">Last run</th>
                      <th scope="col">Git</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map((row) => (
                      <ItemTableRow key={row.rel} row={row} now={now} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </>
      ) : null}
      {list && list.skipped.length > 0 ? (
        <Callout tone="warn">
          Not shown, because their paths can't be managed here (odd characters, or a symlink that
          leads out of the folder): {list.skipped.join(', ')}.
        </Callout>
      ) : null}
    </>
  );
}
