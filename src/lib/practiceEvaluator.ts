export interface PitchAttempt {
  centsDeviation: number;
  confidence: number;
  toneScore?: number;
  /** Offsets into the take's recorded audio, so this attempt can be replayed on its own. */
  startTimeSeconds?: number;
  endTimeSeconds?: number;
}

export interface VibratoAttempt {
  rateHz: number;
  depthCents: number;
  confidence: number;
  durationSeconds: number;
  /** Whether any oscillation was found at all. Absent on older callers. */
  detected?: boolean;
}

export interface BowControlSample {
  value: number | null;
  confidence: number;
}

export interface AttemptResult {
  passed: boolean;
  centsDeviation?: number;
  /** Signed ms offset from the expected click. Negative = early/rushed, positive = late/dragged. */
  offsetMs?: number;
  /** Expected note name for this attempt, e.g. a scale degree. Blank for single-target exercises. */
  label?: string;
  /** Note actually heard. Lets a wrong note be named rather than reported as a
   *  huge cents figure, which is meaningless past about a semitone. */
  heardNoteName?: string;
  /** Offsets into the take's recorded audio, so this attempt can be replayed on its own. */
  startTimeSeconds?: number;
  endTimeSeconds?: number;
}

export interface PracticeEvaluation {
  passed: boolean;
  attempts: number;
  successCount: number;
  bestStreak: number;
  feedback: string;
  attemptResults?: AttemptResult[];
  /** Holistic 0-100 breakdown for paced sequence drills. See sequenceScore.ts. */
  score?: import('./sequenceScore').SequenceScore;
}

export function evaluatePitchLanding(
  attempts: PitchAttempt[],
  opts: { centsThreshold: number; requiredStreak: number; minConfidence?: number },
): PracticeEvaluation {
  const minConfidence = opts.minConfidence ?? 0.55;
  let streak = 0;
  let bestStreak = 0;
  let successCount = 0;
  let lastMiss: PitchAttempt | null = null;
  const attemptResults: AttemptResult[] = [];

  for (const attempt of attempts) {
    const good =
      attempt.confidence >= minConfidence &&
      Math.abs(attempt.centsDeviation) <= opts.centsThreshold &&
      (attempt.toneScore == null || attempt.toneScore >= 0.45);
    attemptResults.push({
      passed: good,
      centsDeviation: attempt.centsDeviation,
      startTimeSeconds: attempt.startTimeSeconds,
      endTimeSeconds: attempt.endTimeSeconds,
    });
    if (good) {
      streak += 1;
      successCount += 1;
      bestStreak = Math.max(bestStreak, streak);
    } else {
      streak = 0;
      lastMiss = attempt;
    }
  }

  const passed = bestStreak >= opts.requiredStreak;
  const feedback = passed
    ? `Passed: ${bestStreak} accurate landings in a row.`
    : pitchMissFeedback(lastMiss, opts.centsThreshold, bestStreak, opts.requiredStreak);

  return { passed, attempts: attempts.length, successCount, bestStreak, feedback, attemptResults };
}

function pitchMissFeedback(
  miss: PitchAttempt | null,
  threshold: number,
  bestStreak: number,
  requiredStreak: number,
): string {
  // Credit real progress instead of a flat "try again" — the player did land
  // it, just not enough times in a row yet.
  if (bestStreak > 0) {
    const remaining = requiredStreak - bestStreak;
    return `Good job — you're landing it! Best streak ${bestStreak}/${requiredStreak}. ${remaining} more in a row to pass.`;
  }
  if (!miss) return `Need ${requiredStreak} accurate landings in a row — give it a clean, confident attack.`;
  if (miss.confidence < 0.55) return 'Pitch confidence was low. Play one clear note at a time and reduce background noise.';
  const direction = miss.centsDeviation < 0 ? 'flat' : 'sharp';
  return `Still ${direction} by ${Math.round(Math.abs(miss.centsDeviation))} cents. Target is within +/-${threshold}.`;
}

export function evaluateVibrato(
  attempts: VibratoAttempt[],
  opts: {
    minRateHz?: number;
    maxRateHz?: number;
    minDepthCents?: number;
    maxDepthCents?: number;
    minDurationSeconds?: number;
    requiredSuccesses: number;
  },
): PracticeEvaluation {
  const minRate = opts.minRateHz ?? 4;
  const maxRate = opts.maxRateHz ?? 7;
  const minDepth = opts.minDepthCents ?? 8;
  const maxDepth = opts.maxDepthCents ?? 45;
  const minDuration = opts.minDurationSeconds ?? 5;
  let successCount = 0;
  let streak = 0;
  let bestStreak = 0;
  let last: VibratoAttempt | null = null;

  for (const attempt of attempts) {
    const good =
      attempt.confidence >= 0.45 &&
      attempt.durationSeconds >= minDuration &&
      attempt.rateHz >= minRate &&
      attempt.rateHz <= maxRate &&
      attempt.depthCents >= minDepth &&
      attempt.depthCents <= maxDepth;
    if (good) {
      successCount += 1;
      streak += 1;
      bestStreak = Math.max(bestStreak, streak);
    } else {
      streak = 0;
      last = attempt;
    }
  }

  const passed = successCount >= opts.requiredSuccesses;
  return {
    passed,
    attempts: attempts.length,
    successCount,
    bestStreak,
    feedback: passed
      ? `Passed: ${successCount} controlled vibrato holds.`
      : vibratoFeedback(last, minRate, maxRate, minDepth, minDuration, successCount, opts.requiredSuccesses),
  };
}

export function evaluateBowControl(
  samples: BowControlSample[],
  opts: { minValue: number; maxValue: number; requiredGoodFraction: number; minConfidence?: number },
): PracticeEvaluation {
  const minConfidence = opts.minConfidence ?? 0.45;
  const usable = samples.filter((sample) => sample.value !== null && sample.confidence >= minConfidence);
  if (usable.length === 0) {
    return {
      passed: false,
      attempts: 0,
      successCount: 0,
      bestStreak: 0,
      feedback: 'Camera tracking was not confident enough to judge this bow exercise.',
    };
  }

  let successCount = 0;
  let streak = 0;
  let bestStreak = 0;
  for (const sample of usable) {
    const value = sample.value!;
    const good = value >= opts.minValue && value <= opts.maxValue;
    if (good) {
      successCount += 1;
      streak += 1;
      bestStreak = Math.max(bestStreak, streak);
    } else {
      streak = 0;
    }
  }

  const fraction = successCount / usable.length;
  const passed = fraction >= opts.requiredGoodFraction;
  return {
    passed,
    attempts: usable.length,
    successCount,
    bestStreak,
    feedback: passed
      ? `Passed: ${Math.round(fraction * 100)}% of tracked frames were in range.`
      : bowControlMissFeedback(fraction, opts.requiredGoodFraction),
  };
}

function bowControlMissFeedback(fraction: number, requiredFraction: number): string {
  const pct = Math.round(fraction * 100);
  const requiredPct = Math.round(requiredFraction * 100);
  if (fraction > 0) {
    return `Good progress — ${pct}% of the take was in range (need ${requiredPct}%). Keep the motion steady through the whole stroke.`;
  }
  return `Keep the bow target steadier: ${pct}% in range, target ${requiredPct}%.`;
}

function vibratoFeedback(
  last: VibratoAttempt | null,
  minRate: number,
  maxRate: number,
  minDepth: number,
  minDuration: number,
  successCount: number,
  requiredSuccesses: number,
): string {
  if (successCount > 0) {
    const remaining = requiredSuccesses - successCount;
    return `Good job — ${successCount} controlled vibrato hold${successCount === 1 ? '' : 's'} so far! ${remaining} more to pass.`;
  }
  if (!last) return 'Need more sustained attempts before judging vibrato.';
  if (last.confidence < 0.45) return 'Vibrato confidence was low. Hold the note longer with a clearer pitch center.';
  if (last.durationSeconds < minDuration) return `Hold the note for at least ${minDuration}s before judging vibrato.`;
  // No oscillation at all — reporting that as a rate or depth fault ("too slow at 0.0 Hz")
  // would tell the player to adjust a motion they never made.
  if (last.detected === false || last.rateHz === 0) {
    return `No vibrato came through — start a slow, even wrist rock on the held note, about ${minRate} swings per second.`;
  }
  if (last.rateHz < minRate) return `Vibrato is too slow at ${last.rateHz.toFixed(1)} Hz. Aim for ${minRate}-${maxRate} Hz.`;
  if (last.rateHz > maxRate) return `Vibrato is too fast at ${last.rateHz.toFixed(1)} Hz. Relax the motion.`;
  if (last.depthCents < minDepth) return `Vibrato is shallow at ${Math.round(last.depthCents)} cents. Let the pitch wave widen slightly.`;
  return 'Vibrato shape is close. Repeat until the motion stays continuous through the bow.';
}
