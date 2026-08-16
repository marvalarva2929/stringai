// ─────────────────────────────────────────────────────────────
// The record of work done.
//
// Nothing in the app previously connected "I did the exercise" to "the problem
// went away". Completed blocks were tracked, but only as a checklist keyed by
// plan — which drill, for which issue, on which piece, and whether the take
// actually passed were all thrown away the moment the player moved on.
//
// Without that link the app can measure that an issue improved but never claim
// its advice had anything to do with it. This is the missing join.
//
// Pure and dependency-free so it runs under the Node test harness; the zustand
// wrapper is in ../store/usePracticeAttemptStore.ts.
// ─────────────────────────────────────────────────────────────

export interface PracticeAttempt {
  /** ISO timestamp of the take. */
  at: string;
  planId: string;
  blockId: string;
  /** The block's family, e.g. 'crossing_wave'. */
  blockType: string;
  /** Human-readable drill name, so history reads without a lookup table. */
  blockTitle: string;
  /**
   * Content-based issue ids this drill was prescribed for (PracticeEvidence.id).
   * Timestamp-free by construction, so the same problem next week matches — see
   * musicalMoments.ts.
   */
  issueIds: string[];
  /** The piece being worked on, which is how Act 3 scopes everything. */
  pieceId?: string;
  /** Absent when the drill was self-reported rather than machine-judged. */
  passed?: boolean;
  /** Attempts that met their criterion, out of those judged. */
  successCount?: number;
  attempts?: number;
  /** 0-100 holistic score for paced drills. The number worth watching over time. */
  score?: number;
}

/** Attempts older than the newest this many are dropped. */
export const MAX_TRACKED_ATTEMPTS = 400;

/**
 * Append an attempt, newest-first, trimming the tail. Append-only on purpose:
 * a retaken drill is two attempts, and the fact that it took two is itself the
 * interesting signal.
 */
export function recordAttempt(
  attempts: PracticeAttempt[],
  attempt: PracticeAttempt,
  max: number = MAX_TRACKED_ATTEMPTS,
): PracticeAttempt[] {
  return [attempt, ...attempts].slice(0, max);
}

/** Every attempt made against a given issue, newest-first. */
export function attemptsForIssue(attempts: PracticeAttempt[], issueId: string): PracticeAttempt[] {
  return attempts.filter((a) => a.issueIds.includes(issueId));
}

/** Every attempt made while working on a given piece, newest-first. */
export function attemptsForPiece(attempts: PracticeAttempt[], pieceId: string): PracticeAttempt[] {
  return attempts.filter((a) => a.pieceId === pieceId);
}

export interface AttemptTally {
  total: number;
  passed: number;
  /** Distinct calendar days the player worked on it — effort over time. */
  days: number;
}

export interface ScoreHistory {
  /** Oldest-first scores for one drill. */
  scores: number[];
  best: number;
  latest: number;
  /** Latest minus the first recorded score; null until there are two. */
  improvement: number | null;
}

/**
 * Score history for one drill, oldest-first.
 *
 * Keyed on blockId, which is content-based (`crossing_wave:figure_crossing:A-D`,
 * `staple:scale:G major`), so the same drill matches across sessions and weeks —
 * which is the whole point of scoring instead of pass/fail.
 */
export function scoreHistoryFor(attempts: PracticeAttempt[], blockId: string): ScoreHistory | null {
  const scores = attempts
    .filter((a) => a.blockId === blockId && typeof a.score === 'number')
    .map((a) => a.score!)
    .reverse(); // store is newest-first; a trend reads oldest-first
  if (scores.length === 0) return null;
  return {
    scores,
    best: Math.max(...scores),
    latest: scores[scores.length - 1],
    improvement: scores.length >= 2 ? scores[scores.length - 1] - scores[0] : null,
  };
}

export function tallyAttempts(attempts: PracticeAttempt[]): AttemptTally {
  const days = new Set(attempts.map((a) => a.at.slice(0, 10)));
  return {
    total: attempts.length,
    passed: attempts.filter((a) => a.passed === true).length,
    days: days.size,
  };
}
