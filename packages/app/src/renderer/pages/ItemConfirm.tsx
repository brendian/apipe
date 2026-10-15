import { useState } from 'react';
import { Callout } from '../components/Callout.js';
import { Field } from '../components/Field.js';
import { PageHeading } from '../components/PageHeading.js';
import { useApi } from '../state/api.js';
import { useRemote } from '../state/remote.js';
import { Link, useRouter, withQuery } from '../state/router.js';

// Rename and delete (docs/05 §5.5, §5.7). Deleting asks first: this page is the question, and its
// button is the only thing that sends `confirm`.

const back = (path: string) => (
  <p className="crumbs">
    <Link to={withQuery('/items/edit', { path })}>← Back to the item</Link>
  </p>
);

export function ItemRename({ path }: { path: string }) {
  const api = useApi();
  const { navigate } = useRouter();
  const [to, setTo] = useState(path);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    const r = await api.items.rename({ rel: path, new_rel: to });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    navigate(withQuery('/items/edit', { path: r.value.rel, notice: 'renamed' }));
  }
  return (
    <>
      {back(path)}
      <PageHeading>
        Rename <code>{path}</code>
      </PageHeading>
      <p>
        Give it a new name, or move it to another folder. Earlier runs keep their copy of the text,
        but they'll no longer show up as this item's last run.
      </p>
      <form className="item-form" onSubmit={(e) => void submit(e)}>
        {error ? (
          <div className="form-errors" role="alert">
            <p>{error}</p>
          </div>
        ) : null}
        <Field
          label={<>New name</>}
          help={
            <>
              <code>.md</code> is added if you leave it off. Folders are made as needed.
            </>
          }
        >
          {(props) => (
            <input
              {...props}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
              maxLength={300}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Rename
          </button>
          <Link to={withQuery('/items/edit', { path })}>Cancel</Link>
        </div>
      </form>
    </>
  );
}

export function ItemDelete({ path }: { path: string }) {
  const api = useApi();
  const { navigate } = useRouter();
  const { state } = useRemote(() => api.items.deleteInfo({ rel: path }), [api, path]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function remove(): Promise<void> {
    setBusy(true);
    const r = await api.items.delete({ rel: path, confirm: true });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    navigate(withQuery('/items', { notice: 'item_deleted' }));
  }
  if (state.status === 'loading') return <p>Loading…</p>;
  if (state.status === 'error') {
    return (
      <>
        {back(path)}
        <PageHeading>Delete work item</PageHeading>
        <Callout tone="bad">{state.error}</Callout>
      </>
    );
  }
  const info = state.value;
  return (
    <>
      {back(path)}
      <PageHeading>
        Delete <code>{path}</code>?
      </PageHeading>
      {info.git === '' ? (
        <p>
          It's committed in git, so you can get it back later with{' '}
          <code>
            git checkout -- {info.items_dir}/{path}
          </code>
          .
        </p>
      ) : info.git === 'modified' ? (
        <Callout tone="warn">
          It has changes that aren't committed. Those are lost; the last committed version stays in
          git.
        </Callout>
      ) : info.git === 'unknown' ? (
        <Callout tone="warn">
          Couldn't tell whether git has a copy. Assume this can't be undone.
        </Callout>
      ) : (
        <Callout tone="warn">It isn't in git, so this can't be undone.</Callout>
      )}
      <p className="muted">
        Runs that used it aren't affected: each run keeps its own copy of the text.
      </p>
      {error ? <Callout tone="bad">{error}</Callout> : null}
      <div className="form-actions">
        {/* The safe button comes first and has the focus. */}
        <button
          type="button"
          className="btn"
          autoFocus
          onClick={() => navigate(withQuery('/items/edit', { path }))}
        >
          Keep it
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy}
          onClick={() => void remove()}
        >
          Delete it
        </button>
      </div>
    </>
  );
}
