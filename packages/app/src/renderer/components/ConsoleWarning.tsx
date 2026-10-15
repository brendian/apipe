import { consoleWarning, type UsageView } from '@advpipe/contracts';
import { Callout } from './Callout.js';

/** Above anything that starts or restarts agent work, when the login is (likely) Console credits. */
export function ConsoleWarning({ usage, budget }: { usage: UsageView; budget: number | null }) {
  if (!usage.console) return null;
  return <Callout tone="warn">{consoleWarning(budget ?? 15)}</Callout>;
}
