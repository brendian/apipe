import DOMPurify from 'dompurify';

// The ONE place in the window that sets HTML (docs/08 §4). The engine rendered the markdown with raw
// HTML escaped and only http/https/mailto links; this is the second layer: a strict allow-list, no
// `style`, no event handlers, no scheme but those three. Links are inert here (there is no browser
// to open them in); the only links the app ever opens are two constants, through `run.openLink`.

const CONFIG = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'hr',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'ul',
    'ol',
    'li',
    'strong',
    'em',
    'code',
    'pre',
    'blockquote',
    'a',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'del',
    's',
  ],
  ALLOWED_ATTR: ['href', 'class', 'title', 'rel'],
  ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') node.setAttribute('rel', 'noopener noreferrer');
});

/** Sanitised markup for `html` (exported for tests). */
export const sanitise = (html: string): string => DOMPurify.sanitize(html, CONFIG);

export function Markdown({ html, className = '' }: { html: string; className?: string }) {
  return (
    <div
      className={`markdown ${className}`.trim()}
      // Inert links: a click does nothing (the window cannot navigate).
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a')) e.preventDefault();
      }}
      dangerouslySetInnerHTML={{ __html: sanitise(html) }}
    />
  );
}
