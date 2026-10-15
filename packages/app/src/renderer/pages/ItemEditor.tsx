import { useEffect, useRef, useState } from 'react';
import {
  ageOf,
  LEVEL_INFO,
  LEVEL_ORDER,
  type DraftChecks,
  type DraftView,
} from '@advpipe/contracts';
import { Callout } from '../components/Callout.js';
import { Field } from '../components/Field.js';
import { EmptyState } from '../components/EmptyState.js';
import { Markdown } from '../components/Markdown.js';
import { PageHeading } from '../components/PageHeading.js';
import { StatusChip } from '../components/StatusChip.js';
import { useNow } from '../components/useNow.js';
import { useApi } from '../state/api.js';
import { useRemote } from '../state/remote.js';
import { Link, useRouter, withQuery } from '../state/router.js';

// The work-item editor (docs/05 §5.6): front-matter fields, the body with a live preview and the
// engine's own checks, and a save that refuses to overwrite a file that changed on disk.

const NOTICES: Record<string, string> = {
  created: 'Created.',
  saved: 'Saved.',
  unchanged: 'No changes to save.',
  renamed: 'Renamed.',
};
const CHECK_WORD = { error: 'Problem', warning: 'Warning', info: 'Note' } as const;
const CHECK_DELAY_MS = 400;

type Fields = {
  rel: string;
  name: string;
  config: string;
  body: string;
  level: string;
  security_scan: string;
  scan_failures: string;
  bypass_questions: string;
};

function Select({
  label,
  help,
  value,
  onChange,
  options,
}: {
  label: string;
  help?: string;
  value: string;
  onChange: (value: string) => void;
  options: [value: string, text: string][];
}) {
  return (
    <Field label={label} help={help}>
      {(props) => (
        <select {...props} value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map(([v, text]) => (
            <option key={v} value={v}>
              {text}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** The inline checks and the rendered body, re-fetched as the person types. */
function Preview({ checks }: { checks: DraftChecks | null }) {
  return (
    <div id="item-preview" aria-live="polite">
      {checks ? (
        <ul className="item-checks">
          {checks.checks.map((c, i) => (
            <li key={i} className={`check check-${c.level}`}>
              <strong>{CHECK_WORD[c.level]}:</strong> {c.text}
            </li>
          ))}
          {checks.branch ? (
            <li className="check check-info">
              <strong>Branch:</strong> a run would make <code>{checks.branch}</code>.
            </li>
          ) : null}
        </ul>
      ) : null}
      {checks?.preview_html ? (
        <Markdown html={checks.preview_html} className="preview" />
      ) : (
        <p className="muted">Nothing to preview yet.</p>
      )}
    </div>
  );
}

function ItemForm({
  mode,
  initial,
  base,
  onSaved,
}: {
  mode: 'new' | 'edit';
  initial: Fields;
  base: string;
  onSaved: (notice: string) => void;
}) {
  const api = useApi();
  const { navigate } = useRouter();
  const [f, setF] = useState<Fields>(initial);
  const [checks, setChecks] = useState<DraftChecks | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key: keyof Fields) => (value: string) => setF((cur) => ({ ...cur, [key]: value }));
  const field = (key: keyof Fields) => (e: { target: { value: string } }) =>
    set(key)(e.target.value);

  // Checks and preview follow every edit, 400 ms after the last one (a late answer is dropped).
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      void api.items.check({ ...f, base }).then((r) => {
        if (mine === seq.current && r.ok) setChecks(r.value);
      });
    }, CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [api, f, base]);

  async function submit(then: 'stay' | 'run'): Promise<void> {
    setBusy(true);
    setError('');
    const input = { ...f, base };
    if (mode === 'new') {
      const r = await api.items.create(input);
      setBusy(false);
      if (!r.ok) return setError(r.error);
      navigate(
        then === 'run'
          ? withQuery('/runs/new', { item: r.value.rel })
          : withQuery('/items/edit', { path: r.value.rel, notice: 'created' }),
      );
      return;
    }
    const r = await api.items.save(input);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    if (then === 'run') return navigate(withQuery('/runs/new', { item: f.rel }));
    onSaved(r.value.changed ? 'saved' : 'unchanged');
  }

  const blocked = checks?.ok === false;
  const verb = mode === 'new' ? 'Create' : 'Save';
  return (
    <form
      className="item-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit('stay');
      }}
    >
      {error ? (
        <div className="form-errors" role="alert">
          <p>{error}</p>
        </div>
      ) : null}
      {mode === 'new' ? (
        <Field
          label={<>File name</>}
          help={
            <>
              Inside the work-items folder. Folders are made as needed, and <code>.md</code> is
              added if you leave it off.
            </>
          }
        >
          {(props) => (
            <input
              {...props}
              value={f.rel}
              onChange={field('rel')}
              required
              maxLength={300}
              placeholder="server/s03-stock.md"
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
      ) : null}
      <div className="field-row">
        <Field
          label={
            <>
              Branch name <span className="muted">(optional)</span>
            </>
          }
          help={
            <>
              Runs make the branch <code>advpipe/&lt;name&gt;</code>. Empty: made from the first
              line.
            </>
          }
        >
          {(props) => (
            <input
              {...props}
              value={f.name}
              onChange={field('name')}
              maxLength={300}
              autoComplete="off"
              placeholder="s03-stock"
            />
          )}
        </Field>
        <Field
          label={
            <>
              Pipeline config <span className="muted">(optional)</span>
            </>
          }
          help={
            <>
              A <code>.toml</code> file, relative to the repo root. Empty:{' '}
              <code>pipeline.toml</code> or the defaults.
            </>
          }
        >
          {(props) => (
            <input
              {...props}
              value={f.config}
              onChange={field('config')}
              maxLength={300}
              autoComplete="off"
              spellCheck={false}
              placeholder="pipeline.toml"
            />
          )}
        </Field>
      </div>
      <fieldset className="checking">
        <legend>
          How runs of this item go{' '}
          <span className="muted">(optional: left empty, they follow the config)</span>
        </legend>
        <div className="field-row wide">
          <Select
            label="Level"
            help="How much checking: 1 (Basic) to 5 (Full). The New run page's slider can still override it."
            value={f.level}
            onChange={set('level')}
            options={[
              ['', 'Inherit (from the config)'],
              ...LEVEL_ORDER.map((l, i): [string, string] => [
                l,
                `${i + 1}. ${LEVEL_INFO[l].label}`,
              ]),
            ]}
          />
          <Select
            label="Security scan"
            value={f.security_scan}
            onChange={set('security_scan')}
            options={[
              ['', 'Level default (on at Full only)'],
              ['yes', 'On'],
              ['no', 'Off'],
            ]}
          />
          <Select
            label="If the scan finds issues"
            help="Only when the scan is on below Full."
            value={f.scan_failures}
            onChange={set('scan_failures')}
            options={[
              ['', 'Inherit (ask me, unless the config says otherwise)'],
              ['ask', 'Ask me'],
              ['ignore', 'Ignore'],
              ['block', 'Block'],
            ]}
          />
          <Select
            label="Don't stop for questions"
            value={f.bypass_questions}
            onChange={set('bypass_questions')}
            options={[
              ['', 'Inherit (ask me, unless the config says otherwise)'],
              ['yes', 'Yes: let the agent decide'],
              ['no', 'No: ask me'],
            ]}
          />
        </div>
      </fieldset>
      <div className="editor">
        <Field
          label={
            <>
              Work item <span className="muted">(markdown)</span>
            </>
          }
        >
          {(props) => (
            <textarea
              {...props}
              className="mono"
              rows={22}
              value={f.body}
              onChange={field('body')}
              spellCheck
              placeholder="What to build or fix, and how you'll know it's done."
            />
          )}
        </Field>
        <div className="preview-pane">
          <div className="field-label">Preview and checks</div>
          <Preview checks={checks} />
        </div>
      </div>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || blocked}>
          {verb}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || blocked}
          title="Save, then check the budget and start a run"
          onClick={() => void submit('run')}
        >
          {verb} &amp; run…
        </button>
        <Link to="/items">Cancel</Link>
        <span className="muted small">
          {blocked
            ? 'Fix the problems marked above to save.'
            : 'Saving writes the file only. Nothing is committed.'}
        </span>
      </div>
    </form>
  );
}

const fieldsOf = (d: DraftView): Fields => ({
  rel: d.rel,
  name: d.name,
  config: d.config,
  body: d.body,
  level: d.level,
  security_scan: d.security_scan,
  scan_failures: d.scan_failures,
  bypass_questions: d.bypass_questions,
});

export function ItemNew({ folder }: { folder: string }) {
  const rel = folder.replace(/^\/+|\/+$/g, '');
  const blank: Fields = {
    rel: rel ? `${rel}/` : '',
    name: '',
    config: '',
    body: '',
    level: '',
    security_scan: '',
    scan_failures: '',
    bypass_questions: '',
  };
  return (
    <>
      <p className="crumbs">
        <Link to="/items">← All work items</Link>
      </p>
      <PageHeading>New work item</PageHeading>
      <ItemForm mode="new" initial={blank} base="" onSaved={() => undefined} />
    </>
  );
}

export function ItemEdit({ path, notice }: { path: string; notice: string | null }) {
  const api = useApi();
  const now = useNow();
  const { state, reload } = useRemote(() => api.items.read({ rel: path }), [api, path]);
  const [saved, setSaved] = useState('');
  const shown = saved || (notice ? (NOTICES[notice] ?? '') : '');
  const back = (
    <p className="crumbs">
      <Link to="/items">← All work items</Link>
    </p>
  );
  if (state.status === 'loading') return <p>Loading…</p>;
  if (state.status === 'error' && state.value === undefined) {
    return (
      <>
        {back}
        <PageHeading>Work item</PageHeading>
        <Callout tone="bad">{state.error}</Callout>
        <EmptyState
          actions={
            <Link to="/items" className="btn">
              All work items
            </Link>
          }
        >
          This work item can't be opened here.
        </EmptyState>
      </>
    );
  }
  const draft = state.value;
  if (draft === undefined) return null;
  return (
    <>
      {back}
      <div className="page-head">
        <PageHeading>
          <code>{draft.rel}</code>
        </PageHeading>
        <span className="actions">
          <Link to={withQuery('/items/rename', { path: draft.rel })}>Rename</Link>
          <Link to={withQuery('/items/delete', { path: draft.rel })} className="danger-link">
            Delete
          </Link>
        </span>
      </div>
      {shown ? (
        <p className="notice" role="status">
          {shown}
        </p>
      ) : null}
      {draft.last_run ? (
        <p>
          Last run:{' '}
          <Link to={`/runs/${draft.last_run.run_id}`} className="plain">
            <StatusChip status={draft.last_run.status} />
          </Link>{' '}
          <span className="muted">
            {ageOf(draft.last_run.started_at, now)} · {draft.last_run.run_id}
          </span>
        </p>
      ) : (
        <p className="muted">Not run yet.</p>
      )}
      {draft.problem ? (
        <Callout tone="warn">
          As it is on disk, this file can't be run: {draft.problem}. Below is what could be read
          from it. Saving writes it back in the right form, without any front-matter lines that
          couldn't be read.
        </Callout>
      ) : null}
      <ItemForm
        key={draft.base}
        mode="edit"
        initial={fieldsOf(draft)}
        base={draft.base}
        onSaved={(n) => {
          setSaved(NOTICES[n] ?? '');
          reload();
        }}
      />
      {draft.problem ? null : (
        <section className="next-steps">
          <h2>Run it</h2>
          <p>
            <Link to={withQuery('/runs/new', { item: draft.rel })} className="btn">
              Run…
            </Link>{' '}
            <span className="muted">Shows what it can spend before it starts.</span>
          </p>
        </section>
      )}
    </>
  );
}
