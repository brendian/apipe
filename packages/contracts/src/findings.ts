import { z } from 'zod';
import { Category, Severity } from './primitives.js';

// Findings, verdicts, author responses, rulings (docs/03 §2).

export const Finding = z.object({
  id: z.string(),
  severity: Severity,
  category: Category,
  file: z.string().nullable().default(null),
  line: z.number().int().nullable().default(null),
  criterion: z.string().nullable().default(null),
  claim: z.string(),
  evidence: z.string().default(''),
  suggested_check: z.string().default(''),
});
export type Finding = z.infer<typeof Finding>;

/** A finding must point at file + line, or at an acceptance criterion. */
export function isGrounded(f: Finding): boolean {
  return (!!f.file && f.line !== null) || !!f.criterion;
}

export function isBlocking(f: Finding): boolean {
  return f.severity === 'blocking';
}

/** Key used to recognise the same finding raised again in a later round (line numbers move). */
export function matchKey(f: Finding): [string, string] | null {
  if (!f.file && !f.criterion) return null;
  return [f.file ?? '', f.criterion ?? ''];
}

/** `matchKey` as a string, for use in sets and maps. */
export function matchKeyString(f: Finding): string | null {
  const key = matchKey(f);
  return key === null ? null : JSON.stringify(key);
}

/** A gate or guard finding cannot be disputed (rule 7). */
export function isGate(f: Finding): boolean {
  return !!f.criterion && (f.criterion.startsWith('gate:') || f.criterion.startsWith('guard:'));
}

/**
 * A critic's verdict, with the rules enforced in the schema so no caller can forget them:
 * ungrounded findings move to `noise`, and a PASS that carries a blocking finding is a FAIL.
 * `noise` is never written back to disk: serialise with `verdictJson`.
 */
export const Verdict = z
  .object({
    verdict: z.enum(['PASS', 'FAIL']),
    findings: z.array(Finding).default([]),
  })
  .transform((v) => {
    const grounded = v.findings.filter(isGrounded);
    const noise = v.findings.filter((f) => !isGrounded(f));
    const hasBlocking = grounded.some(isBlocking);
    return {
      verdict: v.verdict === 'PASS' && hasBlocking ? ('FAIL' as const) : v.verdict,
      findings: grounded,
      noise,
    };
  });
export type Verdict = z.output<typeof Verdict>;

export const blockingOf = (v: Pick<Verdict, 'findings'>): Finding[] =>
  v.findings.filter(isBlocking);
export const minorOf = (v: Pick<Verdict, 'findings'>): Finding[] =>
  v.findings.filter((f) => !isBlocking(f));

/** The on-disk form of a verdict (no `noise`). */
export function verdictJson(v: Verdict): { verdict: Verdict['verdict']; findings: Finding[] } {
  return { verdict: v.verdict, findings: v.findings };
}

export const FindingResponse = z.object({
  finding_id: z.string(),
  action: z.enum(['fixed', 'disputed']),
  note: z.string().default(''),
  reason: z.string().default(''),
});
export type FindingResponse = z.infer<typeof FindingResponse>;

export const AuthorResponse = z.object({ responses: z.array(FindingResponse).default([]) });
export type AuthorResponse = z.infer<typeof AuthorResponse>;

/** The responses an author disputed, by finding id. */
export function disputed(r: AuthorResponse): Map<string, FindingResponse> {
  return new Map(r.responses.filter((x) => x.action === 'disputed').map((x) => [x.finding_id, x]));
}

export const Ruling = z.object({
  finding_id: z.string(),
  decision: z.enum(['dismiss', 'fix']),
  reason: z.string().default(''),
});
export type Ruling = z.infer<typeof Ruling>;

export const ArbiterRuling = z.object({ rulings: z.array(Ruling).default([]) });
export type ArbiterRuling = z.infer<typeof ArbiterRuling>;

export const BypassAnswer = z.object({
  id: z.string(),
  answer: z.string().default(''),
  reasoning: z.string().default(''),
});
export type BypassAnswer = z.infer<typeof BypassAnswer>;

/** An agent's reply when a person chose Bypass: its own answer to each question. */
export const BypassAnswers = z.object({ answers: z.array(BypassAnswer).default([]) });
export type BypassAnswers = z.infer<typeof BypassAnswers>;

/** The schema names that appear in the JSON-retry prompt (docs/07 §9). */
export const SCHEMA_NAMES = {
  verdict: 'Verdict',
  arbiter: 'ArbiterRuling',
  bypass: 'BypassAnswers',
} as const;

// In-memory only (never on disk as such).
export type Dispute = { finding: Finding; response: FindingResponse | null };
export type StageResult = {
  name: string;
  passed: boolean;
  rounds: number;
  open_findings: Dispute[];
  minor_findings: Finding[];
};
