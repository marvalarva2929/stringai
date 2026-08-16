/**
 * When to ask for an App Store review.
 *
 * Pure and dependency-free (no zustand, no expo modules) so the rules can be
 * unit-tested in plain Node, matching the convention in entitlements.ts /
 * practiceProgress.ts.
 *
 * The prompt is *gated*: the app shows its own "Enjoying StringAI?" question
 * first and only fires the native dialog on a positive answer. That matters
 * because iOS caps `SKStoreReviewController` at three prompts per year per
 * user — spending one on someone who is about to leave a one-star review is
 * the worst possible trade. Everything here exists to spend those three well.
 */

export type ReviewTrigger =
  /**
   * Just subscribed — a trial start, or a direct purchase by someone already
   * ineligible for one. The first moment worth asking at: by here the user has
   * recorded a real take, seen their own analysis, walked a practice plan, and
   * chosen to pay. Asking during activation instead — as this used to — spent
   * one of three annual prompts on someone who had not converted, and asked
   * for an endorsement moments before charging them.
   */
  | 'subscribed'
  /** Cleared a practice plan (returning user). */
  | 'practice_complete'
  /** Hit a streak milestone. */
  | 'streak_milestone';

export type ReviewOutcome =
  | 'none'      // never answered
  | 'rated'     // said yes — native dialog was offered
  | 'declined'  // said no and didn't leave feedback
  | 'feedback'; // said no and told us why

export interface ReviewState {
  promptCount: number;
  /** ISO timestamp of the last time we asked, or null. */
  lastPromptedAt: string | null;
  outcome: ReviewOutcome;
}

/** Apple's own limit. Asking past it is silently a no-op, so never spend a turn on it. */
export const MAX_PROMPTS_PER_YEAR = 3;

/** Long enough that a second ask reads as "have things improved?" not as nagging. */
export const MIN_DAYS_BETWEEN_PROMPTS = 60;

/**
 * Recorded sessions required before an organic trigger may ask. `subscribed`
 * is exempt: paying is itself the strongest signal of a positive opinion, and
 * the diagnostic take that precedes it may not have been written to session
 * history yet (it isn't persisted until the account exists).
 */
export const MIN_SESSIONS_FOR_ORGANIC_PROMPT = 3;

export const DAY_MS = 86_400_000;

export const initialReviewState = (): ReviewState => ({
  promptCount: 0,
  lastPromptedAt: null,
  outcome: 'none',
});

/** Whole days since the last prompt. Infinity when we've never asked. */
export function daysSinceLastPrompt(state: ReviewState, now: Date = new Date()): number {
  if (!state.lastPromptedAt) return Infinity;
  const then = new Date(state.lastPromptedAt).getTime();
  if (Number.isNaN(then)) return Infinity;
  return Math.max(0, (now.getTime() - then) / DAY_MS);
}

export interface ShouldPromptOpts {
  now?: Date;
  /** Recorded analysis sessions the user has. Ignored for `subscribed`. */
  sessionCount: number;
  trigger: ReviewTrigger;
}

export function shouldPromptForReview(
  state: ReviewState,
  { now = new Date(), sessionCount, trigger }: ShouldPromptOpts,
): boolean {
  // Answering is terminal in both directions. Someone who rated has nothing
  // left to give; someone who declined has already told us no.
  if (state.outcome === 'rated' || state.outcome === 'declined') return false;

  if (state.promptCount >= MAX_PROMPTS_PER_YEAR) return false;
  if (daysSinceLastPrompt(state, now) < MIN_DAYS_BETWEEN_PROMPTS) return false;

  if (trigger !== 'subscribed' && sessionCount < MIN_SESSIONS_FOR_ORGANIC_PROMPT) {
    return false;
  }

  return true;
}

/** State after we've shown the prompt (regardless of what the user then says). */
export function recordPrompted(state: ReviewState, now: Date = new Date()): ReviewState {
  return {
    ...state,
    promptCount: state.promptCount + 1,
    lastPromptedAt: now.toISOString(),
  };
}
