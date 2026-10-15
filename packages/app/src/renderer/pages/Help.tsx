import type { ReactNode } from 'react';
import type { AboutView, HelpView } from '@advpipe/contracts';
import { Callout } from '../components/Callout.js';
import { PageHeading } from '../components/PageHeading.js';
import { StatusChip } from '../components/StatusChip.js';
import { useApi } from '../state/api.js';
import { useRemote } from '../state/remote.js';
import { Link } from '../state/router.js';
import { dollars } from '../components/format.js';

// The Help page (docs/05 §5.8). The tables come from `app.help`, which the engine builds from the
// same code the pipeline and the other pages use, so they say what advpipe really does. The prose
// is the original's, with the browser, token and terminal wording changed for the desktop app.

const SECTIONS: [id: string, title: string][] = [
  ['levels', 'Levels: how much checking'],
  ['steps', 'The steps'],
  ['agents', 'The agents'],
  ['checks', 'Checks'],
  ['asks', 'When a run asks you'],
  ['logins', 'Subscription or Console credits'],
  ['statuses', 'Run statuses'],
  ['pages', 'Using advpipe'],
  ['keyboard', 'Keyboard'],
  ['stored', 'Where things are stored'],
  ['safety', 'Money and safety'],
  ['words', 'Words used here'],
  ['about', 'About'],
];

/** A wide table scrolls inside its own box, which is focusable so the keyboard can scroll it. */
function Table({
  label,
  head,
  children,
}: {
  label: string;
  head: ReactNode[];
  children: ReactNode;
}) {
  return (
    <div className="table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table className="items-table help-table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Section({ id, children }: { id: string; children: ReactNode }) {
  const title = SECTIONS.find(([s]) => s === id)?.[1] ?? id;
  return (
    <section className="help-block" id={id} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      {children}
    </section>
  );
}

export function Help() {
  const api = useApi();
  const help = useRemote(() => api.app.help({}), [api]);
  const about = useRemote(() => api.app.about({}), [api]);
  return (
    <>
      <PageHeading>How advpipe works</PageHeading>
      {help.state.status === 'loading' ? <p>Loading…</p> : null}
      {help.state.status === 'error' ? <Callout tone="bad">{help.state.error}</Callout> : null}
      {help.state.status === 'ready' ? (
        <HelpBody
          h={help.state.value}
          about={about.state.status === 'ready' ? about.state.value : null}
        />
      ) : null}
    </>
  );
}

function HelpBody({ h, about }: { h: HelpView; about: AboutView | null }) {
  const api = useApi();
  const l = h.limits;
  return (
    <>
      <p className="lead">
        advpipe takes one task, a <strong>work item</strong>, and has a team of AI agents build it
        on a new git branch. Every piece of work is checked by a second agent whose only job is to
        find what&apos;s wrong with it, and by your project&apos;s own tests and checks. When
        it&apos;s done, the branch waits for you: advpipe never merges or pushes.
      </p>

      <nav className="toc" aria-label="On this page">
        <ul>
          {SECTIONS.map(([id, title]) => (
            <li key={id}>
              <a href={`#${id}`}>{title}</a>
            </li>
          ))}
        </ul>
      </nav>

      <Section id="levels">
        <p>
          Every run has a <strong>level</strong>, picked by you (the slider on the New run page, or
          the work item&apos;s <code>level:</code>) and never changed by an agent. A lower level
          uses fewer agents, so it&apos;s quicker and cheaper, and checks less. Your project&apos;s
          own checks (tests, types, lint) run at every level and must be green for a run to be
          complete.
        </p>
        <Table
          label="Levels"
          head={['Level', 'Agents', 'Steps', 'Agent calls', 'Good for', 'Scan by default']}
        >
          {h.levels.map((lv) => (
            <tr key={lv.name}>
              <td>
                <strong>
                  {lv.number}. {lv.label}
                </strong>
                <div className="muted">
                  <code>{lv.name}</code>
                </div>
              </td>
              <td>{lv.agents}</td>
              <td>{lv.steps}</td>
              <td>{lv.calls}</td>
              <td>{lv.good_for}</td>
              <td>{lv.scan}</td>
            </tr>
          ))}
        </Table>
        <p className="muted">
          Agent calls: the number between starting and the next time the run stops for you, with the
          default round limits, if all goes well, or up to the most it can make.
        </p>
        <dl className="help-defs">
          {h.levels.map((lv) => (
            <div key={lv.name}>
              <dt>{lv.label}</dt>
              <dd>
                {lv.description}
                {lv.dropped.length > 0 ? (
                  <>
                    {' '}
                    <span className="muted">Not done: {lv.dropped.join('; ')}.</span>
                  </>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
        <p>
          The design rules, level by level. Rules 2, 4 and 6 only apply where there are agents for
          them to govern; at Full, the default, all of them apply.
        </p>
        <Table label="Design rules by level" head={['Rule', ...h.level_labels]}>
          {h.rule_marks.map((r) => (
            <tr key={r.rule}>
              <td>{r.rule}</td>
              {r.marks.map((m, i) => (
                <td key={i}>{m}</td>
              ))}
            </tr>
          ))}
        </Table>
        <p>
          The <strong>security scan</strong> (semgrep by default) is a switch of its own: on at
          Full, off below it unless you turn it on. At Full the security reviewer checks each hit.
          Below Full nobody does, so you choose what a hit means: <em>Ask me</em> (the run stops at
          the first one), <em>Ignore</em> (recorded as minor findings marked <em>ignored by you</em>
          ) or <em>Block</em> (treated like a failing test: the author fixes it and the scan runs
          again).
        </p>
      </Section>

      <Section id="steps">
        <p>
          A run at the Full level goes through these steps, in this order (lower levels leave some
          out: see <a href="#levels">Levels</a>). The program running them is ordinary code, not an
          agent, so no step is ever skipped.
        </p>
        <ol className="help-steps">
          <li>
            <strong>SPEC.</strong> (At Basic and Reviewer, <strong>SOLO</strong> instead of SPEC,
            TESTS and CODE: one agent writes <code>task.md</code>, the tests and the code in one
            pass.) The spec writer turns your work item into <code>task.md</code>: what to build, as
            numbered <em>acceptance criteria</em> (AC1, AC2, …), plus anything unclear as{' '}
            <em>open questions</em>. A question marked <code>BLOCKING</code> stops the run here, for
            you to answer: the run shows as <em>needs answers</em>, with a form on its page. Then
            the same run carries on: the spec writer revises <code>task.md</code> with your answers,
            and advpipe adds them, word for word, in an <em>Answers</em> section every later agent
            reads. At most {l.max_rounds_spec} spec passes by default.
          </li>
          <li>
            <strong>TESTS.</strong> The test author writes tests for the criteria, before any code
            exists, and the tests must fail (there&apos;s nothing to pass yet). The test critic
            looks for gaps. Up to {l.max_rounds_tests} rounds by default.
          </li>
          <li>
            <strong>CODE.</strong> The coder changes the code until the tests and checks pass,
            without touching the tests. The code critic looks for bugs and unmet criteria. Up to{' '}
            {l.max_rounds_code} rounds by default.
          </li>
          <li>
            <strong>REVIEW.</strong> A standards reviewer and a security reviewer each read the
            whole change once, at the same time. There&apos;s no back-and-forth with them: anything
            they say must be fixed goes to the arbiter.
          </li>
          <li>
            <strong>ARBITER.</strong> Only if must-fix findings are still open after a step (after
            its last round, or from the reviewers). The arbiter decides, for each, <em>fix</em> or{' '}
            <em>dismiss</em>, with a reason; a failed check is always <em>fix</em>. If anything is
            to be fixed, the author gets one more pass and the checks run again. Usually it
            isn&apos;t needed.
          </li>
          <li>
            <strong>FINAL CHECKS.</strong> All checks run once more on the finished branch. Green
            means the run is <em>complete</em>.
          </li>
        </ol>
        <p>
          A <strong>round</strong> is one try by the author, followed by the checks and the
          critic&apos;s verdict. If the critic says PASS, the step is done. If not, the author gets
          the findings and tries again, up to the round limit. What&apos;s still open then goes to
          the arbiter.
        </p>
        <p>On a run&apos;s page the timeline shows each step as:</p>
        <dl className="help-defs">
          {h.step_states.map((s) => (
            <div key={s.label}>
              <dt>{s.label}</dt>
              <dd>{s.help}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section id="agents">
        <p>
          Each agent has one job and its own instructions (its <em>role prompt</em>: see a
          run&apos;s <em>Spec &amp; context</em> tab). Only one agent changes files at a time.
          Critics and reviewers only read: they return <em>findings</em>, never edits. And they
          judge the work itself (the spec, the diff and the check output), never the author&apos;s
          explanation of it.
        </p>
        <Table
          label="Agents"
          head={['Agent', 'Its job', "What it's given", 'Tools', 'Default model']}
        >
          {h.roles.map((r) => (
            <tr key={r.role}>
              <td>
                <strong>{r.role}</strong>
                <div className="muted">{r.writes ? 'changes files' : 'read-only'}</div>
              </td>
              <td>{r.job}</td>
              <td>{r.inputs}</td>
              <td>{r.tools.join(', ')}</td>
              <td>
                <code className="nowrap">{r.model}</code>
              </td>
            </tr>
          ))}
        </Table>
        <p className="muted">
          The models, round limits and budget can be changed in your <code>pipeline.toml</code>; a
          run&apos;s <em>Spec &amp; context</em> tab shows the ones it used.
        </p>
      </Section>

      <Section id="checks">
        <p>
          Checks are your project&apos;s own commands, run by advpipe itself, not by an agent. Their
          result is facts, not opinion: a check that fails always counts as a problem that must be
          fixed, whatever a critic says. (In the config file they&apos;re called <em>gates</em>.)
        </p>
        <ul>
          {h.checks.map((c) => (
            <li key={c.name}>
              <code>{c.name}</code>: {c.help}.
            </li>
          ))}
        </ul>
      </Section>

      <Section id="asks">
        <p>
          A run stops and asks at the points where a person should decide. It never decides these
          itself, unless you chose so up front. They show as <em>needs answers</em> or{' '}
          <em>needs a decision</em>, with the choices on the run&apos;s page.
        </p>
        <ul>
          <li>
            <strong>Blocking questions</strong> (every level). Answer them, and the same run carries
            on. Or choose <strong>Bypass</strong>, for one question or all: the agent answers with
            its best judgement, and its answers are marked <em>agent&apos;s best judgement</em> in{' '}
            <code>task.md</code>, the report and the run page. Bypass covers only the questions of
            that stop. After {l.max_rounds_spec} spec passes the run asks <em>Begin work?</em>: yes,
            and the agent decides what&apos;s left and every later question. The New run page also
            has <em>Don&apos;t stop for questions</em>, which bypasses every question from the
            start. It&apos;s rarely the right choice.
          </li>
          <li>
            <strong>Checks still failing.</strong> After the pipeline has done what it can on its
            own, you choose <strong>another fix pass</strong> (with a note for the author, if you
            like; at most {l.max_fix_passes} per run) or <strong>take over</strong>: the work is
            committed to the branch as it is, the working copy is removed, and you finish by hand.
          </li>
          <li>
            <strong>Security scan hits</strong> below Full, if you left <em>Ask me</em>:{' '}
            <strong>ignore</strong> or <strong>block</strong>. Your choice holds for the rest of the
            run, so you&apos;re asked at most once.
          </li>
          <li>
            <strong>A usage limit.</strong> If a subscription usage limit (the 5-hour or weekly one)
            or the Console credit balance runs out part-way, the run <strong>pauses</strong> instead
            of failing, and says which limit it was and when it resets. Add extra usage or credits
            (or wait for the reset), then press <strong>Try again</strong>: the step that was cut
            off starts again with its partial work kept. If the limit is still in force it pauses
            again; nothing retries by itself. Or <strong>finish as is</strong>: nothing is
            committed, and the work so far stays in the working copy, uncommitted, for you to look
            at.
          </li>
        </ul>
        <p>
          Where a run stops, its working copy is left exactly as it was, so what you&apos;re
          deciding about is still there.
        </p>
      </Section>

      <Section id="logins">
        <p>
          advpipe talks to Claude through Claude Code, with whatever login Claude Code has. It never
          asks for, reads or stores a key or token. Which login it is changes what the dollar
          figures mean:
        </p>
        <ul>
          <li>
            <strong>A Claude subscription.</strong> Nothing is billed per call: the cost shown is an{' '}
            <em>API-equivalent</em> estimate, and the budget still caps it. The limits that matter
            are your plan&apos;s usage windows. advpipe shows the <em>last known</em> usage next to
            the budget (for example <em>5-hour: 62% used, resets 14:00</em>). Claude reports usage
            only when it changes, so the figures say how old they are and are never a live gauge.
          </li>
          <li>
            <strong>Anthropic Console credits</strong> (an API key). Every call is{' '}
            <strong>real money</strong>. Pages that start or restart work warn you, with the most
            the run can spend. It&apos;s a warning, not a prompt.
          </li>
          <li>
            <strong>Not known yet.</strong> advpipe learns the login from a run&apos;s first agent
            call. Until then it says so, and never guesses from silence.
          </li>
        </ul>
      </Section>

      <Section id="statuses">
        <Table label="What each status means" head={['Status', 'What it means', 'What to do']}>
          {h.statuses.map((s) => (
            <tr key={s.key}>
              <td>
                <StatusChip status={s.key} />
              </td>
              <td>{s.help}</td>
              <td>{s.next}</td>
            </tr>
          ))}
        </Table>
        <p>
          A <strong>finding</strong> is one problem a critic or reviewer reports. It must point at a
          file and line, or at an acceptance criterion. <em>Blocking</em> findings must be fixed (or
          dismissed by the arbiter) before the run can finish; <em>minor</em> ones are noted in the
          report.
        </p>
      </Section>

      <Section id="pages">
        <ul>
          <li>
            <Link to="/runs">Runs</Link> lists every run in this repo, newest first, and updates
            itself. Click a run for its page: status and cost, the live log, the timeline with every
            round (what the author replied, the check results, the diff the critic judged, its
            findings), the report, and the commands to run next.
          </li>
          <li>
            <Link to="/items">Work items</Link> are markdown files describing one task each, kept in
            your repo. Write and edit them here, then <em>Run</em> one. Saving writes the file;
            committing it is up to you.
          </li>
          <li>
            <Link to="/runs/new">New run</Link> shows the branch it will make, the config it uses
            and how much it can spend, before anything starts. Runs carry on in the background, even
            if you close the window or quit advpipe; open the repo again to follow them.
          </li>
          <li>
            A run&apos;s buttons (<em>Cancel</em>, <em>Resume</em>, <em>Clean up</em>) only show
            when they make sense.
          </li>
          <li>
            Each repo has its own window (File → Open repo…). The button at the top right switches
            between your system&apos;s theme, dark and light.
          </li>
        </ul>
      </Section>

      <Section id="keyboard">
        <p>
          Everything can be used with the keyboard: <kbd>Tab</kbd> moves between links and buttons,
          and <kbd>Enter</kbd> opens a step or round. Shortcuts work when no text box has the focus:
        </p>
        <dl className="help-defs">
          <div>
            <dt>
              <kbd>g</kbd> then <kbd>r</kbd>
            </dt>
            <dd>Go to the runs.</dd>
          </div>
          <div>
            <dt>
              <kbd>g</kbd> then <kbd>i</kbd>
            </dt>
            <dd>Go to the work items.</dd>
          </div>
          <div>
            <dt>
              <kbd>g</kbd> then <kbd>h</kbd>
            </dt>
            <dd>Go to this page.</dd>
          </div>
          <div>
            <dt>
              <kbd>n</kbd>
            </dt>
            <dd>Start a new run.</dd>
          </div>
          <div>
            <dt>
              <kbd>Ctrl</kbd> + <kbd>[</kbd> / <kbd>]</kbd> (<kbd>⌘</kbd> on a Mac)
            </dt>
            <dd>Back and forward.</dd>
          </div>
          <div>
            <dt>
              <kbd>Esc</kbd>
            </dt>
            <dd>Closes a confirmation box.</dd>
          </div>
        </dl>
      </Section>

      <Section id="stored">
        <ul>
          <li>
            Everything a run makes is in your repo&apos;s <code>.advpipe/</code> folder: one folder
            per run (<code>.advpipe/runs/&lt;run id&gt;/</code>), and the working copies in{' '}
            <code>.advpipe/worktrees/</code>. It is never committed (advpipe adds it to{' '}
            <code>.git/info/exclude</code>) and it is safe to delete when no run is working;{' '}
            <em>Clean up</em> does it one run at a time.
          </li>
          <li>
            Work items are in the folder shown on the Work items page (<code>work-items</code> by
            default), kept out of git until you decide otherwise.
          </li>
          <li>
            advpipe&apos;s own settings (theme, recent repos, window sizes) and its log are in your
            user folder, outside any repo. The log never holds agent output or your code.
          </li>
        </ul>
      </Section>

      <Section id="safety">
        <ul>
          <li>
            <strong>Every run has a budget</strong> ({dollars(l.budget_usd_per_task)} by default).
            It stops when it&apos;s spent, and you can resume it with a bigger one. The New run page
            says how much a run can spend before you start it.
          </li>
          <li>
            <strong>Agents work in a separate copy</strong> of your repo (a git worktree), on their
            own branch. Your working copy and branches aren&apos;t touched.
          </li>
          <li>
            <strong>Nothing is merged or pushed.</strong> Merging is your decision; the run page
            gives you the commands to copy.
          </li>
          <li>
            <strong>Agents run shell commands with your permissions</strong>, with no sandbox: the
            test author, the coder and the solo agent can run anything you could. Use advpipe on
            code you trust.
          </li>
          <li>
            <strong>Your code goes to the Claude API</strong> as part of the agents&apos; work.
            advpipe itself makes no other network calls, has no accounts and sends no telemetry.
          </li>
        </ul>
      </Section>

      <Section id="words">
        <dl className="help-defs">
          <div>
            <dt>work item</dt>
            <dd>The task you give advpipe, in a few lines of plain text.</dd>
          </div>
          <div>
            <dt>task.md</dt>
            <dd>
              The spec the spec writer makes from it. Every later agent works from this, not from
              the work item.
            </dd>
          </div>
          <div>
            <dt>acceptance criteria</dt>
            <dd>The numbered, testable statements in task.md that say when the work is done.</dd>
          </div>
          <div>
            <dt>author / critic</dt>
            <dd>The agent that does a step&apos;s work, and the one that checks it.</dd>
          </div>
          <div>
            <dt>finding</dt>
            <dd>One problem a critic or reviewer reports: blocking or minor.</dd>
          </div>
          <div>
            <dt>round</dt>
            <dd>One try by the author, then the checks and the critic&apos;s verdict.</dd>
          </div>
          <div>
            <dt>checks (gates)</dt>
            <dd>
              Your project&apos;s tests, type checker, linter and security scanner, run by advpipe.
            </dd>
          </div>
          <div>
            <dt>run id</dt>
            <dd>
              The name of a run&apos;s folder, <code>.advpipe/runs/&lt;run id&gt;/</code>, which
              holds everything it did.
            </dd>
          </div>
        </dl>
      </Section>

      <Section id="about">
        {about ? (
          <p>
            {about.name} {about.version}. <span className="muted">Electron {about.electron}</span>{' '}
            <span className="muted">· Chromium {about.chrome}</span>{' '}
            <span className="muted">· Node {about.node}</span>
          </p>
        ) : null}
        <p>
          advpipe never merges or pushes, and never touches your working tree. If something goes
          wrong, the app&apos;s log may say why.
        </p>
        <button type="button" className="btn" onClick={() => void api.app.logs.open({})}>
          Open log folder
        </button>
      </Section>
    </>
  );
}
