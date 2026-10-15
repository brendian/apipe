// Small text helpers that behave like the Python the pipeline was ported from.

/** Python's `str.splitlines()` (no trailing empty element; splits on the same line boundaries). */
export function splitLines(text: string): string[] {
  // eslint-disable-next-line no-control-regex -- Python's splitlines() splits on \x1c-\x1e
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Python's `repr` for the string and number values the original's error messages quote. */
export function pyRepr(value: string | number): string {
  if (typeof value === 'number') return String(value);
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  return quote + value.replace(/\\/g, '\\\\').replaceAll(quote, '\\' + quote) + quote;
}
