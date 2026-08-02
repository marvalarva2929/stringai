import type { PracticeEvaluation, AttemptResult } from './practiceEvaluator';

export interface RhythmAttempt {
  /** Signed ms offset between the detected attack and its expected click, or
   *  null when no attack was detected near that click at all. */
  offsetMs: number | null;
  confidence: number;
  startTimeSeconds?: number;
  endTimeSeconds?: number;
}

/** Judges each click-track beat by how close the player's attack landed to it. */
export function evaluateRhythm(
  attempts: RhythmAttempt[],
  opts: { toleranceMs: number; requiredOnTimeFraction: number; minConfidence?: number },
): PracticeEvaluation {
  const minConfidence = opts.minConfidence ?? 0.45;
  let onTimeCount = 0;
  let streak = 0;
  let bestStreak = 0;
  let lastMiss: RhythmAttempt | null = null;
  const attemptResults: AttemptResult[] = [];

  for (const attempt of attempts) {
    const detected = attempt.offsetMs != null && attempt.confidence >= minConfidence;
    const onTime = detected && Math.abs(attempt.offsetMs!) <= opts.toleranceMs;
    attemptResults.push({
      passed: onTime,
      offsetMs: detected ? attempt.offsetMs! : undefined,
      startTimeSeconds: attempt.startTimeSeconds,
      endTimeSeconds: attempt.endTimeSeconds,
    });
    if (onTime) {
      onTimeCount += 1;
      streak += 1;
      bestStreak = Math.max(bestStreak, streak);
    } else {
      streak = 0;
      lastMiss = attempt;
    }
  }

  const judged = attempts.length;
  const fraction = judged > 0 ? onTimeCount / judged : 0;
  const passed = judged > 0 && fraction >= opts.requiredOnTimeFraction;

  return {
    passed,
    attempts: judged,
    successCount: onTimeCount,
    bestStreak,
    feedback: passed
      ? rhythmPassFeedback(onTimeCount, judged)
      : rhythmMissFeedback(lastMiss, fraction, opts.requiredOnTimeFraction, opts.toleranceMs),
    attemptResults,
  };
}

function rhythmPassFeedback(onTimeCount: number, judged: number): string {
  return onTimeCount === judged
    ? 'Locked to the click the whole way through.'
    : `Passed: ${onTimeCount} of ${judged} clicks landed on time.`;
}

function rhythmMissFeedback(
  miss: RhythmAttempt | null,
  fraction: number,
  requiredFraction: number,
  toleranceMs: number,
): string {
  const pct = Math.round(fraction * 100);
  const requiredPct = Math.round(requiredFraction * 100);
  if (fraction > 0) {
    return `Good job — ${pct}% of clicks landed on time (need ${requiredPct}%). Keep going, within ${toleranceMs}ms of the click.`;
  }
  if (!miss || miss.offsetMs == null) {
    return 'No clear attack detected near the clicks — play one confident note right on each click.';
  }
  const direction = miss.offsetMs < 0 ? 'ahead of' : 'behind';
  return `Landing ${direction} the click by about ${Math.round(Math.abs(miss.offsetMs))}ms. Aim to land right on it.`;
}
