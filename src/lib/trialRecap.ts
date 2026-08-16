/**
 * The message that goes out shortly before a trial converts.
 *
 * Pure and dependency-free (no expo, no zustand) so the copy rules are
 * unit-testable in plain Node, matching the convention in entitlements.ts.
 *
 * ── Why this leads with progress, not billing ───────────────
 *
 * A pure "you will be charged in two days" notice is an invitation to cancel:
 * it puts the price in front of someone who has not been asked to remember what
 * they got for it. Leading with what they actually did — sessions recorded,
 * score moved — and mentioning billing second gives them the other half of the
 * decision. The billing line still has to be there, and has to be unambiguous;
 * hiding it is both a dark pattern and a refund request waiting to happen.
 *
 * Every number here comes from real recorded sessions. When there aren't any,
 * the copy says so plainly rather than inventing encouragement — a message
 * congratulating someone on progress they didn't make is worse than silence.
 */

/** Days before the trial converts that the recap fires. */
export const RECAP_LEAD_DAYS = 2;

/** Enough sessions for a first-half/second-half comparison to mean anything. */
const MIN_SESSIONS_FOR_TREND = 4;

/** Score movement below this is noise, not improvement. */
const MIN_MEANINGFUL_DELTA = 2;

export interface TrialRecapStats {
  /** Sessions recorded since the trial began, most recent first. */
  scores: number[];
  /** Consecutive days practised, as shown on the home screen. */
  streak: number;
  /** Days until the subscription begins, at the moment the message fires. */
  daysLeft: number;
}

export interface TrialRecapContent {
  title: string;
  body: string;
}

/**
 * Average score improvement across the trial, or null when there isn't enough
 * to say. Compares the first half of the trial against the second rather than
 * first-session-vs-last, which on a noisy metric is mostly luck.
 */
export function scoreImprovement(scores: number[]): number | null {
  if (scores.length < MIN_SESSIONS_FOR_TREND) return null;
  // `scores` arrives newest-first; compare oldest half against newest half.
  const chronological = [...scores].reverse();
  const mid = Math.floor(chronological.length / 2);
  const early = chronological.slice(0, mid);
  const late = chronological.slice(chronological.length - mid);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const delta = Math.round(mean(late) - mean(early));
  return Math.abs(delta) >= MIN_MEANINGFUL_DELTA ? delta : null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function buildTrialRecap({ scores, streak, daysLeft }: TrialRecapStats): TrialRecapContent {
  const dayWord = daysLeft === 1 ? 'Tomorrow' : `${daysLeft} days left`;
  const billing =
    daysLeft === 1
      ? 'Your subscription starts tomorrow — cancel any time before then.'
      : `Your subscription starts in ${plural(daysLeft, 'day')} — cancel any time before then.`;

  // Nothing recorded. Say that, and give them the one thing that would change
  // it. Claiming progress here would be a straightforward lie.
  if (scores.length === 0) {
    return {
      title: daysLeft === 1 ? 'Your trial ends tomorrow' : `${dayWord} on your trial`,
      body: `You haven't recorded a session yet. One take is about twenty seconds, and it's the whole point of the app. ${billing}`,
    };
  }

  const sessionsLine = `You've recorded ${plural(scores.length, 'session')}`;
  const delta = scoreImprovement(scores);

  const achievement =
    delta !== null && delta > 0
      ? `${sessionsLine} and your average score is up ${delta} points.`
      : streak >= 3
        ? `${sessionsLine}, ${streak} days in a row.`
        : `${sessionsLine}.`;

  return {
    title: daysLeft === 1 ? 'Your trial ends tomorrow' : `${dayWord} on your trial`,
    body: `${achievement} ${billing}`,
  };
}

/**
 * When the recap should fire: RECAP_LEAD_DAYS before conversion, but never in
 * the past and never so close to the end that it arrives after the charge.
 * Returns null when the trial converts too soon for the message to be useful.
 */
export function recapFireDate(trialEndsAt: Date, now: Date = new Date()): Date | null {
  const fireAt = new Date(trialEndsAt.getTime() - RECAP_LEAD_DAYS * 86_400_000);
  if (fireAt.getTime() <= now.getTime()) return null;
  return fireAt;
}

/** Whole days from `now` to `trialEndsAt`, rounded up — what the copy says. */
export function daysUntil(trialEndsAt: Date, now: Date): number {
  const ms = trialEndsAt.getTime() - now.getTime();
  return Math.max(1, Math.ceil(ms / 86_400_000));
}
