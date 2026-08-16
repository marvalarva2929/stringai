import type { SessionSummary } from '../types/analysis';

const DAY_MS = 86_400_000;

/** Local-midnight timestamp for an instant. Streaks are a calendar concept, so
 *  everything below works in the device's timezone, not UTC. */
function startOfDay(value: string | number | Date): number {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Distinct local calendar days that have at least one session. */
export function practiceDays(history: SessionSummary[]): Set<number> {
  return new Set(history.map((s) => startOfDay(s.recordedAt)));
}

/**
 * Consecutive days of practice ending today, with a one-day grace period: if
 * today has no session yet the streak is measured from yesterday, so it doesn't
 * appear to reset every morning before the day's practice. Two consecutive
 * empty days end it.
 */
export function computeStreak(history: SessionSummary[], now: Date = new Date()): number {
  if (history.length === 0) return 0;

  const days = practiceDays(history);
  let cursor = startOfDay(now);

  if (!days.has(cursor)) {
    cursor -= DAY_MS;
    if (!days.has(cursor)) return 0;
  }

  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor -= DAY_MS;
  }
  return streak;
}

/** Longest run of consecutive practice days anywhere in the history. */
export function longestStreak(history: SessionSummary[]): number {
  const days = [...practiceDays(history)].sort((a, b) => a - b);
  if (days.length === 0) return 0;

  let best = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = days[i] - days[i - 1] === DAY_MS ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}
