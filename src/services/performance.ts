/**
 * Firebase Performance Monitoring.
 *
 * HTTP requests, app start and screen rendering are collected automatically.
 * What isn't, and what matters most here, is the analysis pipeline: the
 * processing screen promises "about 30 seconds" while the progress bar is a
 * fixed timer animation, so the real distribution of pipeline durations is
 * unknown. `withTrace` wraps the phases that make up that time.
 *
 * No-ops when Firebase is unavailable, matching services/analytics.ts.
 */

import { getApps } from '@react-native-firebase/app';

function hasDefaultApp(): boolean {
  try {
    return getApps().length > 0;
  } catch {
    return false;
  }
}

export const isPerformanceConfigured = hasDefaultApp();

type PerfModule = typeof import('@react-native-firebase/perf');

let cached: PerfModule | null = null;
let loadFailed = false;

/**
 * Loaded on first use rather than imported at the top of the file. Sibling
 * Firebase packages throw on import when no default app exists — see the note in
 * services/crashReporting.ts — and there is no reason to risk the same startup
 * failure here for a module that only matters once Firebase is configured.
 */
function perf(): PerfModule | null {
  if (cached || loadFailed) return cached;
  if (!hasDefaultApp()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-firebase/perf');
    const resolved = (typeof mod?.getPerformance === 'function' ? mod : mod?.default) as
      | PerfModule
      | undefined;
    if (typeof resolved?.getPerformance !== 'function') throw new Error('unexpected module shape');
    cached = resolved;
  } catch {
    loadFailed = true;
  }
  return cached;
}

export interface TraceHandle {
  /** Records a numeric metric on the trace (e.g. frame counts, byte sizes). */
  metric(name: string, value: number): void;
  /** Records a string attribute the console can segment the trace by. */
  attribute(name: string, value: string): void;
  stop(): void;
}

const noopTrace: TraceHandle = {
  metric: () => {},
  attribute: () => {},
  stop: () => {},
};

/**
 * Starts a custom trace. Always returns a handle, so callers never branch on
 * whether Firebase is present.
 */
export function startTrace(identifier: string): TraceHandle {
  const api = perf();
  if (!api) return noopTrace;

  try {
    const t = api.trace(api.getPerformance(), identifier);
    t.start();

    return {
      metric: (name, value) => {
        if (Number.isFinite(value)) t.putMetric(name, Math.round(value));
      },
      attribute: (name, value) => {
        try {
          t.putAttribute(name, value.slice(0, 100));
        } catch {
          // Attribute limits are per-trace; exceeding them must not break the run.
        }
      },
      stop: () => {
        t.stop();
      },
    };
  } catch {
    return noopTrace;
  }
}

/** Times an async operation, stopping the trace on both success and failure. */
export async function withTrace<T>(
  identifier: string,
  fn: (t: TraceHandle) => Promise<T>,
): Promise<T> {
  const t = startTrace(identifier);
  try {
    return await fn(t);
  } finally {
    t.stop();
  }
}
