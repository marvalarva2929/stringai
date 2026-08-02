import { midiToFreq, noteNameToMidi } from './pitchNaming';
import type { PracticeEvaluation, AttemptResult } from './practiceEvaluator';

export interface ScaleAttempt {
  medianFreqHz: number;
  confidence: number;
  /** Offsets into the take's recorded audio, so this degree can be replayed on its own. */
  startTimeSeconds?: number;
  endTimeSeconds?: number;
}

/**
 * Matches each attempt to its expected scale degree by ORDER (the metronome
 * paces one note per beat, so position i is beat i), not nearest-pitch fuzzy
 * matching — cents are measured against the actual expected note, catching a
 * wrong-note miss that nearest-chromatic-note rounding would hide.
 */
export function evaluateScale(
  attempts: ScaleAttempt[],
  expectedSequence: string[],
  opts: { centsThreshold: number; minConfidence?: number },
): PracticeEvaluation {
  const minConfidence = opts.minConfidence ?? 0.5;
  const n = Math.min(attempts.length, expectedSequence.length);
  const attemptResults: AttemptResult[] = [];
  let successCount = 0;

  for (let i = 0; i < n; i++) {
    const attempt = attempts[i];
    const expectedNote = expectedSequence[i];
    const targetMidi = noteNameToMidi(expectedNote);
    let passed = false;
    let centsDeviation: number | undefined;
    if (targetMidi != null && attempt.confidence >= minConfidence) {
      centsDeviation = 1200 * Math.log2(attempt.medianFreqHz / midiToFreq(targetMidi));
      passed = Math.abs(centsDeviation) <= opts.centsThreshold;
    }
    attemptResults.push({
      passed,
      centsDeviation,
      label: expectedNote,
      startTimeSeconds: attempt.startTimeSeconds,
      endTimeSeconds: attempt.endTimeSeconds,
    });
    if (passed) successCount += 1;
  }

  // A scale is a musical whole, not a chain of pass/fail gates: a note that's a
  // few cents shy is a good scale with something to polish, and demanding a
  // clean sweep made one slip on note 14 of 15 cost the entire take.
  //
  // But forgiveness only extends to *intonation*: a note that lands a semitone
  // out is a wrong note, and a note the detector never heard wasn't played.
  // Neither is a near miss, so neither is spent against the allowance.
  const allowedMisses = allowedMissesFor(expectedSequence.length);
  const slips = attemptResults.filter((r) => !r.passed && isIntonationSlip(r.centsDeviation)).length;
  const hardMisses = attemptResults.filter((r) => !r.passed && !isIntonationSlip(r.centsDeviation)).length;
  const lengthMismatch = attempts.length !== expectedSequence.length;
  const passed = n > 0 && !lengthMismatch && hardMisses === 0 && slips <= allowedMisses;

  const feedback = passed
    ? slips === 0
      ? `Passed: all ${n} notes landed in tune.`
      : `Passed: ${successCount} of ${n} notes clean, ${slips} a touch off — good enough to move on.`
    : lengthMismatch
      ? `Detected ${attempts.length} notes, expected ${expectedSequence.length} — make sure each note gets a clear stop before the next.${successCount > 0 ? ` Good job on the ${successCount} you nailed.` : ''}`
      : scaleMissFeedback(attemptResults, successCount, allowedMisses);

  return {
    passed,
    attempts: attempts.length,
    successCount,
    bestStreak: successCount,
    feedback,
    attemptResults,
  };
}

/** How many slightly-off notes a scale can carry and still be a good scale: ~15%, min 1. */
export function allowedMissesFor(noteCount: number): number {
  return Math.max(1, Math.round(noteCount * 0.15));
}

/**
 * Beyond this the player didn't miss the note, they played a different one —
 * half a semitone, so anything that still rounds to the intended pitch counts
 * as intonation rather than a wrong note.
 */
const WRONG_NOTE_CENTS = 50;

/** A miss that's still recognisably the right note, just not centered. */
function isIntonationSlip(centsDeviation: number | undefined): boolean {
  // Undefined = the detector never got a confident read: not a near miss.
  if (centsDeviation == null) return false;
  return Math.abs(centsDeviation) <= WRONG_NOTE_CENTS;
}

function scaleMissFeedback(results: AttemptResult[], successCount: number, allowedMisses: number): string {
  const misses = results.filter((r) => !r.passed);
  if (misses.length === 0) return 'Almost — check the note count matches the scale.';
  const first = misses[0];
  const idx = results.indexOf(first);
  // Credit real progress instead of leading with the miss when most notes landed.
  const progress = successCount > 0
    ? `${successCount} of ${results.length} notes landed clean — ${misses.length} off, ${allowedMisses} allowed. `
    : '';
  if (first.centsDeviation == null) {
    return `${progress}Note ${idx + 1} (${first.label}) wasn't confidently detected — play it clearly.`;
  }
  const direction = first.centsDeviation < 0 ? 'flat' : 'sharp';
  return `${progress}Note ${idx + 1} (${first.label}) was ${direction} by ${Math.round(Math.abs(first.centsDeviation))}¢.`;
}
