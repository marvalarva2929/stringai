/**
 * User-property construction and GA4 payload sanitisation.
 *
 * Dependency-free on purpose — no React, no Firebase, no stores — so it runs
 * under the repo's Node test harness (`test/analyticsUserProps.test.ts`) the
 * same way `lib/streak.ts` and `lib/entitlements.ts` do.
 *
 * Two jobs:
 *
 *  1. Turn a snapshot of the app's stores into the ~19 user properties every
 *     event is sliced by. Continuous values (streak length, session count) are
 *     *bucketed* rather than passed through: GA4 user properties are strings,
 *     capped at 25 per property and 36 characters per value, and a dimension
 *     with 400 distinct values is useless for segmentation.
 *
 *  2. Enforce GA4's silent limits. The SDK accepts an over-long event name or a
 *     26th parameter and then drops the event with no error on any surface, so
 *     truncation has to happen before the call, not after a report comes back
 *     empty.
 */

import { GA4_LIMITS, SESSION_COUNT_BUCKETS, STREAK_BUCKETS } from '../constants/analyticsEvents';

/** What GA4 accepts as an event parameter value. Arrays survive for `items`. */
export type AnalyticsParamValue = string | number | boolean | object[] | undefined | null;
export type AnalyticsParams = Record<string, AnalyticsParamValue>;

/**
 * A flat read of the stores at one instant. The caller assembles this; keeping
 * it a plain object is what makes the module testable.
 */
export interface AnalyticsUserSnapshot {
  tier: 'free' | 'pro';
  inTrial: boolean;
  isAuthenticated: boolean;
  skillLevel?: string | null;
  playerCategory?: string | null;
  learningGoal?: string | null;
  dailyTime?: string | null;
  weeklyGoalMinutes?: number | null;
  violinSize?: string | null;
  handedness?: string | null;
  focusPreference?: string | null;
  activationStep?: string | null;
  usedDemo?: boolean;
  sessionCount?: number;
  streakDays?: number;
  remindersEnabled?: boolean;
  notifPermission?: string | null;
  attStatus?: string | null;
}

/**
 * Buckets a count into a readable range label using ascending boundaries.
 *
 * `bucketize(4, [1, 2, 5, 10, 25])` → `'2-4'`, `bucketize(0, ...)` → `'0'`,
 * `bucketize(99, ...)` → `'25+'`. Boundaries are the *inclusive lower bound* of
 * each bucket above the first.
 */
export function bucketize(value: number, boundaries: readonly number[]): string {
  if (boundaries.length === 0) return String(value);
  const n = Math.max(0, Math.floor(value));

  const first = boundaries[0];
  if (n < first) return first === 1 ? '0' : `0-${first - 1}`;

  for (let i = 0; i < boundaries.length - 1; i++) {
    const lo = boundaries[i];
    const hi = boundaries[i + 1];
    if (n < hi) return lo === hi - 1 ? `${lo}` : `${lo}-${hi - 1}`;
  }
  return `${boundaries[boundaries.length - 1]}+`;
}

/** Weekly goal in minutes → a low-cardinality label. */
export function weeklyGoalBucket(minutes: number | null | undefined): string | null {
  if (minutes == null || !Number.isFinite(minutes)) return null;
  if (minutes <= 35) return 'light';
  if (minutes <= 90) return 'steady';
  if (minutes <= 180) return 'committed';
  return 'intense';
}

/** Days away since the last app open → the `resurrected` bucket. */
export function daysAwayBucket(days: number): string {
  if (days < 2) return '0-1';
  if (days < 7) return '2-6';
  if (days < 14) return '7-13';
  if (days < 30) return '14-29';
  return '30+';
}

const bool = (v: boolean | undefined): string | null => (v == null ? null : v ? 'true' : 'false');

/**
 * Builds the full user-property map. `null` values are meaningful — Firebase
 * treats them as "clear this property", which is what we want when a user signs
 * out or an answer has not been given yet.
 */
export function buildUserProperties(s: AnalyticsUserSnapshot): Record<string, string | null> {
  return sanitizeUserProperties({
    entitlement: s.tier,
    in_trial: bool(s.inTrial),
    is_authenticated: bool(s.isAuthenticated),
    skill_level: s.skillLevel ?? null,
    player_category: s.playerCategory ?? null,
    learning_goal: s.learningGoal ?? null,
    daily_time: s.dailyTime ?? null,
    weekly_goal_min: weeklyGoalBucket(s.weeklyGoalMinutes),
    violin_size: s.violinSize ?? null,
    handedness: s.handedness ?? null,
    focus_pref: s.focusPreference ?? null,
    activation_step: s.activationStep ?? null,
    used_demo: bool(s.usedDemo),
    session_count_bkt:
      s.sessionCount == null ? null : bucketize(s.sessionCount, SESSION_COUNT_BUCKETS),
    streak_bkt: s.streakDays == null ? null : bucketize(s.streakDays, STREAK_BUCKETS),
    reminders_enabled: bool(s.remindersEnabled),
    notif_permission: s.notifPermission ?? null,
    att_status: s.attStatus ?? null,
  });
}

/**
 * The subset mirrored onto Crashlytics as custom keys. A stack trace on its own
 * rarely reproduces; "free user, mid-activation on the carousel step, during
 * processing_video" usually does.
 */
export function buildCrashKeys(s: AnalyticsUserSnapshot): Record<string, string> {
  const out: Record<string, string> = {
    entitlement: s.tier,
    is_authenticated: String(!!s.isAuthenticated),
    used_demo: String(!!s.usedDemo),
  };
  if (s.activationStep) out.activation_step = s.activationStep;
  if (s.skillLevel) out.skill_level = s.skillLevel;
  if (s.sessionCount != null) out.session_count = String(s.sessionCount);
  return out;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * Drops empty values, coerces booleans to strings (GA4 has no boolean type and
 * would otherwise record them as `1`/`0` with no way to tell them from counts),
 * truncates to the documented limits, and caps the parameter count.
 */
export function sanitizeParams(params: AnalyticsParams | undefined): Record<string, string | number | object[]> {
  const out: Record<string, string | number | object[]> = {};
  if (!params) return out;

  let count = 0;
  for (const [rawKey, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (count >= GA4_LIMITS.PARAMS_PER_EVENT) break;

    const key = truncate(rawKey, GA4_LIMITS.PARAM_NAME);
    if (typeof value === 'boolean') {
      out[key] = value ? 'true' : 'false';
    } else if (typeof value === 'number') {
      // NaN/Infinity serialise as null over the bridge and drop the whole event.
      if (!Number.isFinite(value)) continue;
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value; // ecommerce `items` — passed through untouched
    } else {
      out[key] = truncate(String(value), GA4_LIMITS.PARAM_VALUE);
    }
    count++;
  }
  return out;
}

/** Same idea for user properties, which have tighter limits than event params. */
export function sanitizeUserProperties(
  props: Record<string, string | null | undefined>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  let count = 0;
  for (const [rawKey, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (count >= GA4_LIMITS.USER_PROPERTIES) break;
    const key = truncate(rawKey, GA4_LIMITS.USER_PROPERTY_NAME);
    out[key] = value === null ? null : truncate(value, GA4_LIMITS.USER_PROPERTY_VALUE);
    count++;
  }
  return out;
}

/** Reduces an arbitrary thrown value to a short, low-cardinality reason code. */
export function errorReason(err: unknown, max = 60): string {
  if (err == null) return 'unknown';
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);
  const cleaned = message.trim().replace(/\s+/g, ' ');
  return cleaned.length === 0 ? 'unknown' : truncate(cleaned, max);
}
