/**
 * Review-prompt gating tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/reviewPrompt.test.ts
 *   (or: npm run test:review)
 *
 * iOS silently ignores SKStoreReviewController past three prompts per year, so
 * a bug here doesn't crash — it quietly wastes the only three chances the app
 * gets. That is exactly the kind of failure worth pinning down in tests.
 */

import {
  shouldPromptForReview,
  recordPrompted,
  daysSinceLastPrompt,
  initialReviewState,
  MAX_PROMPTS_PER_YEAR,
  MIN_DAYS_BETWEEN_PROMPTS,
  MIN_SESSIONS_FOR_ORGANIC_PROMPT,
  type ReviewState,
} from '../src/lib/reviewPrompt';

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
const NOW = new Date('2026-08-01T12:00:00');

/** `days` before NOW, as an ISO string. */
const daysBefore = (days: number): string =>
  new Date(NOW.getTime() - days * DAY).toISOString();

const state = (over: Partial<ReviewState> = {}): ReviewState => ({
  ...initialReviewState(),
  ...over,
});

console.log('\nFirst ask');

check(
  'a new subscriber is asked even with no recorded sessions',
  shouldPromptForReview(state(), { now: NOW, sessionCount: 0, trigger: 'subscribed' }),
);

check(
  'organic trigger waits for enough sessions',
  !shouldPromptForReview(state(), {
    now: NOW,
    sessionCount: MIN_SESSIONS_FOR_ORGANIC_PROMPT - 1,
    trigger: 'practice_complete',
  }),
);

check(
  'organic trigger asks once the session floor is met',
  shouldPromptForReview(state(), {
    now: NOW,
    sessionCount: MIN_SESSIONS_FOR_ORGANIC_PROMPT,
    trigger: 'practice_complete',
  }),
);

check(
  'streak milestone follows the same session floor',
  !shouldPromptForReview(state(), { now: NOW, sessionCount: 1, trigger: 'streak_milestone' }),
);

console.log('\nAnswering is terminal');

check(
  'never asks again after a rating',
  !shouldPromptForReview(state({ outcome: 'rated', promptCount: 1, lastPromptedAt: daysBefore(400) }), {
    now: NOW, sessionCount: 50, trigger: 'practice_complete',
  }),
);

check(
  'never asks again after an explicit decline',
  !shouldPromptForReview(state({ outcome: 'declined', promptCount: 1, lastPromptedAt: daysBefore(400) }), {
    now: NOW, sessionCount: 50, trigger: 'practice_complete',
  }),
);

check(
  'leaving feedback does NOT close the door — they may come around',
  shouldPromptForReview(state({ outcome: 'feedback', promptCount: 1, lastPromptedAt: daysBefore(400) }), {
    now: NOW, sessionCount: 50, trigger: 'practice_complete',
  }),
);

console.log('\nCooldown');

check(
  `silent within ${MIN_DAYS_BETWEEN_PROMPTS} days of the last ask`,
  !shouldPromptForReview(
    state({ promptCount: 1, lastPromptedAt: daysBefore(MIN_DAYS_BETWEEN_PROMPTS - 1) }),
    { now: NOW, sessionCount: 20, trigger: 'practice_complete' },
  ),
);

check(
  'asks again once the cooldown has elapsed',
  shouldPromptForReview(
    state({ promptCount: 1, lastPromptedAt: daysBefore(MIN_DAYS_BETWEEN_PROMPTS + 1) }),
    { now: NOW, sessionCount: 20, trigger: 'practice_complete' },
  ),
);

check(
  'the cooldown applies to new subscribers too',
  !shouldPromptForReview(
    state({ promptCount: 1, lastPromptedAt: daysBefore(1) }),
    { now: NOW, sessionCount: 20, trigger: 'subscribed' },
  ),
);

check('daysSinceLastPrompt is Infinity when never asked', daysSinceLastPrompt(state(), NOW) === Infinity);

check(
  'daysSinceLastPrompt survives a corrupt timestamp',
  daysSinceLastPrompt(state({ lastPromptedAt: 'not-a-date' }), NOW) === Infinity,
);

console.log("\nApple's annual cap");

check(
  `silent at ${MAX_PROMPTS_PER_YEAR} prompts, however long ago`,
  !shouldPromptForReview(
    state({ promptCount: MAX_PROMPTS_PER_YEAR, lastPromptedAt: daysBefore(900) }),
    { now: NOW, sessionCount: 200, trigger: 'practice_complete' },
  ),
);

check(
  `still willing at ${MAX_PROMPTS_PER_YEAR - 1} prompts`,
  shouldPromptForReview(
    state({ promptCount: MAX_PROMPTS_PER_YEAR - 1, lastPromptedAt: daysBefore(900) }),
    { now: NOW, sessionCount: 200, trigger: 'practice_complete' },
  ),
);

console.log('\nRecording a prompt');

const after = recordPrompted(state(), NOW);
check('increments the count', after.promptCount === 1);
check('stamps the time', after.lastPromptedAt === NOW.toISOString());
check('leaves the outcome alone', after.outcome === 'none');
check(
  'recording immediately closes the door until the cooldown',
  !shouldPromptForReview(after, { now: NOW, sessionCount: 20, trigger: 'practice_complete' }),
);

const capped = [1, 2, 3].reduce((s) => recordPrompted(s, NOW), state());
check(
  'three recorded prompts reach the cap',
  capped.promptCount === MAX_PROMPTS_PER_YEAR &&
    !shouldPromptForReview(capped, { now: NOW, sessionCount: 200, trigger: 'subscribed' }),
);

console.log(
  failures === 0 ? '\nAll review prompt tests passed.\n' : `\n${failures} failure(s).\n`,
);
process.exit(failures === 0 ? 0 : 1);
