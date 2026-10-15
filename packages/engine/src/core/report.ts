import {
  LEVEL_ORDER,
  LOGIN_LABELS,
  currentDecision,
  describeAll,
  droppedSafeguards,
  levelNumber,
  rolesFor,
  scanOn,
  type Finding,
  type RunState,
} from '@advpipe/contracts';

// report.md: the human summary, regenerated at every stop (docs/03 §10). A verbatim port of
// `runlog.render_report`, except where the original names a CLI command: those say where in the
// app to act instead (docs/02 §19).

const oneLine = (text: string): string => text.split(/\s+/).filter(Boolean).join(' ');
const indent = (text: string): string => text.trim().replaceAll('\n', '\n    ');

function findingLines(findings: readonly Finding[]): string[] {
  if (findings.length === 0) return ['- None'];
  const out: string[] = [];
  for (const f of findings) {
    const where = f.file && f.line !== null ? `${f.file}:${f.line}` : (f.file ?? '');
    const ref = [where, f.criterion ?? ''].filter(Boolean).join(', ');
    out.push(`- **${f.id}** [${f.severity}/${f.category}] (${ref}) ${f.claim}`);
    if (f.evidence) {
      out.push(`  - evidence:\n    \`\`\`\n    ${indent(f.evidence)}\n    \`\`\``);
    }
  }
  return out;
}

function costTable(state: RunState): string[] {
  const entries = Object.entries(state.cost_by_stage);
  if (entries.length === 0) return ['- None'];
  const total = entries.reduce((sum, [, cost]) => sum + cost, 0);
  const rows = ['| Stage | Agent calls | Cost | Share |', '|---|---:|---:|---:|'];
  for (const [stage, cost] of entries) {
    const share = total ? `${((cost / total) * 100).toFixed(0)}%` : '-';
    rows.push(
      `| ${stage} | ${state.calls_by_stage[stage] ?? 0} | $${cost.toFixed(2)} | ${share} |`,
    );
  }
  const calls = Object.values(state.calls_by_stage).reduce((sum, n) => sum + n, 0);
  rows.push(`| **total** | **${calls}** | **$${total.toFixed(2)}** | |`);
  return rows;
}

function questionLines(state: RunState, waiting: boolean): string[] {
  if (state.questions.length === 0) return [];
  const lines = ['## Questions and answers'];
  for (const q of state.questions) {
    lines.push(`- **${q.id}** (spec pass ${q.asked_in}): ${q.text}`);
    if (q.answer && q.source === 'agent') {
      const why = state.bypass_questions ? 'you chose Bypass up front' : 'you chose Bypass';
      lines.push(`  - **Answer (agent's best judgement, ${why}):** ${indent(q.answer)}`);
      if (q.reasoning.trim()) lines.push(`  - **Reason:** ${oneLine(q.reasoning)}`);
    } else if (q.answer) {
      lines.push(`  - **Answer:** ${indent(q.answer)}`);
    } else if (q.bypassed) {
      lines.push('  - (Bypass: the agent decides when the run resumes)');
    } else {
      lines.push('  - (not answered' + (waiting ? ' yet)' : ')'));
    }
  }
  return [...lines, ''];
}

/**
 * What happens to security scan hits below full, once that isn't "ask any more"; empty when
 * there's nothing to say. Says whether the person chose up front or at a decision point.
 */
export function scanPolicyLine(state: RunState): string {
  if (state.level === 'full' || !scanOn(state) || state.scan_policy === 'ask') return '';
  const asked = state.decisions.some((d) => d.kind === 'scan_hits' && d.choice);
  const how = asked ? 'your choice' : 'chosen up front';
  const what =
    state.scan_policy === 'ignore'
      ? 'ignored (recorded as minor findings, marked "ignored by you")'
      : 'treated like failing checks';
  return `security scan hits ${what}, ${how}`;
}

function decisionLines(state: RunState): string[] {
  if (state.decisions.length === 0) return [];
  const lines = ['## Decisions'];
  state.decisions.forEach((d, i) => {
    lines.push(`- **${i + 1}. ${d.kind}** at ${d.stage}: ${oneLine(d.explanation)}`);
    if (d.findings.length > 0) {
      lines.push(`  - ${d.findings.length} finding(s): ${d.findings.map((f) => f.id).join(', ')}`);
    }
    if (d.choice) {
      lines.push(`  - **You chose:** ${d.choice}` + (d.applied ? '' : ' (not acted on yet)'));
      if (d.note.trim()) lines.push(`  - **Your note:** ${indent(d.note)}`);
    } else {
      lines.push("  - (waiting for you: choose on the run's page)");
    }
  });
  const last = state.decisions.at(-1);
  const stage = last?.stage ?? '';
  if (state.ended_by === 'takeover') {
    lines.push(`- Handed over to you at ${stage}; the branch has the work as it was.`);
  } else if (state.ended_by === 'stop') {
    lines.push(`- Stopped at your choice at ${stage}; nothing was committed.`);
  } else if (state.ended_by === 'finish') {
    const where = state.worktree ? ` in \`${state.worktree}\`` : '';
    lines.push(`- Finished as is at ${stage}; the uncommitted work is${where || ' there'}.`);
  }
  if (state.fix_passes) lines.push(`- Fix passes you asked for: ${state.fix_passes}`);
  return [...lines, ''];
}

/** Which login the agents ran under and the last known usage; empty when nothing was reported. */
function loginLines(state: RunState): string[] {
  if (state.auth === 'unknown' && Object.keys(state.rate_limits).length === 0) return [];
  const lines = ['## Login and usage', `- **Login:** ${LOGIN_LABELS[state.auth]}`];
  if (Object.keys(state.rate_limits).length > 0) {
    lines.push(
      `- **Usage, last known:** ${describeAll(state.rate_limits).join('; ')}. Claude ` +
        'reports usage only when it changes, so this may be out of date.',
    );
  }
  if (state.auth === 'subscription') {
    lines.push(
      "- The dollar figures are API-equivalent estimates: a subscription login isn't " +
        'billed per call. The budget still caps them.',
    );
  } else if (state.auth === 'console') {
    lines.push('- Every call is billed to your Console credits, so the dollar figures are real.');
  }
  return [...lines, ''];
}

/** The run's level and what it leaves out. Just the name for full with the scan on. */
function levelLines(state: RunState): string[] {
  const scan = scanOn(state);
  const upFront = state.bypass_questions
    ? ['- **Blocking questions:** bypassed up front; the agent answers them itself']
    : [];
  const policy = scanPolicyLine(state);
  if (policy) upFront.push(`- **Scan hits:** ${policy}`);
  if (state.level === 'full' && scan) return [`- **Level:** ${state.level}`, ...upFront];
  const agents = rolesFor(state.level).length;
  const lines = [
    `- **Level:** ${state.level} (${levelNumber(state.level)} of ${LEVEL_ORDER.length}): ` +
      `${agents} agent${agents !== 1 ? 's' : ''} · security scan ${scan ? 'on' : 'off'}`,
    '- **Not done at this level:**',
  ];
  for (const line of droppedSafeguards(state.level, scan)) lines.push(`  - ${line}`);
  return [...lines, ...upFront];
}

/**
 * report.md. `waitingOnAnswers`: the run stopped on blocking questions a person can answer, so
 * the report says where.
 */
export function renderReport(state: RunState, opts: { waitingOnAnswers?: boolean } = {}): string {
  const waiting = opts.waitingOnAnswers ?? false;
  const elapsed = (Date.parse(state.updated_at) - Date.parse(state.started_at)) / 1000;
  const notes = [...state.notes];
  if (waiting) notes.push("The spec has blocking questions. Answer them on the run's page.");
  const d = currentDecision(state);
  if (d !== null && state.status === 'needs_human' && !d.choice && !state.ended_by) {
    notes.push(d.explanation);
  }
  const rounds = Object.entries(state.rounds_used).map(([k, v]) => `- ${k}: ${v}`);
  const lines = [
    `# advpipe run ${state.run_id}`,
    '',
    `- **Status:** ${state.status}`,
    ...levelLines(state),
    `- **Work item:** ${state.work_item}`,
    `- **Branch:** \`${state.branch}\`` +
      (state.worktree_removed
        ? ' (worktree removed)'
        : state.worktree
          ? ` (worktree \`${state.worktree}\`)`
          : ''),
    `- **Stopped at stage:** ${state.stage}`,
    `- **Cost:** $${state.cost_usd.toFixed(2)}`,
    `- **Time:** ${elapsed.toFixed(0)}s`,
    '',
    '## Rounds used',
    ...(rounds.length > 0 ? rounds : ['- None']),
    '',
    '## Open blocking findings',
    ...findingLines(state.open_findings),
    '',
    '## Minor findings (not fixed)',
    ...findingLines(state.minor_findings),
    '',
    '## Arbiter rulings',
    ...(state.rulings.length > 0
      ? state.rulings.map((r) => `- ${r.finding_id}: **${r.decision}**: ${r.reason}`)
      : ['- None']),
    '',
    '## Cost by stage',
    ...costTable(state),
    '',
    ...loginLines(state),
    ...questionLines(state, waiting),
    ...decisionLines(state),
    '## Notes',
    ...(notes.length > 0 ? notes.map((n) => `- ${n}`) : ['- None']),
  ];
  if (state.noise_dropped) {
    lines.push(`- ${state.noise_dropped} ungrounded finding(s) dropped as noise`);
  }
  return lines.join('\n') + '\n';
}
