export interface PitchAttempt {
  centsDeviation: number;
  confidence: number;
  toneScore?: number;
}

export interface VibratoAttempt {
  rateHz: number;
  depthCents: number;
  confidence: number;
  durationSeconds: number;
}

export interface BowControlSample {
  value: number | null;
  confidence: number;
}

export interface PracticeEvaluation {
  passed: boolean;
  attempts: number;
  successCount: number;
  bestStreak: number;
  feedback: string;
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

  for (const attempt of attempts) {
    const good =
      attempt.confidence >= minConfidence &&
      Math.abs(attempt.centsDeviation) <= opts.centsThreshold &&
      (attempt.toneScore == null || attempt.toneScore >= 0.45);
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

  return { passed, attempts: attempts.length, successCount, bestStreak, feedback };
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
      : vibratoFeedback(last, minRate, maxRate, minDepth, minDuration),
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
      attempts: samples.length,
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
      : `Keep the bow target steadier: ${Math.round(fraction * 100)}% in range, target ${Math.round(opts.requiredGoodFraction * 100)}%.`,
  };
}

function pitchMissFeedback(
  miss: PitchAttempt | null,
  threshold: number,
  bestStreak: number,
  requiredStreak: number,
): string {
  if (!miss) return `Need ${requiredStreak} accurate landings in a row. Best streak: ${bestStreak}.`;
  if (miss.confidence < 0.55) return 'Pitch confidence was low. Play one clear note at a time and reduce background noise.';
  const direction = miss.centsDeviation < 0 ? 'flat' : 'sharp';
  return `Still ${direction} by ${Math.round(Math.abs(miss.centsDeviation))} cents. Target is within +/-${threshold}; best streak ${bestStreak}/${requiredStreak}.`;
}

function vibratoFeedback(
  last: VibratoAttempt | null,
  minRate: number,
  maxRate: number,
  minDepth: number,
  minDuration: number,
): string {
  if (!last) return 'Need more sustained attempts before judging vibrato.';
  if (last.confidence < 0.45) return 'Vibrato confidence was low. Hold the note longer with a clearer pitch center.';
  if (last.durationSeconds < minDuration) return `Hold the note for at least ${minDuration}s before judging vibrato.`;
  if (last.rateHz < minRate) return `Vibrato is too slow at ${last.rateHz.toFixed(1)} Hz. Aim for ${minRate}-${maxRate} Hz.`;
  if (last.rateHz > maxRate) return `Vibrato is too fast at ${last.rateHz.toFixed(1)} Hz. Relax the motion.`;
  if (last.depthCents < minDepth) return `Vibrato is shallow at ${Math.round(last.depthCents)} cents. Let the pitch wave widen slightly.`;
  return 'Vibrato shape is close. Repeat until the motion stays continuous through the bow.';
}
