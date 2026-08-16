import type { PracticeEvaluation, AttemptResult } from './practiceEvaluator';

// ─────────────────────────────────────────────────────────────
// Trill evaluator.
//
// A trill is not judged on pitch accuracy — a fast alternation smears the
// detector's reading of every note in it, and a player whose trill is perfectly
// even can still miss a cents threshold on all of it. What actually matters is
// what a teacher listens for:
//
//   count     — did you play the number of alternations you were asked for
//   evenness  — were the gaps between them the same length
//   shape     — did the two pitches stay distinct instead of collapsing together
//
// So this measures the *rhythm* of the alternation and the interval between the
// two pitches, and says nothing about absolute intonation. Claiming otherwise
// would be measuring noise and reporting it as a fault.
// ─────────────────────────────────────────────────────────────

export interface TrillAttempt {
  /** Onset times of the alternating notes, seconds from take start. */
  onsetTimes: number[];
  /** Median detected pitch of each note, Hz. Nulls are unvoiced/unclear. */
  medianFreqs: (number | null)[];
  startTimeSeconds?: number;
  endTimeSeconds?: number;
}

export interface TrillEvaluatorOptions {
  /** How many alternations the drill asked for. */
  requiredAlternations: number;
  /** Semitones between the two trill notes (1 = half step, 2 = whole step). */
  intervalSemitones: number;
  /**
   * Max coefficient of variation of the inter-onset gaps. 0.25 lets a human
   * trill breathe; below ~0.15 is metronomic in a way real trills aren't.
   */
  maxGapCv: number;
}

/** A trill that lost the interval isn't a trill, it's a repeated note. */
const MIN_INTERVAL_RATIO = 0.5;

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function centsBetween(a: number, b: number): number {
  return Math.abs(1200 * Math.log2(a / b));
}

export function evaluateTrill(
  attempt: TrillAttempt | null,
  opts: TrillEvaluatorOptions,
): PracticeEvaluation {
  if (!attempt || attempt.onsetTimes.length < 2) {
    return {
      passed: false,
      attempts: 0,
      successCount: 0,
      bestStreak: 0,
      feedback: 'No trill was detected — play the two notes alternating, clearly enough for each one to speak.',
    };
  }

  const { onsetTimes } = attempt;
  const gaps: number[] = [];
  for (let i = 1; i < onsetTimes.length; i++) gaps.push(onsetTimes[i] - onsetTimes[i - 1]);

  const alternations = gaps.length;
  const gapMean = mean(gaps);
  const gapSd = Math.sqrt(mean(gaps.map((g) => (g - gapMean) ** 2)));
  const gapCv = gapMean > 0 ? gapSd / gapMean : 1;

  // Each gap is an "attempt": was this alternation the same length as the rest?
  const attemptResults: AttemptResult[] = gaps.map((gap, i) => {
    const deviation = gapMean > 0 ? Math.abs(gap - gapMean) / gapMean : 1;
    return {
      passed: deviation <= opts.maxGapCv,
      label: `alt ${i + 1}`,
      startTimeSeconds: onsetTimes[i],
      endTimeSeconds: onsetTimes[i + 1],
    };
  });
  const evenCount = attemptResults.filter((r) => r.passed).length;

  // Did the two pitches stay apart? Compare alternate notes against each other.
  const voiced = attempt.medianFreqs.filter((f): f is number => f != null && f > 0);
  const lower = voiced.filter((_, i) => i % 2 === 0);
  const upper = voiced.filter((_, i) => i % 2 === 1);
  const measuredCents = lower.length > 0 && upper.length > 0
    ? centsBetween(mean(upper), mean(lower))
    : null;
  const expectedCents = opts.intervalSemitones * 100;
  const intervalHeld = measuredCents == null
    ? true // Not measurable at speed — don't fail a player on a reading we don't have.
    : measuredCents >= expectedCents * MIN_INTERVAL_RATIO;

  const enough = alternations >= opts.requiredAlternations;
  const even = gapCv <= opts.maxGapCv;
  const passed = enough && even && intervalHeld;

  let feedback: string;
  if (passed) {
    feedback = `Passed: ${alternations} even alternations at about ${(1 / gapMean).toFixed(1)} notes a second.`;
  } else if (!enough) {
    feedback = `Only ${alternations} alternation${alternations === 1 ? '' : 's'} came through — the drill asks for ${opts.requiredAlternations}. Keep the fingers closer to the string so every note speaks.`;
  } else if (!intervalHeld) {
    feedback = measuredCents != null
      ? `The two notes drifted together — about ${Math.round(measuredCents)}¢ apart instead of ${expectedCents}. The trilling finger isn't fully lifting.`
      : 'The two notes ran together. Lift the trilling finger clear of the string between alternations.';
  } else {
    feedback = `${evenCount} of ${alternations} alternations were even, but the rest stretched or rushed. Slow the trill until every gap matches, then rebuild the speed.`;
  }

  return {
    passed,
    attempts: alternations,
    successCount: evenCount,
    bestStreak: longestRun(attemptResults),
    feedback,
    attemptResults,
  };
}

function longestRun(results: AttemptResult[]): number {
  let best = 0;
  let current = 0;
  for (const result of results) {
    current = result.passed ? current + 1 : 0;
    if (current > best) best = current;
  }
  return best;
}
