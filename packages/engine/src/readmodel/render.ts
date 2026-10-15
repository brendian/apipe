import MarkdownItCtor from 'markdown-it';
import type { StateCore, Token } from 'markdown-it';

type MarkdownIt = InstanceType<typeof MarkdownItCtor>;
import type { TaskView } from '@advpipe/contracts';

// Markdown to HTML for agent-written text (reports, task.md, author replies). Port of `ui/render.py`.
// Agent output is untrusted (docs/08 §4): raw HTML in it is escaped, never passed through; only
// http, https and mailto links survive; images are not rendered at all (the page's CSP allows none
// from elsewhere). The window sanitises the result once more in its one `<Markdown>` component.

const ALIGN: Record<string, string> = {
  'text-align:left': 'align-left',
  'text-align:center': 'align-center',
  'text-align:right': 'align-right',
};

/** Table column alignment as a class, not a style attribute (the CSP forbids inline styles). */
function alignClasses(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.type !== 'th_open' && token.type !== 'td_open') continue;
    const style = token.attrGet('style');
    if (style === null) continue;
    token.attrs = (token.attrs ?? []).filter(([name]) => name !== 'style');
    const cls = ALIGN[style];
    if (cls !== undefined) token.attrSet('class', cls);
  }
}

const SAFE_LINK = /^(?:https?:|mailto:)/i;

function build(): MarkdownIt {
  const md = new MarkdownItCtor('commonmark', { html: false, linkify: false }).enable('table');
  md.disable('image');
  // Relative links lead nowhere in a window with no address bar; keep only the three schemes.
  md.validateLink = (url) => SAFE_LINK.test(url.trim());
  md.core.ruler.push('align_classes', alignClasses);
  return md;
}

const md = build();

/** Render `text` as HTML that is safe to put in a page (raw HTML escaped). */
export function markdown(text: string): string {
  return md.render(text);
}

// ── task.md ─────────────────────────────────────────────────────────────────────────────────────

const TASK_SECTIONS: Record<string, 'ac' | 'oq' | 'ans'> = {
  'acceptance criteria': 'ac',
  'open questions': 'oq',
  answers: 'ans',
};
// The same prefix forms as `blockingOpenQuestions`: "BLOCKING:", "**BLOCKING:**", "**BLOCKING**:".
const BLOCKING = /^(?:\*\*)?BLOCKING(?::\*\*|\*\*:|:)/i;

type Counts = { ac: number; oq: number; ans: number; blocking: number; found: Set<string> };

function itemText(tokens: Token[], i: number): string {
  return tokens[i + 1]?.type === 'paragraph_open' ? (tokens[i + 2]?.content ?? '') : '';
}

/** Classes on the acceptance-criteria and open-question headings and items, and counts of them. */
function markTaskSections(counts: Counts): (state: StateCore) => void {
  return (state) => {
    const tokens = state.tokens;
    let section: 'ac' | 'oq' | 'ans' | null = null;
    let depth = 0;
    tokens.forEach((token, i) => {
      if (token.type === 'heading_open' && (token.tag === 'h1' || token.tag === 'h2')) {
        const title = token.tag === 'h2' ? (tokens[i + 1]?.content.trim().toLowerCase() ?? '') : '';
        section = TASK_SECTIONS[title] ?? null;
        depth = 0;
        if (section !== null) {
          token.attrJoin('class', `task-${section}`);
          counts.found.add(section);
        }
      } else if (section === null) {
        return;
      } else if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
        depth += 1;
      } else if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') {
        depth -= 1;
      } else if (token.type === 'list_item_open' && depth === 1) {
        const text = itemText(tokens, i).trim();
        if (text.toLowerCase().replace(/\.$/, '') === 'none') return;
        counts[section] += 1;
        token.attrJoin('class', section);
        if (section === 'oq' && BLOCKING.test(text)) {
          counts.blocking += 1;
          token.attrJoin('class', 'blocking');
        }
      }
    });
  };
}

/** Render task.md like `markdown`, marking its acceptance criteria and open questions. */
export function taskMarkdown(text: string): TaskView {
  const counts: Counts = { ac: 0, oq: 0, ans: 0, blocking: 0, found: new Set() };
  const tm = build();
  tm.core.ruler.push('task_sections', markTaskSections(counts));
  const html = tm.render(text);
  return {
    html,
    criteria: counts.ac,
    questions: counts.oq,
    blocking: counts.blocking,
    sections: (['ac', 'oq'] as const).filter((s) => counts.found.has(s)),
  };
}
