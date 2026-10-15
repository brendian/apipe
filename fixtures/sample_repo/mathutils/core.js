// Core numeric helpers.

/** Return a / b, or `fallback` if b is zero. */
export function safeDiv(a, b, fallback = 0) {
  if (b === 0) return fallback;
  return a / b;
}

/** Return the arithmetic mean of `values`. */
export function mean(values) {
  if (values.length === 0) throw new RangeError("values must not be empty");
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
