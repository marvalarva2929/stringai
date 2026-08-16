/**
 * Elapsed-time measurement for instrumented flows.
 *
 * Dependency-free so it is testable in Node, and injectable (`now`) so tests
 * don't sleep. Used by the analysis pipeline — which reports per-phase timings
 * against the "about 30 seconds" promise the processing screen makes — and by
 * the paywall, where time-on-screen before a dismiss is the signal.
 */

export type Clock = () => number;

const defaultClock: Clock = () => Date.now();

export interface Stopwatch {
  /** Milliseconds since the stopwatch was created. */
  elapsed(): number;
  /** Milliseconds since the previous `split` (or creation), and records it. */
  split(label: string): number;
  /** All recorded splits, keyed by label. */
  splits(): Record<string, number>;
}

export function createStopwatch(now: Clock = defaultClock): Stopwatch {
  const started = now();
  let last = started;
  const recorded: Record<string, number> = {};

  return {
    elapsed: () => now() - started,
    split(label: string) {
      const t = now();
      const delta = t - last;
      last = t;
      recorded[label] = delta;
      return delta;
    },
    splits: () => ({ ...recorded }),
  };
}

/** Whole days between two instants, floored. Used for the resurrection signal. */
export function daysBetween(from: string | number | Date, to: string | number | Date): number {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}
