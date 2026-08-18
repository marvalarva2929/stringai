import type { PracticeEvaluation, AttemptResult } from './practiceEvaluator';

export interface RhythmAttempt {
  /** Signed ms offset between the detected attack and its expected click, or
   *  null when no attack was detected near that click at all. */
  offsetMs: number | null;
  confidence: number;
  startTimeSeconds?: number;
  endTimeSeconds?: number;
}

/**
 * The player's own constant lag, in ms — the median of every measured offset.
 *
 * Every stage between the click firing and a note appearing in the file adds
 * delay, all in the same direction and none of it measured: the JS timer that
 * schedules the click, the bridge hop into the audio player, speaker output
 * latency, the player's own reaction, mic input latency, and the analysis
 * window. Scoring raw offsets against a window centred on zero therefore asks
 * the player to *anticipate* a constant they cannot see — which is exactly what
 * playing to this metronome felt like.
 *
 * Musicians are judged on steadiness, not on absolute phase: a player who sits a
 * consistent 90ms behind the click is playing in time, and a player alternating
 * ±90ms is not, even though both have the same mean error. So align first, then
 * measure the spread around that alignment.
 *
 * Returns 0 when there is too little to fit, which reduces to the old behaviour.
 */
export function fitOffsetBiasMs(attempts: RhythmAttempt[], minConfidence: number): number {
  const offsets = attempts
    .filter((a) => a.offsetMs != null && a.confidence >= minConfidence)
    .map((a) => a.offsetMs!)
    .sort((a, b) => a - b);
  // With one or two attempts a "bias" is indistinguishable from being late, and
  // subtracting it would forgive genuinely bad timing.
  if (offsets.length < 3) return 0;
  const mid = Math.floor(offsets.length / 2);
  return offsets.length % 2 === 0 ? (offsets[mid - 1] + offsets[mid]) / 2 : offsets[mid];
}

/** Judges each click-track beat by how close the player's attack landed to it. */
export function evaluateRhythm(
  attempts: RhythmAttempt[],
  opts: { toleranceMs: number; requiredOnTimeFraction: number; minConfidence?: number },
): PracticeEvaluation {
  const minConfidence = opts.minConfidence ?? 0.45;
  const biasMs = fitOffsetBiasMs(attempts, minConfidence);
  let onTimeCount = 0;
  let streak = 0;
  let bestStreak = 0;
  let lastMiss: number | null = null;
  const attemptResults: AttemptResult[] = [];

  for (const attempt of attempts) {
    const detected = attempt.offsetMs != null && attempt.confidence >= minConfidence;
    // Judged on the deviation from the player's own steady placement, not from
    // an absolute zero no signal chain can actually deliver.
    const relativeMs = detected ? attempt.offsetMs! - biasMs : null;
    const onTime = relativeMs != null && Math.abs(relativeMs) <= opts.toleranceMs;
    attemptResults.push({
      passed: onTime,
      offsetMs: detected ? relativeMs! : undefined,
      startTimeSeconds: attempt.startTimeSeconds,
      endTimeSeconds: attempt.endTimeSeconds,
    });
    if (onTime) {
      onTimeCount += 1;
      streak += 1;
      bestStreak = Math.max(bestStreak, streak);
    } else {
      streak = 0;
      lastMiss = relativeMs;
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
      ? rhythmPassFeedback(onTimeCount, judged, biasMs)
      : rhythmMissFeedback(lastMiss, fraction, opts.requiredOnTimeFraction, opts.toleranceMs),
    attemptResults,
  };
}

/**
 * Below this the fitted lag is not worth mentioning — it is within the noise of
 * the signal chain, and naming it would read as a fault when it isn't one.
 */
const NOTABLE_LAG_MS = 60;

function rhythmPassFeedback(onTimeCount: number, judged: number, biasMs: number): string {
  const base = onTimeCount === judged
    ? 'Locked to the click the whole way through.'
    : `Passed: ${onTimeCount} of ${judged} clicks landed on time.`;
  // Steadiness is what passed; the constant offset is a separate, useful fact —
  // and some of it is the phone's own output latency, not the player.
  if (Math.abs(biasMs) < NOTABLE_LAG_MS) return base;
  const side = biasMs > 0 ? 'behind' : 'ahead of';
  return `${base} You sit about ${Math.round(Math.abs(biasMs))}ms ${side} the click, evenly.`;
}

function rhythmMissFeedback(
  missMs: number | null,
  fraction: number,
  requiredFraction: number,
  toleranceMs: number,
): string {
  const pct = Math.round(fraction * 100);
  const requiredPct = Math.round(requiredFraction * 100);
  if (fraction > 0) {
    return `${pct}% of clicks landed on time (need ${requiredPct}%). Aim to stay within ${toleranceMs}ms.`;
  }
  if (missMs == null) {
    return 'No clear attack detected near the clicks — play one confident note right on each click.';
  }
  const direction = missMs < 0 ? 'early' : 'late';
  return `Your notes are drifting — the worst was ${Math.round(Math.abs(missMs))}ms ${direction} relative to the rest. Steadiness matters more than being exactly on the click.`;
}
