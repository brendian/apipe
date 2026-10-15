import { splitLines } from './text.js';

export const BRANCH_PREFIX = 'advpipe/';
export const MAX_SLUG_LEN = 40;

// Filler words dropped from branch names: "add the X for the Y" -> "add-x-y".
const STOP_WORDS: ReadonlySet<string> = new Set(
  'a an and as at by for from in into of on or so that the this to with'.split(' '),
);

/**
 * A readable branch-name part from free text: the first non-empty line, lowercase words joined
 * by '-'. Filler words are dropped (unless nothing else is left) and the result is cut at a word
 * boundary to `maxLen` characters. Returns "work" when nothing usable remains.
 */
export function slugify(text: string, maxLen: number = MAX_SLUG_LEN): string {
  const first = splitLines(text).find((line) => line.trim() !== '') ?? '';
  const words = first.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const nonStop = words.filter((w) => !STOP_WORDS.has(w));
  const kept = nonStop.length > 0 ? nonStop : words;
  let slug = '';
  for (const word of kept) {
    const candidate = slug ? `${slug}-${word}` : word;
    if (candidate.length > maxLen) break;
    slug = candidate;
  }
  return slug || (kept[0] ? kept[0].slice(0, maxLen) : 'work');
}
