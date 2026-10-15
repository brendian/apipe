import type { ContextView } from '@advpipe/contracts';
import { Callout } from '../components/Callout.js';
import { EmptyState } from '../components/EmptyState.js';
import { Markdown } from '../components/Markdown.js';
import { PageHeading } from '../components/PageHeading.js';
import { RunTabs } from '../components/RunTabs.js';
import { StatusChip } from '../components/StatusChip.js';
import { DISPLAY_STATUSES, type DisplayStatus } from '@advpipe/contracts';
import { useApi } from '../state/api.js';
import { useRemote } from '../state/remote.js';
import { Link } from '../state/router.js';
import { dollars } from '../components/format.js';

const isStatus = (s: string): s is DisplayStatus =>
  (DISPLAY_STATUSES as readonly string[]).includes(s);

function Block({
  id,
  title,
  seen,
  children,
}: {
  id: string;
  title: string;
  seen: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="ctx-block" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      <p className="muted">
        <strong>Seen by:</strong> {seen}
      </p>
      {children}
    </section>
  );
}

/** "Everything the agents worked from", and who sees each part (docs/05 §5.3). */
export function ContextPage({ runId }: { runId: string }) {
  const api = useApi();
  const { state } = useRemote(() => api.runs.context({ runId }), [api, runId], {
    'run.changed': (p) => p.runId === runId,
  });
  const back = <Link to={`/runs/${runId}`}>← Back to the run</Link>;
  if (state.status === 'loading') return <p>Loading…</p>;
  if (state.status === 'error' && state.value === undefined) {
    return (
      <>
        <p>{back}</p>
        <PageHeading>Spec &amp; context</PageHeading>
        <Callout tone="bad">{state.error}</Callout>
      </>
    );
  }
  const c = state.value ?? null;
  if (c === null) {
    return (
      <>
        <p>{back}</p>
        <PageHeading>No such run</PageHeading>
        <EmptyState>There is no run with this id in this repo.</EmptyState>
      </>
    );
  }
  return <Context runId={runId} c={c} back={back} />;
}

function Context({ runId, c, back }: { runId: string; c: ContextView; back: React.ReactNode }) {
  const cfg = c.config.config;
  return (
    <>
      <p>{back}</p>
      <PageHeading>{c.title}</PageHeading>
      <RunTabs runId={runId} current="context" />
      <p>{isStatus(c.status) ? <StatusChip status={c.status} /> : c.status}</p>

      <Block id="ctx-work-item" title="Work item" seen={c.seen_by.work_item}>
        {c.work_item.file ? <p className="mono">{c.work_item.file}</p> : null}
        {c.work_item.html !== null ? (
          <Markdown html={c.work_item.html} />
        ) : (
          <p className="muted">This run's work item is empty.</p>
        )}
      </Block>

      <Block id="ctx-task" title="task.md" seen={c.seen_by.task_md}>
        {c.task === null ? (
          <p className="muted">
            {c.live
              ? 'task.md is not written yet: the spec step is still working.'
              : 'This run has no task.md yet.'}
          </p>
        ) : (
          <>
            <p>
              <span className="chip chip-neutral">{c.task.criteria} acceptance criteria</span>{' '}
              <span className="chip chip-neutral">
                {c.task.questions} open question{c.task.questions === 1 ? '' : 's'}
              </span>
              {c.task.blocking > 0 ? (
                <>
                  {' '}
                  <span className="chip chip-warn">{c.task.blocking} blocking</span>
                </>
              ) : null}
            </p>
            {c.task.blocking > 0 ? (
              <p className="muted">
                A blocking question stops the pipeline after the spec until you answer it.
              </p>
            ) : null}
            {!c.task.sections.includes('ac') ? (
              <Callout tone="warn">
                task.md has no “Acceptance criteria” section: critics have nothing to cite.
              </Callout>
            ) : null}
            <Markdown html={c.task.html} className="task-md" />
          </>
        )}
        {c.answers.length > 0 ? (
          <>
            <h3>Answers given</h3>
            <ul>
              {c.answers.map((q) => (
                <li key={q.id}>
                  <strong>{q.id}</strong> {q.text} — {q.answer}{' '}
                  {q.source === 'agent' ? (
                    <span className="chip chip-info">agent's best judgement</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Block>

      <Block id="ctx-config" title="Config" seen={c.seen_by.config}>
        {cfg ? (
          <dl className="facts">
            <div>
              <dt>Budget</dt>
              <dd>{dollars(cfg.limits.budget_usd_per_task)}</dd>
            </div>
            <div>
              <dt>Models</dt>
              <dd>
                author {cfg.models.author} · critic {cfg.models.critic} · arbiter{' '}
                {cfg.models.arbiter}
              </dd>
            </div>
            <div>
              <dt>Round caps</dt>
              <dd>
                spec ≤ {cfg.limits.max_rounds_spec}, tests ≤ {cfg.limits.max_rounds_tests}, code ≤{' '}
                {cfg.limits.max_rounds_code}
              </dd>
            </div>
            <div>
              <dt>Turn limit</dt>
              <dd>{cfg.limits.max_turns_per_agent} per agent</dd>
            </div>
          </dl>
        ) : c.config.raw === null ? (
          <p className="muted">This run has no config.json.</p>
        ) : (
          <Callout tone="warn">Couldn't read this run's config: {c.config.error}</Callout>
        )}
        {c.config.raw !== null ? (
          <details>
            <summary>config.json as written</summary>
            <pre className="scroll-box" tabIndex={0} aria-label="config.json">
              {c.config.raw}
            </pre>
          </details>
        ) : null}
      </Block>

      <Block id="ctx-checks" title="Checks" seen={c.seen_by.checks}>
        {c.checks.length === 0 ? (
          <p className="muted">The checks are not known without a readable config.</p>
        ) : (
          <table>
            <tbody>
              {c.checks.map((k) => (
                <tr key={k.name}>
                  <th scope="row">{k.name}</th>
                  <td>
                    {k.command ? (
                      <code className="mono">{k.command}</code>
                    ) : (
                      <span className="muted">skipped (not configured)</span>
                    )}
                  </td>
                  <td className="muted">{k.help}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Block>

      <Block id="ctx-standards" title="Standards doc" seen={c.seen_by.standards}>
        <p>
          <code className="mono">{c.standards.path}</code>
          {c.standards.source ? <span className="muted"> · {c.standards.source}</span> : null}
        </p>
        {c.standards.html !== null ? (
          <Markdown html={c.standards.html} />
        ) : (
          <p className="muted">
            There is no standards doc at this path, so the standards reviewer gets none.
          </p>
        )}
      </Block>

      <Block id="ctx-prompts" title="Role prompts" seen={c.seen_by.prompts}>
        {c.roles.map((role) => (
          <details key={role.role} id={`role-${role.role}`} className="round">
            <summary>
              <strong>{role.name}</strong> <span className="muted">· {role.model}</span>{' '}
              <span className="chip chip-level">
                {role.read_only ? 'read-only' : 'can edit and run commands'}
              </span>
            </summary>
            <div className="round-body">
              <p>
                <strong>Tools:</strong> {role.tools.join(', ')}
              </p>
              <p>
                <strong>Gets in its prompt:</strong> {role.inputs}.
              </p>
              {role.prompt_html !== null ? (
                <Markdown html={role.prompt_html} />
              ) : (
                <p className="muted">This role's prompt file couldn't be read.</p>
              )}
            </div>
          </details>
        ))}
      </Block>
    </>
  );
}
