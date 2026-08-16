import type { PracticeEvaluation, AttemptResult } from './practiceEvaluator';

// ─────────────────────────────────────────────────────────────
// Attack evaluator — bow-stroke character from the amplitude envelope.
//
// There is no stroke classifier in this app and building one properly means
// training on real footage. But three of the strokes a player is asked to
// distinguish differ in ways the RMS envelope alone shows plainly:
//
//   détaché  — gentle onset, note sustains, little or no silence between notes
//   martelé  — sharp onset with a pronounced attack peak, then a release, and a
//              real silence before the next note (the bow stops)
//   spiccato — very short notes with long silences; the bow leaves the string
//
// So this measures onset time, peak-to-sustain ratio, and inter-note silence,
// and judges only whether the stroke matches the one the drill asked for. It
// deliberately does not try to name a stroke it wasn't told to expect — the
// envelope cannot separate collé from martelé, or sautillé from spiccato, and
// guessing between them would be a confident wrong answer.
// ─────────────────────────────────────────────────────────────

export type StrokeName = 'detache' | 'martele' | 'spiccato';

export const STROKE_LABEL: Record<StrokeName, string> = {
  detache: 'détaché',
  martele: 'martelé',
  spiccato: 'spiccato',
};

export interface NoteEnvelope {
  startSeconds: number;
  endSeconds: number;
  /** Seconds from note start to peak amplitude. */
  attackSeconds: number;
  /** Peak amplitude divided by mean amplitude over the note's body. */
  peakToSustain: number;
  /** Silence between this note's end and the next note's start, seconds. */
  gapAfterSeconds: number;
}

interface StrokeProfile {
  maxAttackSeconds: number;
  minPeakToSustain: number;
  maxPeakToSustain: number;
  minGapSeconds: number;
  maxGapSeconds: number;
  /** What to say when a note misses this profile. */
  miss: string;
}

/**
 * Thresholds are conservative on purpose: they separate strokes that are
 * genuinely being played differently, and stay quiet about near misses. A drill
 * that fails a decent détaché for being 20ms slow teaches nothing.
 */
const PROFILES: Record<StrokeName, StrokeProfile> = {
  detache: {
    maxAttackSeconds: 0.09,
    minPeakToSustain: 1.0,
    maxPeakToSustain: 1.9,
    minGapSeconds: 0,
    maxGapSeconds: 0.12,
    miss: 'détaché wants a smooth start and a note that keeps sounding right up to the change — this one bit at the front or stopped short',
  },
  martele: {
    maxAttackSeconds: 0.05,
    minPeakToSustain: 1.7,
    maxPeakToSustain: 8,
    minGapSeconds: 0.06,
    maxGapSeconds: 0.7,
    miss: 'martelé wants a pinch-and-release: a sharp start, then the bow stops on the string before the next note',
  },
  spiccato: {
    maxAttackSeconds: 0.04,
    minPeakToSustain: 1.4,
    maxPeakToSustain: 8,
    minGapSeconds: 0.09,
    maxGapSeconds: 1.2,
    miss: 'spiccato wants a short note and real air between the notes — the bow is staying on the string',
  },
};

export interface AttackEvaluatorOptions {
  stroke: StrokeName;
  /** How many of the notes must match the stroke to pass. */
  requiredMatchFraction: number;
  /** Minimum notes before a verdict is possible. */
  minNotes?: number;
}

function matches(note: NoteEnvelope, profile: StrokeProfile): boolean {
  return (
    note.attackSeconds <= profile.maxAttackSeconds
    && note.peakToSustain >= profile.minPeakToSustain
    && note.peakToSustain <= profile.maxPeakToSustain
    && note.gapAfterSeconds >= profile.minGapSeconds
    && note.gapAfterSeconds <= profile.maxGapSeconds
  );
}

export function evaluateAttack(
  notes: NoteEnvelope[],
  opts: AttackEvaluatorOptions,
): PracticeEvaluation {
  const minNotes = opts.minNotes ?? 4;
  const profile = PROFILES[opts.stroke];
  const label = STROKE_LABEL[opts.stroke];

  if (notes.length < minNotes) {
    return {
      passed: false,
      attempts: notes.length,
      successCount: 0,
      bestStreak: 0,
      feedback: `Only ${notes.length} note${notes.length === 1 ? '' : 's'} came through — play at least ${minNotes} separate strokes so the stroke itself can be judged.`,
    };
  }

  // The last note has no note after it, so its gap is unknowable; judge the
  // rest and let it ride rather than failing a stroke on a missing measurement.
  const judged = notes.slice(0, -1);
  const attemptResults: AttemptResult[] = judged.map((note, i) => ({
    passed: matches(note, profile),
    label: `${i + 1}`,
    startTimeSeconds: note.startSeconds,
    endTimeSeconds: note.endSeconds,
  }));

  const successCount = attemptResults.filter((r) => r.passed).length;
  const fraction = successCount / attemptResults.length;
  const passed = fraction >= opts.requiredMatchFraction;

  const feedback = passed
    ? `Passed: ${successCount} of ${attemptResults.length} strokes read as ${label}.`
    : `${successCount} of ${attemptResults.length} read as ${label} — ${profile.miss}.`;

  return {
    passed,
    attempts: attemptResults.length,
    successCount,
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
