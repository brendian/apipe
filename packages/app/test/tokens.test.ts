import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = (name: string): string =>
  readFileSync(path.resolve(import.meta.dirname, '../src/renderer/styles', name), 'utf-8');

describe('design tokens (docs/05 §4.1)', () => {
  it('every colour token is one light-dark() pair, and every required token exists', () => {
    const tokens = css('tokens.css');
    const required = [
      ...['bg', 'surface', 'surface-2', 'border', 'text', 'text-muted', 'link'],
      ...['accent', 'accent-text', 'ok', 'ok-bg', 'warn', 'warn-bg', 'bad', 'bad-bg'],
      ...[
        'info',
        'info-bg',
        'focus-ring',
        'diff-add-bg',
        'diff-del-bg',
        'diff-hunk-bg',
        'diff-ctx',
      ],
    ];
    for (const name of required) {
      expect(tokens, name).toMatch(new RegExp(`--${name}: light-dark\\(.+, .+\\);`));
    }
    for (const name of [
      'font-ui',
      'font-mono',
      'max-content',
      'radius-1',
      'radius-2',
      'space-1',
      'space-6',
    ]) {
      expect(tokens, name).toContain(`--${name}:`);
    }
  });

  it('the CSS has no inline-style needs, never removes the focus ring, and respects reduced motion', () => {
    const all = ['tokens.css', 'base.css', 'components.css'].map(css).join('\n');
    expect(all).toContain(':focus-visible');
    expect(all).toContain('prefers-reduced-motion');
    expect(all).not.toMatch(/\*:focus\s*\{[^}]*outline:\s*none/);
    expect(all).not.toMatch(/@import|url\(\s*['"]?https?:/);
  });

  it('adapts to a tablet width, and the page itself has no inline script or style', () => {
    const all = ['base.css', 'components.css'].map(css).join('\n');
    expect(all).toMatch(/@media \(max-width: 48rem\)/);
    const html = readFileSync(
      path.resolve(import.meta.dirname, '../src/renderer/index.html'),
      'utf-8',
    );
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>\s*\S|<style|\sstyle=/);
  });
});
