import { useEffect, useRef, useState } from 'react';
import {
  consoleWarning,
  LEVEL_INFO,
  levelNumber,
  type RunForm,
  type RunPlan,
} from '@advpipe/contracts';
import { Callout } from '../components/Callout.js';
import { Field } from '../components/Field.js';
import { LevelSlider } from '../components/LevelSlider.js';
import { PageHeading } from '../components/PageHeading.js';
import { UsageLine } from '../components/UsageLine.js';
import { useApi } from '../state/api.js';
import { useRemote } from '../state/remote.js';
import { Link, useRouter } from '../state/router.js';

// The New run page (docs/05 §5.4). Starting a run spends money, so the page says how much it can
// spend before the Start button does anything, and the host refuses to start if what was shown is
// no longer what it works out (the `shown` check). Every value is worked out by `newrun.plan`; the
// window only shows it and sends back what the person chose.

const PLAN_DELAY_MS = 400;
const POLICY_WORD = {
  ask: 'it asks you',
  ignore: "they're ignored",
  block: 'they block the run until fixed',
} as const;

function Summary({
  plan,
  form,
  usageConsole,
}: {
  plan: RunPlan;
  form: RunForm;
  usageConsole: boolean;
}) {
  const info = LEVEL_INFO[plan.level];
  const [happy, worst] = plan.calls;
  const asks = plan.scan && plan.level !== 'full';
  return (
    <section className="run-summary">
      <h2>Before you start</h2>
      {plan.budget !== null ? (
        <p className="spend">
          This can spend up to <strong>${plan.budget_text}</strong>{' '}
          <span className="muted">
            (the budget in {plan.config_label}; the run stops if it reaches it).
          </span>
        </p>
      ) : null}
      {usageConsole && plan.budget !== null ? (
        <Callout tone="warn">{consoleWarning(plan.budget)}</Callout>
      ) : null}
      <dl className="run-meta">
        <div>
          <dt>Config</dt>
          <dd>{plan.config_label || '—'}</dd>
        </div>
        <div className="wide">
          <dt>Branch</dt>
          <dd>
            {plan.branch ? (
              <code>{plan.branch}</code>
            ) : (
              <span className="muted">(from the work item)</span>
            )}
          </dd>
        </div>
      </dl>
      <div className="level-card">
        <h3>
          {info.label} <span className="muted">({levelNumber(plan.level)} of 5)</span>
        </h3>
        <p>
          {info.description} <span className="muted">Good for: {info.goodFor}.</span>
        </p>
        <p>
          <strong>
            {plan.agents} agent{plan.agents === 1 ? '' : 's'}
          </strong>{' '}
          ·{' '}
          {happy === worst
            ? `${happy} agent call${happy === 1 ? '' : 's'}, then it asks you`
            : `${happy} calls if all goes well, at most ${worst} before it asks you`}
          .
        </p>
        {form.level && plan.level !== plan.inherited_level ? (
          <p className="muted">
            The slider overrides {plan.inherited_level}, from {plan.level_source}.
          </p>
        ) : !form.level ? (
          <p className="muted">
            Level {plan.level}, from {plan.level_source}. Move the slider to change it.
          </p>
        ) : null}
        <p>
          Security scan: <strong>{plan.scan ? 'on' : 'off'}</strong>{' '}
          <span className="muted">({form.scan !== 'default' ? 'set here' : plan.scan_source})</span>
          {asks ? (
            <>
              ; if it finds issues, <strong>{POLICY_WORD[plan.failures]}</strong>
            </>
          ) : null}
          .
        </p>
        {plan.dropped.length > 0 ? (
          <>
            <p className="not-done">Not done at this level:</p>
            <ul className="not-done">
              {plan.dropped.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        ) : null}
        {plan.review ? (
          <p>
            It will <strong>stop for your review</strong> after the spec (you can edit it), the
            tests and the code.
          </p>
        ) : null}
        {plan.bypass ? (
          <Callout tone="warn">
            Blocking questions will be answered by the agent without asking you. It says so in{' '}
            <code>task.md</code> and the report, but it can guess wrong. Rarely the right choice.
          </Callout>
        ) : null}
      </div>
      {plan.errors.length > 0 || plan.warnings.length > 0 ? (
        <ul className="item-checks">
          {plan.errors.map((e) => (
            <li key={e} className="check check-error">
              <strong>Problem:</strong> {e}
            </li>
          ))}
          {plan.warnings.map((w) => (
            <li key={w} className="check check-warning">
              <strong>Warning:</strong> {w}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function NewRun({ item }: { item: string | null }) {
  const api = useApi();
  const { navigate } = useRouter();
  const items = useRemote(() => api.items.list({}), [api]);
  const checks = useRemote(() => api.app.preflight({}), [api]);
  const usage = useRemote(() => api.usage.get({}), [api], { 'usage.changed': () => true });

  const [source, setSource] = useState<'item' | 'task'>('item');
  const [chosen, setChosen] = useState(item ?? '');
  const [task, setTask] = useState('');
  const [name, setName] = useState('');
  const [config, setConfig] = useState('');
  const [keep, setKeep] = useState(false);
  const [scan, setScan] = useState('default');
  // What the person has changed from what the run would get on its own: null = untouched, so the
  // slider, policy and checkbox keep following the chosen item's front matter.
  const [level, setLevel] = useState<number | null>(null);
  const [failures, setFailures] = useState<string | null>(null);
  const [bypass, setBypass] = useState<boolean | null>(null);
  const [review, setReview] = useState(false);

  const [plan, setPlan] = useState<{ key: string; value: RunPlan } | null>(null);
  const [planError, setPlanError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const form: RunForm = {
    source,
    item: chosen,
    task,
    name,
    config,
    level: level === null ? '' : String(level),
    scan,
    scan_failures: failures ?? '',
    bypass,
    review,
    keep_worktree: keep,
  };
  const key = JSON.stringify(form);

  // The summary follows every change, 400 ms after the last (the first one at once).
  const seq = useRef(0);
  const first = useRef(true);
  useEffect(() => {
    const mine = ++seq.current;
    const wait = first.current ? 0 : PLAN_DELAY_MS;
    first.current = false;
    const timer = setTimeout(() => {
      void api.newrun.plan(JSON.parse(key) as RunForm).then((r) => {
        if (mine !== seq.current) return;
        if (r.ok) {
          setPlan({ key, value: r.value });
          setPlanError('');
        } else {
          setPlanError(r.error);
        }
      });
    }, wait);
    return () => clearTimeout(timer);
  }, [api, key, refresh]);

  const list = items.state.status === 'ready' ? items.state.value : null;
  const choices = (list?.groups ?? [])
    .flatMap((g) => g.items)
    .filter((row) => row.problem === null || row.rel === chosen)
    .map((row) => row.rel);
  const noItems = list !== null && choices.length === 0;
  // With no work items to pick from, the one-off task is the only choice.
  const shownSource = noItems && source === 'item' && chosen === '' ? 'task' : source;
  useEffect(() => {
    if (shownSource !== source) setSource(shownSource);
  }, [shownSource, source]);

  const current = plan !== null && plan.key === key ? plan.value : null;
  const shown = plan?.value ?? null;
  const setup = checks.state.status === 'ready' ? checks.state.value : null;
  const setupBad = setup && !setup.git.ok ? setup.git : setup && !setup.repo.ok ? setup.repo : null;
  const canStart = current !== null && current.ok && setupBad === null && !busy;

  async function start(): Promise<void> {
    if (current === null) return;
    setBusy(true);
    setError('');
    const r = await api.newrun.start({
      ...form,
      shown: current.shown_text,
      budget_shown: current.budget_text,
    });
    setBusy(false);
    if (r.ok) return navigate(`/runs/${r.value.runId}?notice=started`);
    setError(r.error);
    setRefresh((n) => n + 1); // look again: the settings may be what changed
  }

  const sliderValue = level ?? levelNumber(shown?.level ?? 'full');
  return (
    <>
      <p className="crumbs">
        <Link to="/runs">← All runs</Link>
      </p>
      <PageHeading>New run</PageHeading>
      <p>
        Pick a work item (or type a one-off task), check the settings, and start. The run goes on in
        the background: closing this page or the window doesn't stop it.
      </p>
      <UsageLine />
      {setupBad ? <Callout tone="bad">{setupBad.text}</Callout> : null}
      <form
        className="item-form"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        {error ? (
          <div className="form-errors" role="alert">
            <p>{error}</p>
          </div>
        ) : null}
        {planError ? <Callout tone="bad">{planError}</Callout> : null}
        <fieldset className="source">
          <legend>What to build</legend>
          <label className="choice">
            <input
              type="radio"
              name="source"
              value="item"
              checked={source === 'item'}
              disabled={noItems}
              onChange={() => setSource('item')}
            />{' '}
            A work item
          </label>
          {noItems ? (
            <p className="muted small">
              There are no work items yet. <Link to="/items/new">Write one</Link>, or type a one-off
              task below.
            </p>
          ) : (
            <Field label={<>Work item</>} hiddenLabel>
              {(props) => (
                <select
                  {...props}
                  value={chosen}
                  onChange={(e) => {
                    setChosen(e.target.value);
                    setSource('item');
                  }}
                >
                  <option value="">Choose a work item…</option>
                  {choices.map((rel) => (
                    <option key={rel} value={rel}>
                      {rel}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <label className="choice">
            <input
              type="radio"
              name="source"
              value="task"
              checked={source === 'task'}
              onChange={() => setSource('task')}
            />{' '}
            A one-off task, typed here
          </label>
          <Field
            label={<>One-off task</>}
            help={<>Used only when “A one-off task” is chosen. It isn't saved as a work item.</>}
            hiddenLabel
          >
            {(props) => (
              <textarea
                {...props}
                rows={6}
                value={task}
                maxLength={250_000}
                spellCheck
                placeholder="What to build or fix, and how you'll know it's done."
                onChange={(e) => {
                  setTask(e.target.value);
                  setSource('task');
                }}
              />
            )}
          </Field>
        </fieldset>
        <div className="field-row">
          <Field
            label={
              <>
                Branch name <span className="muted">(optional)</span>
              </>
            }
            help={
              <>
                The run makes the branch <code>advpipe/&lt;name&gt;</code>. Empty: the work item's
                own, or its first line.
              </>
            }
          >
            {(props) => (
              <input
                {...props}
                value={name}
                maxLength={300}
                autoComplete="off"
                spellCheck={false}
                placeholder={shown?.item_name || 'from the first line'}
                onChange={(e) => setName(e.target.value)}
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
                A <code>.toml</code> file in the repo. Empty: the work item's own, or{' '}
                <code>pipeline.toml</code>, or the defaults.
              </>
            }
          >
            {(props) => (
              <input
                {...props}
                value={config}
                maxLength={300}
                autoComplete="off"
                spellCheck={false}
                placeholder={shown?.item_config || 'pipeline.toml'}
                onChange={(e) => setConfig(e.target.value)}
              />
            )}
          </Field>
        </div>
        <fieldset className="checking">
          <legend>How much checking</legend>
          <LevelSlider value={sliderValue} onChange={setLevel} />
          <div className="choice-row">
            <span className="field-label" id="scan-label">
              Security scan
            </span>
            <span role="radiogroup" aria-labelledby="scan-label">
              {(
                [
                  ['default', 'Default'],
                  ['on', 'On'],
                  ['off', 'Off'],
                ] as const
              ).map(([value, text]) => (
                <label key={value} className="choice">
                  <input
                    type="radio"
                    name="scan"
                    value={value}
                    checked={scan === value}
                    onChange={() => setScan(value)}
                  />{' '}
                  {text}
                </label>
              ))}
            </span>
          </div>
          <div className="choice-row">
            <span className="field-label" id="policy-label">
              If it finds issues
            </span>
            <span role="radiogroup" aria-labelledby="policy-label">
              {(
                [
                  ['ask', 'Ask me'],
                  ['ignore', 'Ignore'],
                  ['block', 'Block'],
                ] as const
              ).map(([value, text]) => (
                <label key={value} className="choice">
                  <input
                    type="radio"
                    name="scan_failures"
                    value={value}
                    checked={(failures ?? shown?.failures ?? 'ask') === value}
                    onChange={() => setFailures(value)}
                  />{' '}
                  {text}
                </label>
              ))}
            </span>
            <small className="muted">
              Only when the scan is on below Full: at Full the security reviewer checks each hit.
            </small>
          </div>
          <label className="choice">
            <input
              type="checkbox"
              checked={bypass ?? shown?.bypass ?? false}
              onChange={(e) => setBypass(e.target.checked)}
            />{' '}
            Don't stop for questions: let the agent decide
          </label>
          <label className="choice">
            <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />{' '}
            Pause for my review after the spec, the tests and the code
            <small className="muted"> (only at levels 3 to 5)</small>
          </label>
        </fieldset>
        <details className="advanced">
          <summary>Advanced</summary>
          <label className="choice">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />{' '}
            Keep the working copy after a successful run
          </label>
        </details>
        <div aria-live="polite">
          {shown ? (
            <Summary
              plan={shown}
              form={form}
              usageConsole={usage.state.status === 'ready' && usage.state.value.console}
            />
          ) : (
            <p className="muted">Working out what this would do…</p>
          )}
        </div>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!canStart}>
            Start{current?.ok && current.budget !== null ? ` (up to $${current.budget_text})` : ''}
          </button>
          <Link to="/runs">Cancel</Link>
          <span className="muted small">
            Agents edit a separate copy of the repo and run its checks. Nothing is merged or pushed.
          </span>
        </div>
      </form>
    </>
  );
}
