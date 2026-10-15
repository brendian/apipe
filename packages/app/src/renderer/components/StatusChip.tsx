import { STATUSES, type DisplayStatus } from '@advpipe/contracts';

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

const TONES: Record<DisplayStatus, Tone> = {
  running: 'info',
  complete: 'ok',
  stopped: 'warn',
  needs_human: 'warn',
  needs_answers: 'warn',
  needs_decision: 'warn',
  paused: 'warn',
  budget_exceeded: 'warn',
  error: 'bad',
  handed_over: 'neutral',
  ended: 'neutral',
  finished: 'neutral',
};

/** An icon and a word, with the help text as its tooltip: status is never colour alone. */
export function StatusChip({ status }: { status: DisplayStatus }) {
  const info = STATUSES[status];
  return (
    <span className={`chip chip-${TONES[status]}`} title={info.help} data-status={status}>
      <span aria-hidden="true">{info.icon}</span>
      {info.label}
    </span>
  );
}
