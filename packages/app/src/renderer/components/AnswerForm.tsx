import { useState } from 'react';
import { MAX_ANSWER_CHARS, type RunDetail } from '@advpipe/contracts';
import { useApi } from '../state/api.js';
import { useDraft } from '../state/drafts.js';
import { useRouter } from '../state/router.js';
import { Callout } from './Callout.js';
import { ConsoleWarning } from './ConsoleWarning.js';

type Typed = { text: Record<string, string>; bypass: Record<string, boolean> };

/**
 * The spec's (or the solo agent's) blocking questions (docs/05 §5.2.4). A ticked "Let the agent
 * decide" beats the text in its box; "Bypass all and continue" beats everything. The boxes aren't
 * `required`: the host decides, so a refusal keeps what was typed. Typed text survives a refresh.
 */
export function AnswerForm({ runId, detail: d }: { runId: string; detail: RunDetail }) {
  const api = useApi();
  const { replace } = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useDraft<Typed>(`answers:${runId}`, {
    text: Object.fromEntries(d.questions.map((q) => [q.id, q.answer])),
    bypass: Object.fromEntries(d.questions.map((q) => [q.id, q.bypassed])),
  });
  const n = d.questions.length;
  const spent = `$${d.row.cost_usd.toFixed(2)}`;
  const of = d.row.budget_usd === null ? '' : ` of its $${d.row.budget_usd.toFixed(2)} budget`;

  async function send(all: boolean): Promise<void> {
    const bypass = d.questions.filter((q) => all || typed.bypass[q.id] === true).map((q) => q.id);
    const answers = Object.fromEntries(
      d.questions.filter((q) => !bypass.includes(q.id)).map((q) => [q.id, typed.text[q.id] ?? '']),
    );
    setBusy(true);
    const r = await api.run.answer({ runId, answers, bypass, ...(all ? { bypassAll: true } : {}) });
    setBusy(false);
    if (!r.ok) return setError(r.error); // the typed answers stay put
    setError('');
    replace(
      `/runs/${runId}?notice=${bypass.length > 0 && Object.keys(answers).length === 0 ? 'bypassed' : 'answered'}`,
    );
  }

  return (
    <section className="callout callout-info answer-callout" aria-labelledby="answer-h">
      <h2 id="answer-h">
        {d.asker === 'solo agent'
          ? "Answer the solo agent's questions"
          : "Answer the spec's questions"}
      </h2>
      <p>
        The {d.asker} stopped on {n === 1 ? 'this question' : 'these questions'}: it shouldn't guess
        the answer. Answer {n === 1 ? 'it' : 'every one'}, and the run carries on: the {d.asker}{' '}
        revises <code>task.md</code> with your answers (one more pass, so a little more cost), then
        the rest of the steps run as usual. Your answers go into <code>task.md</code> word for word,
        for every later agent to read. Or <strong>let the agent decide</strong>, for a question or
        for all of them: it uses its best judgement, and says so in <code>task.md</code> and the
        report. That covers only these questions: if the revision asks new ones, you're asked again.
      </p>
      <ConsoleWarning usage={d.usage} budget={d.row.budget_usd} />
      <form
        className="answer-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send(false);
        }}
      >
        {d.questions.map((q) => (
          <div className="field" key={q.id}>
            <label htmlFor={`answer-${q.id}`}>
              <strong>{q.id}</strong> {q.text}
            </label>
            <textarea
              id={`answer-${q.id}`}
              className="short"
              rows={3}
              maxLength={MAX_ANSWER_CHARS}
              value={typed.text[q.id] ?? ''}
              onChange={(e) =>
                setTyped({ ...typed, text: { ...typed.text, [q.id]: e.target.value } })
              }
            />
            <label className="choice">
              <input
                type="checkbox"
                checked={typed.bypass[q.id] === true}
                onChange={(e) =>
                  setTyped({ ...typed, bypass: { ...typed.bypass, [q.id]: e.target.checked } })
                }
              />
              Let the agent decide {q.id}{' '}
              <span className="muted">(ignores what's typed above)</span>
            </label>
          </div>
        ))}
        {error ? <Callout tone="bad">{error}</Callout> : null}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save answers and continue
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            title="The agent answers every question here, whatever is typed above"
            onClick={() => void send(true)}
          >
            Bypass all and continue
          </button>
        </div>
        <small className="muted">
          It has spent {spent}
          {of}. It continues in the background.
        </small>
      </form>
    </section>
  );
}
