import { splitLines } from './text.js';

// Blocking open questions in task.md (docs/02 §5). The pattern lives here, once, so the engine
// and the UI's task.md renderer cannot disagree about what counts as BLOCKING.

/** The `## Open questions` section: heading to the next `## ` heading or the end. */
export const OPEN_QUESTIONS_RE = /^##\s*Open questions\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/im;

/** One blocking bullet: `- BLOCKING: x`, `* **BLOCKING:** x`, `- **BLOCKING**: x`. Capture 1 = text. */
export const BLOCKING_LINE_RE = /^\s*[-*]\s*(?:\*\*)?BLOCKING(?::\*\*|\*\*:|:)\s*(.+)$/i;

/** The `## Answers` section the code writes into task.md (never an agent). */
export const ANSWERS_SECTION_RE = /^##\s*Answers\s*$[\s\S]*?(?=^##\s|$(?![\s\S]))/im;

/** Open questions the spec writer marked `BLOCKING:` (text only, trimmed). */
export function blockingOpenQuestions(taskMd: string): string[] {
  const section = OPEN_QUESTIONS_RE.exec(taskMd);
  if (!section) return [];
  const found: string[] = [];
  for (const line of splitLines(section[1] ?? '')) {
    const m = BLOCKING_LINE_RE.exec(line);
    if (m?.[1] !== undefined) found.push(m[1].trim());
  }
  return found;
}

/** For recognising the same question asked again: lower case, whitespace collapsed. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .replace(/[?. ]+$/, '');
}
