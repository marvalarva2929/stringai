/**
 * Weekly goal math tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/weeklyGoal.test.ts
 *   (or: npm run test:weeklygoal)
 *
 * Checks the Monday-week-start calculation and the minutes-practiced-this-week
 * aggregation used by the home screen WeeklyGoalCard.
 */

import { getWeekStart, minutesPracticedThisWeek } from '../src/lib/weeklyGoal';
import type { SessionSummary } from '../src/types/analysis';

let failures = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function session(recordedAt: Date, durationSeconds: number): SessionSummary {
  return {
    id: `s-${recordedAt.getTime()}`,
    recordedAt: recordedAt.toISOString(),
    overallScore: 80,
    instrument: 'violin' as SessionSummary['instrument'],
    durationSeconds,
  };
}

console.log('getWeekStart');
{
  // Wed Jul 8 2026 15:30 local → Mon Jul 6 00:00 local
  const wed = new Date(2026, 6, 8, 15, 30);
  const start = getWeekStart(wed);
  check('midweek maps to Monday', start.getDay() === 1);
  check('Monday date is the 6th', start.getDate() === 6 && start.getMonth() === 6);
  check('time is midnight', start.getHours() === 0 && start.getMinutes() === 0);

  // Monday itself maps to the same day's midnight
  const mon = new Date(2026, 6, 6, 9, 0);
  check('Monday maps to itself', getWeekStart(mon).getDate() === 6);

  // Sunday maps back to the previous Monday
  const sun = new Date(2026, 6, 12, 23, 59);
  check('Sunday maps to previous Monday', getWeekStart(sun).getDate() === 6);
}

console.log('minutesPracticedThisWeek');
{
  const now = new Date(2026, 6, 8, 15, 30); // Wednesday
  const monday = new Date(2026, 6, 6, 10, 0);
  const lastFriday = new Date(2026, 6, 3, 10, 0); // before this week

  check('empty history → 0', minutesPracticedThisWeek([], now) === 0);

  check(
    'sessions before the week start are excluded',
    minutesPracticedThisWeek([session(lastFriday, 600)], now) === 0,
  );

  check(
    'one 45s clip this week rounds up to 1 min',
    minutesPracticedThisWeek([session(monday, 45)], now) === 1,
  );

  check(
    'durations sum across the week (300s + 330s → 11 min)',
    minutesPracticedThisWeek([session(monday, 300), session(now, 330)], now) === 11,
  );

  check(
    'mixed in/out of week counts only this week',
    minutesPracticedThisWeek([session(lastFriday, 3600), session(monday, 120)], now) === 2,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll weekly goal checks passed');
