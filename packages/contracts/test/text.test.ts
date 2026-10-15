import { describe, expect, it } from 'vitest';
import {
  blockingOpenQuestions,
  formatWorkItem,
  normalise,
  parseWorkItem,
  salvageWorkItem,
  slugify,
  WorkItemError,
  type WorkItem,
} from '../src/index.js';

describe('blockingOpenQuestions', () => {
  const md = (open: string, tail = '') => `# Task\n## Open questions\n${open}\n${tail}`;

  it('accepts every BLOCKING prefix form, and nothing else', () => {
    const found = blockingOpenQuestions(
      md(
        [
          '- BLOCKING: one',
          '* **BLOCKING:** two',
          '- **BLOCKING**: three',
          '- blocking: four',
          '- a normal question',
          'BLOCKING: not a bullet',
        ].join('\n'),
      ),
    );
    expect(found).toEqual(['one', 'two', 'three', 'four']);
  });

  it('reads only the Open questions section', () => {
    const text = md('- BLOCKING: real', '## Answers\n- BLOCKING: not a question\n');
    expect(blockingOpenQuestions(text)).toEqual(['real']);
    expect(blockingOpenQuestions('## Goal\n- BLOCKING: elsewhere')).toEqual([]);
  });

  it('normalises for recognising a question asked again', () => {
    expect(normalise('  Should   lo > hi THROW?? ')).toBe('should lo > hi throw');
  });
});

describe('slugify', () => {
  it.each([
    ['add a clamp(x, lo, hi) function', 'add-clamp-x-lo-hi-function'],
    ['\n\n  Fix the refund rounding bug  \n', 'fix-refund-rounding-bug'],
    ['The', 'the'],
    ['!!!', 'work'],
    ['x'.repeat(60), 'x'.repeat(40)],
    ['Ümlaut café support', 'mlaut-caf-support'],
  ])('%j -> %s', (text, slug) => {
    expect(slugify(text)).toBe(slug);
  });
});

describe('work items', () => {
  it('parses front matter and body', () => {
    const item = parseWorkItem(
      '---\nname: s03-stock\n\nconfig:  pipeline.server.toml \nlevel: 3\n---\n\nAdd stock.\n',
    );
    expect(item).toEqual({
      body: 'Add stock.',
      name: 's03-stock',
      config: 'pipeline.server.toml',
      level: '3',
    });
    expect(parseWorkItem('Intro\n\n---\n\nname: not front matter\n').name).toBeUndefined();
  });

  it.each([
    [
      '---\nname: x\nbudget: 3\n---\nbody\n',
      "item.md:3: unknown key 'budget' (known keys: name, config",
    ],
    ['---\nname: x\nname: y\n---\nbody\n', "item.md:3: 'name' is given twice"],
    ['---\nname:\n---\nbody\n', "item.md:2: 'name' has no value"],
    ['---\nlevel: 9\n---\nbody\n', "item.md:2: 'level': unknown level 9:"],
    ['---\nsecurity_scan: maybe\n---\nbody\n', "item.md:2: 'security_scan': expected yes or no"],
    ['---\nname: x\nbody\n', 'item.md: front matter starts with'],
    ['---\nname: x\n---\n \n', 'item.md: the work item is empty'],
  ])('refuses %j', (text, message) => {
    expect(() => parseWorkItem(text, 'item.md')).toThrow(WorkItemError);
    expect(() => parseWorkItem(text, 'item.md')).toThrow(message);
  });

  it('writes back what it reads', () => {
    const items: WorkItem[] = [
      { body: 'Add clamp.' },
      { body: 'x', name: 's03 stock', config: 'a: b.toml', level: 'full', bypass_questions: 'yes' },
      { body: '---\nstarts with a rule' },
    ];
    for (const item of items) {
      const text = formatWorkItem(item);
      expect(parseWorkItem(text)).toEqual(item);
      expect(text.endsWith('\n') && !text.endsWith('\n\n')).toBe(true);
      expect(formatWorkItem(parseWorkItem(text))).toBe(text);
    }
    expect(formatWorkItem({ body: '\nBody.\n\n', name: 's03' })).toBe(
      '---\nname: s03\n---\nBody.\n',
    );
    expect(() => formatWorkItem({ body: 'x', name: 'two\nlines' })).toThrow(WorkItemError);
  });

  it('salvages what it can from a file that does not parse', () => {
    const text = '---\nname: s03\ncolour: red\nname: again\nnonsense\nconfig:\n---\nBody.\n';
    expect(() => parseWorkItem(text)).toThrow();
    expect(salvageWorkItem(text)).toEqual({ fields: { name: 's03' }, body: 'Body.' });
    expect(salvageWorkItem('---\nname: x\nBody')).toEqual({
      fields: {},
      body: '---\nname: x\nBody',
    });
  });
});
