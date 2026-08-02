import type { PracticeEvaluation, AttemptResult } from './practiceEvaluator';

export interface HoldAttempt {
  durationSeconds: number;
  /** Fraction of the hold's frames within centsThreshold of center. */
  fractionInTolerance: number;
  meanCentsDeviation: number;
  confidence: number;
  /** Offsets into the take's recorded audio, so this hold can be replayed on its own. */
  startTimeSeconds?: number;
  endTimeSeconds?: number;
}

/** Judges each continuous hold on its own stability, instead of a cross-attempt streak. */
export function evaluateHold(
  attempts: HoldAttempt[],
  opts: {
    centsThreshold: number;
    minDurationSeconds: number;
    minFractionInTolerance: number;
    requiredSuccesses: number;
    minConfidence?: number;
  },
): PracticeEvaluation {
  const minConfidence = opts.minConfidence ?? 0.5;
  let successCount = 0;
  let lastFail: HoldAttempt | null = null;
  const attemptResults: AttemptResult[] = [];

  for (const attempt of attempts) {
    const good =
      attempt.confidence >= minConfidence &&
      attempt.durationSeconds >= opts.minDurationSeconds &&
      attempt.fractionInTolerance >= opts.minFractionInTolerance;
    attemptResults.push({
      passed: good,
      centsDeviation: attempt.meanCentsDeviation,
      startTimeSeconds: attempt.startTimeSeconds,
      endTimeSeconds: attempt.endTimeSeconds,
    });
    if (good) successCount += 1;
    else lastFail = attempt;
  }

  const passed = successCount >= opts.requiredSuccesses;
  return {
    passed,
    attempts: attempts.length,
    successCount,
    bestStreak: successCount,
    feedback: passed ? holdPassFeedback(successCount, attempts) : holdFailFeedback(lastFail, opts),
    attemptResults,
  };
}

function holdPassFeedback(successCount: number, attempts: HoldAttempt[]): string {
  const allClean = attempts.every((a) => a.fractionInTolerance >= 0.95);
  return allClean
    ? 'Nice, that held steady!'
    : `Passed: ${successCount} steady holds — a touch of wobble but well within range.`;
}

function holdFailFeedback(
  fail: HoldAttempt | null,
  opts: { centsThreshold: number; minDurationSeconds: number; minFractionInTolerance: number; requiredSuccesses: number },
): string {
  if (!fail) return `Need ${opts.requiredSuccesses} steady hold${opts.requiredSuccesses === 1 ? '' : 's'} of at least ${opts.minDurationSeconds}s each.`;
  if (fail.confidence < 0.5) return 'Pitch confidence was low — hold the note longer with a clear, sustained tone.';
  if (fail.durationSeconds < opts.minDurationSeconds) {
    return `That hold was too short (${fail.durationSeconds.toFixed(1)}s) — aim for at least ${opts.minDurationSeconds}s.`;
  }
  // Credit real progress instead of a flat miss when the hold was close.
  if (fail.fractionInTolerance >= 0.5) {
    const pct = Math.round(fail.fractionInTolerance * 100);
    return `Good job — that was close! ${pct}% of the hold was steady, aim for ${Math.round(opts.minFractionInTolerance * 100)}%.`;
  }
  const direction = fail.meanCentsDeviation < 0 ? 'flat' : 'sharp';
  return `Drifted ${direction} by ~${Math.round(Math.abs(fail.meanCentsDeviation))}¢ — settle the finger before starting the bow.`;
}
