import { midiToFreq, noteNameToMidi, midiToNoteName } from './pitchNaming';
import type { PracticeEvaluation, AttemptResult } from './practiceEvaluator';
import { scoreSequence, WRONG_NOTE_CENTS, type SequenceScore } from './sequenceScore';

/** Nearest equal-tempered note to a detected frequency. */
function nearestNoteName(freqHz: number): string | undefined {
  if (!Number.isFinite(freqHz) || freqHz <= 0) return undefined;
  return midiToNoteName(Math.round(69 + 12 * Math.log2(freqHz / 440)));
}

export interface ScaleAttempt {
  medianFreqHz: number;
  confidence: number;
  /** Signed ms from this note's click. Absent when timing wasn't measurable. */
  offsetMs?: number | null;
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
  opts: { centsThreshold: number; minConfidence?: number; passMark?: number },
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
      // What was actually heard, so a wrong note can be named instead of being
      // reported as an absurd cents figure ("sharp by 1180¢" is not sharpness,
      // it's a different note — see missDescription).
      //
      // Deliberately NOT gated on minConfidence: a pitch we heard but couldn't
      // judge confidently is still worth naming. Telling a player their note
      // "wasn't detected" when the tuner plainly showed it is how the app loses
      // their trust; medianFreqHz === 0 is the only true "heard nothing" case.
      heardNoteName: attempt.medianFreqHz > 0
        ? nearestNoteName(attempt.medianFreqHz)
        : undefined,
      offsetMs: attempt.offsetMs ?? undefined,
      startTimeSeconds: attempt.startTimeSeconds,
      endTimeSeconds: attempt.endTimeSeconds,
    });
    if (passed) successCount += 1;
  }

  // A scale is a musical whole, not a chain of pass/fail gates. One note eight
  // cents shy is a good scale with something to polish — the take is judged on
  // a score out of 100 and passes by clearing a bar, rather than by being
  // flawless. See sequenceScore.ts.
  const passMark = opts.passMark ?? 75;
  const scored = scoreSequence(
    attemptResults.map((r) => ({
      label: r.label ?? '',
      centsDeviation: r.centsDeviation ?? null,
      offsetMs: r.offsetMs ?? null,
    })),
    expectedSequence.length,
    { centsThreshold: opts.centsThreshold, passMark },
  );

  return {
    passed: scored.passed,
    attempts: attempts.length,
    successCount,
    bestStreak: successCount,
    feedback: scoreFeedback(scored, attemptResults, expectedSequence.length, attempts.length),
    attemptResults,
    score: scored,
  };
}

/** One sentence: what the take scored, and the single most useful next thing. */
function scoreFeedback(
  scored: SequenceScore,
  results: AttemptResult[],
  expectedCount: number,
  playedCount: number,
): string {
  const headline = `${scored.score}/100`;

  if (scored.disqualifiedReason === 'note_count') {
    return `${headline} — heard ${playedCount} notes, expected ${expectedCount}. Give each note a clear stop before the next so every one gets counted.`;
  }
  if (scored.disqualifiedReason === 'missing_notes') {
    // Prefer naming a specific note over a bare count — see missDescription.
    const unjudged = results.find((r) => r.centsDeviation == null);
    return unjudged
      ? `${headline} — ${missDescription(unjudged)}`
      : `${headline} — ${scored.missingCount} note${scored.missingCount === 1 ? '' : 's'} not held long enough to judge.`;
  }
  if (scored.disqualifiedReason === 'wrong_notes') {
    const wrong = results.find(
      (r) => r.centsDeviation != null && Math.abs(r.centsDeviation) > WRONG_NOTE_CENTS,
    );
    // Scoring is forgiving about intonation on purpose; it is not forgiving
    // about a different note, and the message has to make that distinction
    // clear or a high score beside a fail reads as a bug.
    return wrong
      ? `${headline} — good otherwise, but ${missDescription(wrong)} That's a wrong note rather than a near miss, so it doesn't pass.`
      : `${headline} — a wrong note rather than a near miss, so it doesn't pass.`;
  }
  if (scored.passed) {
    return `${headline} — every note landed clean. That's the standard.`;
  }

  if (scored.timing != null && scored.timing < scored.intonation - 15) {
    return `${headline} — the notes are there (${scored.intonation}/100 for pitch) but they're drifting off the click. Try it slower and let the click lead.`;
  }

  // Passing needs every note inside tolerance, so the useful thing to say is
  // which ones weren't — those are what gets drilled next, individually. Naming
  // one or two is a next action; listing eight is just a scolding.
  const offNotes = results.filter((r) => !r.passed && r.label);
  if (offNotes.length === 1) {
    return `${headline} — ${missDescription(offNotes[0])}`;
  }
  if (offNotes.length > 1) {
    const worst = [...offNotes].sort(
      (a, b) => Math.abs(b.centsDeviation ?? 9999) - Math.abs(a.centsDeviation ?? 9999),
    );
    const names = worst.slice(0, 3).map((r) => r.label).join(', ');
    const rest = worst.length > 3 ? ` +${worst.length - 3} more` : '';
    return `${headline} — ${worst.length} notes to clean up: ${names}${rest}.`;
  }
  return `${headline} — every note needs to be inside the tolerance to pass.`;
}

/** Within this of a whole octave, a "miss" is the detector hearing a harmonic. */
const OCTAVE_TOLERANCE_CENTS = 70;

function isOctaveError(cents: number): boolean {
  const octaves = Math.round(cents / 1200);
  return octaves !== 0 && Math.abs(cents - octaves * 1200) <= OCTAVE_TOLERANCE_CENTS;
}

/**
 * What went wrong with one note, in terms that mean something.
 *
 * Cents only describe *intonation*, and only within about a semitone. Past that
 * the player did not play the right note slightly wrong, they played a
 * different note — and printing "sharp by 1180¢" for it is both meaningless and
 * alarming. Octave-sized errors are singled out because they are nearly always
 * the pitch detector locking onto a harmonic rather than a real mistake.
 */
export function missDescription(result: AttemptResult): string {
  if (result.centsDeviation == null) {
    // Two very different situations used to share one message. "Not detected" for
    // a note the player heard themselves play reads as the app being broken, so
    // say what came through whenever anything did.
    return result.heardNoteName
      ? `${result.label} read as ${result.heardNoteName}, but not steadily enough to judge — hold it a beat longer.`
      : `${result.label} — nothing came through on that beat.`;
  }
  const cents = result.centsDeviation;
  if (isOctaveError(cents)) {
    const direction = cents > 0 ? 'higher' : 'lower';
    return `${result.label} read an octave ${direction} than expected — usually the mic catching a harmonic rather than a real miss. A slower, fuller bow fixes it.`;
  }
  if (Math.abs(cents) > WRONG_NOTE_CENTS) {
    return result.heardNoteName
      ? `${result.label} came out as ${result.heardNoteName} — a different note, not just out of tune.`
      : `${result.label} came out as a different note.`;
  }
  const direction = cents < 0 ? 'flat' : 'sharp';
  return `${result.label} was ${direction} by ${Math.round(Math.abs(cents))}¢.`;
}
