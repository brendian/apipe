import { describe, expect, it } from 'vitest';
import { AuthorResponse, disputed, Finding, matchKey, Verdict, verdictJson } from '../src/index.js';

const finding = (over: Record<string, unknown> = {}) => ({
  id: 'F1',
  severity: 'blocking',
  category: 'correctness',
  file: 'mathutils/core.js',
  line: 3,
  criterion: 'AC2',
  claim: 'wrong',
  ...over,
});

describe('Verdict rules (enforced in the schema)', () => {
  it('turns a PASS that carries a blocking finding into a FAIL, but not one with only minors', () => {
    expect(Verdict.parse({ verdict: 'PASS', findings: [finding()] }).verdict).toBe('FAIL');
    expect(
      Verdict.parse({ verdict: 'PASS', findings: [finding({ severity: 'minor' })] }).verdict,
    ).toBe('PASS');
  });

  it('moves ungrounded findings to noise, and never writes the noise back', () => {
    const v = Verdict.parse({
      verdict: 'FAIL',
      findings: [
        finding({ id: 'F1', file: null, line: null, criterion: null }),
        finding({ id: 'F2', line: null, criterion: null }), // file without a line
        finding({ id: 'F3', file: null, line: null }), // criterion alone is enough
        finding({ id: 'F4', criterion: null }), // file + line alone is enough
      ],
    });
    expect(v.findings.map((f) => f.id)).toEqual(['F3', 'F4']);
    expect(v.noise.map((f) => f.id)).toEqual(['F1', 'F2']);
    expect(verdictJson(v)).not.toHaveProperty('noise');
  });

  it('matches a re-raised finding by file and criterion, not by line', () => {
    const a = Finding.parse(finding({ line: 1 }));
    const b = Finding.parse(finding({ id: 'F9', line: 40 }));
    expect(matchKey(a)).toEqual(matchKey(b));
    expect(matchKey(Finding.parse(finding({ file: null, criterion: null })))).toBeNull();
  });
});

describe('AuthorResponse', () => {
  it('lists only the disputed findings', () => {
    const r = AuthorResponse.parse({
      responses: [
        { finding_id: 'F1', action: 'fixed' },
        { finding_id: 'F2', action: 'disputed', reason: 'AC3' },
      ],
    });
    expect([...disputed(r).keys()]).toEqual(['F2']);
  });
});
