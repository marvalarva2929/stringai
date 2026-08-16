/**
 * Streak math tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/streak.test.ts
 *   (or: npm run test:streak)
 *
 * The streak was previously inlined in app/(tabs)/home.tsx with no coverage.
 * It is calendar-local and has a one-day grace period, both of which are easy
 * to break — hence these cases.
 */

import { computeStreak, longestStreak, practiceDays } from '../src/lib/streak';
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

const DAY = 86_400_000;

/** A session at local noon `daysAgo` days before `now`. Noon keeps the fixture
 *  clear of DST edges and midnight rounding. */
function sessionDaysAgo(daysAgo: number, now: Date): SessionSummary {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  d.setTime(d.getTime() - daysAgo * DAY);
  return {
    id: `s-${daysAgo}`,
    recordedAt: d.toISOString(),
    overallScore: 75,
    instrument: 'violin' as SessionSummary['instrument'],
    durationSeconds: 120,
  };
}

const NOW = new Date('2026-08-01T18:00:00');

console.log('\nStreak');

check('empty history has no streak', computeStreak([], NOW) === 0);

check(
  'practising today alone is a 1-day streak',
  computeStreak([sessionDaysAgo(0, NOW)], NOW) === 1,
);

check(
  'three consecutive days ending today',
  computeStreak([0, 1, 2].map((d) => sessionDaysAgo(d, NOW)), NOW) === 3,
);

check(
  'grace period — nothing today, streak measured from yesterday',
  computeStreak([1, 2, 3].map((d) => sessionDaysAgo(d, NOW)), NOW) === 3,
  `got ${computeStreak([1, 2, 3].map((d) => sessionDaysAgo(d, NOW)), NOW)}`,
);

check(
  'two empty days ends the streak',
  computeStreak([2, 3, 4].map((d) => sessionDaysAgo(d, NOW)), NOW) === 0,
);

check(
  'a gap truncates rather than summing across it',
  computeStreak([0, 1, 3, 4, 5].map((d) => sessionDaysAgo(d, NOW)), NOW) === 2,
);

check(
  'several sessions in one day count once',
  practiceDays([sessionDaysAgo(0, NOW), sessionDaysAgo(0, NOW)]).size === 1,
);

check(
  'multiple sessions on the same day do not inflate the streak',
  computeStreak([0, 0, 0, 1].map((d) => sessionDaysAgo(d, NOW)), NOW) === 2,
);

console.log('\nLongest streak');

check('empty history', longestStreak([]) === 0);

check(
  'finds the longest run, not the current one',
  longestStreak([0, 1, 4, 5, 6, 7].map((d) => sessionDaysAgo(d, NOW))) === 4,
  `got ${longestStreak([0, 1, 4, 5, 6, 7].map((d) => sessionDaysAgo(d, NOW)))}`,
);

check(
  'single isolated day is a run of 1',
  longestStreak([sessionDaysAgo(9, NOW)]) === 1,
);

console.log(failures === 0 ? '\nAll streak tests passed.\n' : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
