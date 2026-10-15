import {
  STEP_STATES,
  type CriticViewData,
  type RoundViewData,
  type StepViewData,
} from '@advpipe/contracts';
import { usePanel } from '../state/panels.js';
import { DiffView } from './DiffView.js';
import { FindingCard } from './FindingCard.js';
import { GateList } from './GateList.js';
import { Markdown } from './Markdown.js';

const STATE_ICON: Record<StepViewData['state'], string> = {
  done: '✔',
  current: '●',
  stopped: '■',
  pending: '○',
  not_reached: '–',
  not_needed: '–',
  if_needed: '○',
};

const stepId = (runId: string, stage: string): string => `step-${runId}-${stage}`;

/** The strip of steps for this run's level, then a panel per step. */
export function Timeline({ runId, steps }: { runId: string; steps: StepViewData[] }) {
  return (
    <section aria-labelledby="timeline-h">
      <h2 id="timeline-h">Progress</h2>
      <ol className="timeline-strip">
        {steps.map((s) => (
          <li key={s.stage} className={`step-${s.state}`}>
            <button
              type="button"
              className="btn-link"
              title={STEP_STATES[s.state].help}
              onClick={() => document.getElementById(stepId(runId, s.stage))?.scrollIntoView?.()}
            >
              <span aria-hidden="true">{STATE_ICON[s.state]}</span> {s.label}
            </button>
            <span className="muted"> {STEP_STATES[s.state].label}</span>
          </li>
        ))}
      </ol>
      {steps.map((s) => (
        <StepPanel key={s.stage} runId={runId} step={s} />
      ))}
    </section>
  );
}

function StepPanel({ runId, step }: { runId: string; step: StepViewData }) {
  const info = STEP_STATES[step.state];
  const lastOpen = step.state === 'current' || step.state === 'stopped';
  return (
    <section id={stepId(runId, step.stage)} className="step" aria-label={`${step.label} step`}>
      <h3>
        {step.label}{' '}
        <span
          className={`chip chip-${step.state === 'stopped' ? 'warn' : step.state === 'current' ? 'info' : 'neutral'}`}
        >
          {info.label}
        </span>
        {step.summary ? <span className="muted"> · {step.summary}</span> : null}
      </h3>
      <p className="muted">{info.help}</p>
      {step.task_html ? (
        <Panel panelKey={`${runId}/${step.stage}/task`} title="task.md as it stands" open={false}>
          <Markdown html={step.task_html} />
        </Panel>
      ) : null}
      {step.rounds.map((r, i) => (
        <RoundPanel
          key={r.key}
          runId={runId}
          round={r}
          defaultOpen={lastOpen && i === step.rounds.length - 1}
        />
      ))}
      {step.rulings_note ? <p className="muted">{step.rulings_note}</p> : null}
      {step.rulings.length > 0 ? (
        <ul className="rulings" aria-label="Arbiter rulings">
          {step.rulings.map((r) => (
            <li key={r.finding_id}>
              <strong>{r.finding_id}</strong>: {r.decision}
              {r.reason ? ` — ${r.reason}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {step.rounds.length === 0 && !step.task_html && step.rulings.length === 0 ? (
        <p className="muted">Nothing here yet.</p>
      ) : null}
    </section>
  );
}

function Panel({
  panelKey,
  title,
  summary,
  open: fallback,
  children,
}: {
  panelKey: string;
  title: string;
  summary?: string;
  open: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = usePanel(panelKey, fallback);
  return (
    <details
      className="round"
      open={open}
      onToggle={(e) => {
        if (e.currentTarget.open !== open) setOpen(e.currentTarget.open);
      }}
    >
      <summary>
        <strong>{title}</strong>
        {summary ? <span className="muted"> · {summary}</span> : null}
      </summary>
      <div className="round-body">{children}</div>
    </details>
  );
}

export function RoundPanel({
  runId,
  round: r,
  defaultOpen,
}: {
  runId: string;
  round: RoundViewData;
  defaultOpen: boolean;
}) {
  const empty =
    !r.notice &&
    !r.decision &&
    r.asked.length === 0 &&
    r.author_html === null &&
    !r.task_html &&
    r.gates.length === 0 &&
    !r.diff &&
    r.critics.length === 0 &&
    r.test_fix_html === null;
  return (
    <Panel panelKey={`${runId}/${r.key}`} title={r.title} summary={r.outcome} open={defaultOpen}>
      {empty ? (
        <p className="muted">
          Nothing has been written for this round yet. If the run is still working, it appears as it
          goes; if the run has ended, the files are missing from its folder.
        </p>
      ) : null}
      {r.notice ? <p className="muted">{r.notice}</p> : null}
      {r.decision ? (
        <p>
          You chose <strong>{r.decision.choice}</strong>
          {r.decision.note ? <> with the note: “{r.decision.note}”</> : null}.
        </p>
      ) : null}
      {r.decision ? <p>{r.decision.explanation}</p> : null}
      {r.asked.length > 0 ? (
        <div>
          <h4>Blocking questions it asked</h4>
          <ul>
            {r.asked.map((q) => (
              <li key={q.id}>
                <strong>{q.id}</strong> {q.text}
                {q.answer ? (
                  <div>
                    Answer: {q.answer}{' '}
                    {q.source === 'agent' ? (
                      <span className="chip chip-info">agent's best judgement</span>
                    ) : null}
                    {q.reasoning ? <div className="muted">Reason: {q.reasoning}</div> : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {r.author_html !== null ? (
        <div>
          <h4>Author's reply{r.author_role ? ` (${r.author_role})` : ''}</h4>
          <Markdown html={r.author_html} />
        </div>
      ) : null}
      {r.task_html ? (
        <div>
          <h4>task.md after this pass</h4>
          <Markdown html={r.task_html} />
        </div>
      ) : null}
      {r.gates.map((g) => (
        <GateList key={g.label} label={g.label} view={g.view} />
      ))}
      {r.expect_red && r.gates.length > 0 ? (
        <p className="muted">The new tests are supposed to fail here: nothing is built yet.</p>
      ) : null}
      {r.diff ? (
        <div>
          <h4>Diff the critic judged</h4>
          <DiffView diff={r.diff} />
        </div>
      ) : null}
      {r.critics.map((c) => (
        <Critic key={c.role} critic={c} />
      ))}
      {r.test_fix_html !== null ? (
        <div>
          <h4>Test fix (test author)</h4>
          <Markdown html={r.test_fix_html} />
        </div>
      ) : null}
    </Panel>
  );
}

function Critic({ critic: c }: { critic: CriticViewData }) {
  return (
    <div className="critic">
      <h4>
        Verdict: {c.role}{' '}
        {c.verdict ? (
          <span className={`chip ${c.verdict.verdict === 'PASS' ? 'chip-ok' : 'chip-bad'}`}>
            <span aria-hidden="true">{c.verdict.verdict === 'PASS' ? '✔' : '✖'}</span>
            {c.verdict.verdict}
          </span>
        ) : (
          <span className="chip chip-warn">unreadable</span>
        )}
      </h4>
      {c.verdict ? (
        <>
          {c.verdict.findings.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
          {c.dropped > 0 ? (
            <p className="muted">
              {c.dropped} finding{c.dropped === 1 ? '' : 's'} dropped as noise: no file and line,
              and no acceptance criterion.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p>This output couldn't be read as a verdict. Here it is as written:</p>
          <pre className="scroll-box" tabIndex={0} aria-label={`${c.role} output`}>
            {c.raw}
          </pre>
        </>
      )}
    </div>
  );
}
