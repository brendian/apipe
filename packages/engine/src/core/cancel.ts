/** Thrown when a run is cancelled (the worker's abort signal fired). `run()` handles it (docs/02 §4). */
export class Cancelled extends Error {
  override name = 'Cancelled';
  constructor(message = 'cancelled') {
    super(message);
  }
}

/** Throws `Cancelled` if `signal` has aborted: called after every agent call and between gates. */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Cancelled();
}
