/**
 * Pre-conversion trial recap tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/trialRecap.test.ts
 *   (or: npm run test:trialrecap)
 *
 * Two properties matter. The message must never claim progress that didn't
 * happen — congratulating someone on sessions they never recorded is worse than
 * saying nothing, and it is the kind of thing a user screenshots. And the
 * billing line must always be present and unambiguous: a recap that quietly
 * omits the charge date is both a dark pattern and a refund waiting to happen.
 */

import {
  buildTrialRecap,
  scoreImprovement,
  recapFireDate,
  daysUntil,
  RECAP_LEAD_DAYS,
} from '../src/lib/trialRecap';

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

console.log('\nHonesty about progress');

{
  const { body } = buildTrialRecap({ scores: [], streak: 0, daysLeft: 2 });
  check("no sessions is stated plainly, not dressed up", body.includes("haven't recorded a session"));
  check('no sessions still names the charge', body.includes('cancel any time'));
}

{
  const { body } = buildTrialRecap({ scores: [70], streak: 1, daysLeft: 2 });
  check('a single session is counted in the singular', body.includes('1 session'));
  check('a single session claims no trend', !body.includes('up '));
}

{
  // Two sessions is below MIN_SESSIONS_FOR_TREND — a delta here is noise.
  const { body } = buildTrialRecap({ scores: [80, 60], streak: 2, daysLeft: 2 });
  check('two sessions is too few to claim improvement', !body.includes('up '));
  check('two sessions still reports the count', body.includes('2 sessions'));
}

{
  // Newest-first: early half [60,62], late half [78,80] -> +18.
  const { body } = buildTrialRecap({ scores: [80, 78, 62, 60], streak: 4, daysLeft: 2 });
  check('a real improvement is reported', body.includes('up 18 points'), body);
}

{
  // Declining scores must not be spun as improvement.
  const { body } = buildTrialRecap({ scores: [60, 62, 78, 80], streak: 4, daysLeft: 2 });
  check('a decline is never reported as a gain', !body.includes('up '), body);
  check('a decline falls back to the streak', body.includes('4 days in a row'), body);
}

{
  // Flat scores with no streak: just the count, no invented achievement.
  const { body } = buildTrialRecap({ scores: [70, 70, 70, 70], streak: 1, daysLeft: 2 });
  check('flat scores and no streak yields only the count',
    body.includes('4 sessions') && !body.includes('up ') && !body.includes('in a row'), body);
}

console.log('\nThe billing line is never omitted');

for (const scores of [[], [70], [80, 78, 62, 60]]) {
  const { body } = buildTrialRecap({ scores, streak: 3, daysLeft: 2 });
  check(`billing stated with ${scores.length} session(s)`, body.includes('subscription starts'));
}

check('the last day reads as tomorrow, not "1 days"',
  buildTrialRecap({ scores: [70], streak: 1, daysLeft: 1 }).body.includes('starts tomorrow'));

check('the title reflects a single day left',
  buildTrialRecap({ scores: [70], streak: 1, daysLeft: 1 }).title === 'Your trial ends tomorrow');

console.log('\nImprovement maths');

check('too few sessions yields null', scoreImprovement([70, 80]) === null);
check('noise below the floor is not improvement', scoreImprovement([71, 70, 70, 70]) === null);
check('a genuine gain is returned', scoreImprovement([80, 78, 62, 60]) === 18);
check('an odd number of sessions still compares halves', scoreImprovement([80, 79, 70, 61, 60]) === 19);
check('the input array is not mutated', (() => {
  const scores = [80, 78, 62, 60];
  scoreImprovement(scores);
  return scores[0] === 80;
})());

console.log('\nScheduling');

{
  const now = new Date('2026-08-11T12:00:00Z');
  const endsAt = new Date(now.getTime() + 7 * DAY);
  const fire = recapFireDate(endsAt, now);
  check('fires RECAP_LEAD_DAYS before conversion',
    fire !== null && fire.getTime() === endsAt.getTime() - RECAP_LEAD_DAYS * DAY);
}

{
  // Already inside the lead window — a message arriving after the charge is
  // worse than none at all.
  const now = new Date('2026-08-11T12:00:00Z');
  check('a trial ending within the lead window schedules nothing',
    recapFireDate(new Date(now.getTime() + 1 * DAY), now) === null);
}

check('an already-ended trial schedules nothing',
  recapFireDate(new Date('2026-08-01T00:00:00Z'), new Date('2026-08-11T00:00:00Z')) === null);

{
  const now = new Date('2026-08-11T12:00:00Z');
  check('daysUntil rounds up to whole days',
    daysUntil(new Date(now.getTime() + 2 * DAY - 3600_000), now) === 2);
  check('daysUntil never returns zero',
    daysUntil(new Date(now.getTime() + 1000), now) === 1);
}

console.log(
  failures === 0 ? '\nAll trial recap tests passed.\n' : `\n${failures} failure(s).\n`,
);

process.exit(failures === 0 ? 0 : 1);
