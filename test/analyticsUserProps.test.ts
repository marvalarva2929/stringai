/**
 * Analytics payload tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/analyticsUserProps.test.ts
 *   (or: npm run test:analytics)
 *
 * GA4 fails silently. An event name over 40 characters, a 26th parameter, or a
 * user-property value over 36 characters is accepted by the SDK and then never
 * appears in a report, with no error on any surface. The sanitisers are the only
 * thing standing between a typo and a dimension that is quietly always empty —
 * so they, and the catalogue itself, are asserted here.
 */

import {
  AnalyticsEvent,
  GA4_LIMITS,
  SESSION_COUNT_BUCKETS,
  STREAK_BUCKETS,
} from '../src/constants/analyticsEvents';
import {
  bucketize,
  buildCrashKeys,
  buildUserProperties,
  daysAwayBucket,
  errorReason,
  sanitizeParams,
  sanitizeUserProperties,
  weeklyGoalBucket,
  type AnalyticsUserSnapshot,
} from '../src/lib/analyticsUserProps';
import { createStopwatch, daysBetween } from '../src/lib/analyticsTiming';

let failures = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── The catalogue itself ────────────────────────────────────────────────────

console.log('\nEvent catalogue');

const names = Object.values(AnalyticsEvent);

check('every event name is within GA4\'s 40-character limit',
  names.every((n) => n.length <= GA4_LIMITS.EVENT_NAME),
  names.filter((n) => n.length > GA4_LIMITS.EVENT_NAME).join(', '));

check('every event name is snake_case',
  names.every((n) => /^[a-z][a-z0-9_]*$/.test(n)),
  names.filter((n) => !/^[a-z][a-z0-9_]*$/.test(n)).join(', '));

check('no duplicate event names', new Set(names).size === names.length);

// GA4 refuses these outright for custom events. `purchase`, `login`, `sign_up`
// and `begin_checkout` are *recommended* names and are deliberately present —
// they go through the typed loggers, not track().
const RESERVED = [
  'ad_activeview', 'ad_click', 'ad_exposure', 'ad_impression', 'ad_query',
  'app_clear_data', 'app_exception', 'app_remove', 'app_update', 'error',
  'first_open', 'first_visit', 'in_app_purchase', 'notification_dismiss',
  'notification_foreground', 'notification_open', 'notification_receive',
  'os_update', 'screen_view', 'session_start', 'user_engagement',
];
check('no reserved GA4 event names are used',
  names.every((n) => !RESERVED.includes(n)),
  names.filter((n) => RESERVED.includes(n)).join(', '));

// ── Bucketing ───────────────────────────────────────────────────────────────

console.log('\nBucketing');

check('session-count buckets read as expected',
  bucketize(0, SESSION_COUNT_BUCKETS) === '0' &&
  bucketize(1, SESSION_COUNT_BUCKETS) === '1' &&
  bucketize(4, SESSION_COUNT_BUCKETS) === '2-4' &&
  bucketize(9, SESSION_COUNT_BUCKETS) === '5-9' &&
  bucketize(24, SESSION_COUNT_BUCKETS) === '10-24' &&
  bucketize(25, SESSION_COUNT_BUCKETS) === '25+' &&
  bucketize(9999, SESSION_COUNT_BUCKETS) === '25+',
  [0, 1, 4, 9, 24, 25, 9999].map((n) => bucketize(n, SESSION_COUNT_BUCKETS)).join(' | '));

check('streak buckets read as expected',
  bucketize(0, STREAK_BUCKETS) === '0' &&
  bucketize(2, STREAK_BUCKETS) === '1-2' &&
  bucketize(6, STREAK_BUCKETS) === '3-6' &&
  bucketize(13, STREAK_BUCKETS) === '7-13' &&
  bucketize(29, STREAK_BUCKETS) === '14-29' &&
  bucketize(30, STREAK_BUCKETS) === '30+',
  [0, 2, 6, 13, 29, 30].map((n) => bucketize(n, STREAK_BUCKETS)).join(' | '));

check('bucketize floors fractional input', bucketize(4.9, SESSION_COUNT_BUCKETS) === '2-4');
check('bucketize clamps negatives to the first bucket', bucketize(-3, STREAK_BUCKETS) === '0');

check('weekly goal buckets by commitment',
  weeklyGoalBucket(35) === 'light' &&
  weeklyGoalBucket(90) === 'steady' &&
  weeklyGoalBucket(180) === 'committed' &&
  weeklyGoalBucket(400) === 'intense' &&
  weeklyGoalBucket(null) === null);

check('days-away buckets skip the same-day case',
  daysAwayBucket(0) === '0-1' &&
  daysAwayBucket(3) === '2-6' &&
  daysAwayBucket(30) === '30+');

// ── User properties ─────────────────────────────────────────────────────────

console.log('\nUser properties');

const snapshot: AnalyticsUserSnapshot = {
  tier: 'pro',
  inTrial: true,
  isAuthenticated: true,
  skillLevel: 'intermediate',
  playerCategory: 'refinement',
  learningGoal: 'classical_technique',
  dailyTime: 'ten_fifteen',
  weeklyGoalMinutes: 90,
  violinSize: 'full_4_4',
  handedness: 'right',
  focusPreference: 'tone',
  activationStep: 'carousel',
  usedDemo: false,
  sessionCount: 12,
  streakDays: 8,
  remindersEnabled: true,
  notifPermission: 'granted',
  attStatus: 'granted',
};

const props = buildUserProperties(snapshot);

check('stays within the 25 user-property limit',
  Object.keys(props).length <= GA4_LIMITS.USER_PROPERTIES,
  `${Object.keys(props).length} properties`);

check('property names are within 24 characters',
  Object.keys(props).every((k) => k.length <= GA4_LIMITS.USER_PROPERTY_NAME),
  Object.keys(props).filter((k) => k.length > GA4_LIMITS.USER_PROPERTY_NAME).join(', '));

check('property values are within 36 characters',
  Object.values(props).every((v) => v === null || v.length <= GA4_LIMITS.USER_PROPERTY_VALUE));

check('booleans become readable strings, not 1/0',
  props.in_trial === 'true' && props.used_demo === 'false');

check('counts are bucketed, never raw',
  props.session_count_bkt === '10-24' && props.streak_bkt === '7-13');

check('unanswered fields clear rather than vanish', (() => {
  const partial = buildUserProperties({
    tier: 'free',
    inTrial: false,
    isAuthenticated: false,
  });
  return partial.skill_level === null && 'violin_size' in partial;
})());

check('crash keys carry the reproduction context', (() => {
  const keys = buildCrashKeys(snapshot);
  return keys.entitlement === 'pro'
    && keys.activation_step === 'carousel'
    && keys.session_count === '12'
    && Object.values(keys).every((v) => typeof v === 'string');
})());

// ── Event parameter sanitising ──────────────────────────────────────────────

console.log('\nEvent parameters');

check('drops undefined, null and empty values', (() => {
  const out = sanitizeParams({ a: undefined, b: null, c: '', d: 0, e: false });
  // 0 and false are meaningful — only the three empties go.
  return !('a' in out) && !('b' in out) && !('c' in out) && out.d === 0 && out.e === 'false';
})());

check('truncates over-long string values to 100 characters', (() => {
  const out = sanitizeParams({ reason: 'x'.repeat(500) });
  return typeof out.reason === 'string' && out.reason.length === GA4_LIMITS.PARAM_VALUE;
})());

check('caps the parameter count at 25', (() => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 40; i++) many[`p${i}`] = 'v';
  return Object.keys(sanitizeParams(many)).length === GA4_LIMITS.PARAMS_PER_EVENT;
})());

check('drops NaN and Infinity, which would void the whole event', (() => {
  const out = sanitizeParams({ ms: NaN, score: Infinity, ok: 42 });
  return !('ms' in out) && !('score' in out) && out.ok === 42;
})());

check('passes ecommerce item arrays through untouched', (() => {
  const items = [{ item_id: 'annual', price: 59.99 }];
  const out = sanitizeParams({ items });
  return Array.isArray(out.items) && (out.items as object[]).length === 1;
})());

check('user-property sanitiser preserves explicit nulls', (() => {
  const out = sanitizeUserProperties({ a: null, b: 'x'.repeat(80), c: undefined });
  return out.a === null
    && out.b === 'x'.repeat(GA4_LIMITS.USER_PROPERTY_VALUE)
    && !('c' in out);
})());

// ── Error reasons ───────────────────────────────────────────────────────────

console.log('\nError reasons');

check('reads Error messages', errorReason(new Error('Network request failed')) === 'Network request failed');
check('accepts bare strings', errorReason('NOT_WAV') === 'NOT_WAV');
check('collapses whitespace so one fault is one dimension value',
  errorReason(new Error('a\n  b')) === 'a b');
check('falls back rather than reporting "undefined"',
  errorReason(undefined) === 'unknown' && errorReason(new Error('')) === 'unknown');
check('caps length to keep the dimension low-cardinality',
  errorReason('y'.repeat(200)).length === 60);

// ── Timing ──────────────────────────────────────────────────────────────────

console.log('\nTiming');

check('stopwatch splits measure between marks, elapsed measures from the start', (() => {
  let now = 1000;
  const w = createStopwatch(() => now);
  now = 1500;
  const audio = w.split('audio');
  now = 1900;
  const video = w.split('video');
  return audio === 500 && video === 400 && w.elapsed() === 900
    && w.splits().audio === 500 && w.splits().video === 400;
})());

check('daysBetween floors and never goes negative',
  daysBetween('2026-08-01T00:00:00Z', '2026-08-08T23:00:00Z') === 7 &&
  daysBetween('2026-08-08T00:00:00Z', '2026-08-01T00:00:00Z') === 0 &&
  daysBetween('nonsense', '2026-08-08T00:00:00Z') === 0);

// ── Result ──────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} failing check(s)`);
  process.exit(1);
}
console.log('\nAll analytics checks passed.');
