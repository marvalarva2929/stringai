// ─────────────────────────────────────────────────────────────
// Scoring a paced sequence take.
//
// Pass/fail per note was the wrong shape for this. A note eight cents off is
// not a failure — it is a good note with something to polish — but the old
// evaluator treated it as a miss and let a single one sour a whole take. That
// is not how playing works and it is not how anyone judges it.
//
// So a take gets a score out of 100 from three things a teacher would actually
// weigh, and passes by clearing a bar rather than by being flawless:
//
//   intonation   how close each note was, on a curve — not a gate
//   timing       whether it sat with the click
//   completeness whether the notes asked for were the notes played
//
// The score is also the thing worth tracking: "82 → 91 on this drill over two
// weeks" is progress a player can see, where "failed, failed, passed" is not.
// ─────────────────────────────────────────────────────────────

export interface ScoredNote {
  /** Expected note name. */
  label: string;
  /** Signed cents from the target; null when nothing was confidently heard. */
  centsDeviation: number | null;
  /** Signed ms from this note's click; null when timing wasn't measurable. */
  offsetMs: number | null;
  /** 0-100 for this note's pitch alone. */
  intonationScore: number;
  /** True when the note was close enough to count as cleanly landed. */
  clean: boolean;
}

export interface SequenceScore {
  /** 0-100 overall. */
  score: number;
  intonation: number;
  timing: number | null;
  completeness: number;
  notes: ScoredNote[];
  cleanCount: number;
  /** Notes that were a different note entirely, not merely out of tune. */
  wrongNoteCount: number;
  /** Notes the detector never heard. */
  missingCount: number;
  passed: boolean;
  /** The bar this take had to clear. */
  passMark: number;
  /**
   * True when the take is disqualified regardless of score: wrong notes,
   * undetected notes, or a note count that doesn't match what was asked for.
   *
   * The score is deliberately forgiving about *intonation* — that was the whole
   * point of scoring instead of gating. It is not forgiving about playing a
   * different note, because that is not a near miss, and a drill that passes
   * you for playing C instead of B is not teaching you anything.
   */
  disqualified: boolean;
  /** Why, when disqualified. */
  disqualifiedReason?: 'wrong_notes' | 'missing_notes' | 'note_count';
}

/** Beyond this a note isn't out of tune, it's a different note. */
export const WRONG_NOTE_CENTS = 50;

/**
 * Wrong or undetected notes a take may contain and still pass.
 *
 * Zero for a short drill: in an eight-note scale, one wrong note is an eighth
 * of the exercise. Longer sequences get a little room, because one fumble in
 * twenty notes is a good run of twenty notes.
 */
export function allowedWrongNotes(expectedCount: number): number {
  return Math.floor(expectedCount / 10);
}

/** Past this a timing offset scores zero rather than going negative. */
const TIMING_ZERO_MS = 400;

export interface SequenceScoreOptions {
  /** Cents within which a note scores full marks for pitch. */
  centsThreshold: number;
  /** Score needed to pass. */
  passMark: number;
  /** Milliseconds within which a note counts as dead on the click. */
  timingToleranceMs?: number;
}

const DEFAULT_TIMING_TOLERANCE_MS = 120;

function clamp100(v: number): number {
  return Math.max(0, Math.min(100, v));
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

/**
 * Pitch quality for one note.
 *
 * Full marks inside the tolerance, then a straight taper to zero at the
 * wrong-note line. The taper is the whole point: it distinguishes 12¢ from 40¢,
 * which a pass/fail gate cannot, and which is exactly the distinction a player
 * improving over weeks needs to see.
 */
export function intonationScoreFor(cents: number | null, centsThreshold: number): number {
  if (cents == null) return 0;
  const abs = Math.abs(cents);
  if (abs <= centsThreshold) return 100;
  if (abs >= WRONG_NOTE_CENTS) return 0;
  const span = WRONG_NOTE_CENTS - centsThreshold;
  return clamp100(100 * (1 - (abs - centsThreshold) / span));
}

/** Timing quality for one note: full marks inside tolerance, tapering to zero. */
export function timingScoreFor(offsetMs: number | null, toleranceMs: number): number | null {
  if (offsetMs == null) return null;
  const abs = Math.abs(offsetMs);
  if (abs <= toleranceMs) return 100;
  if (abs >= TIMING_ZERO_MS) return 0;
  return clamp100(100 * (1 - (abs - toleranceMs) / (TIMING_ZERO_MS - toleranceMs)));
}

export interface SequenceScoreInput {
  label: string;
  centsDeviation: number | null;
  offsetMs: number | null;
}

export function scoreSequence(
  inputs: SequenceScoreInput[],
  expectedCount: number,
  opts: SequenceScoreOptions,
): SequenceScore {
  const toleranceMs = opts.timingToleranceMs ?? DEFAULT_TIMING_TOLERANCE_MS;

  const notes: ScoredNote[] = inputs.map((input) => {
    const intonationScore = intonationScoreFor(input.centsDeviation, opts.centsThreshold);
    return {
      label: input.label,
      centsDeviation: input.centsDeviation,
      offsetMs: input.offsetMs,
      intonationScore,
      clean: input.centsDeviation != null && Math.abs(input.centsDeviation) <= opts.centsThreshold,
    };
  });

  const intonation = notes.length > 0 ? mean(notes.map((n) => n.intonationScore)) : 0;

  const timingScores = notes
    .map((n) => timingScoreFor(n.offsetMs, toleranceMs))
    .filter((v): v is number => v != null);
  // Null rather than zero when nothing was measurable: a take with no beat
  // information hasn't got bad timing, it has unknown timing, and scoring it
  // zero would punish the player for a missing signal.
  const timing = timingScores.length > 0 ? mean(timingScores) : null;

  // Extra notes count against you as much as missing ones — a scale with a
  // stumble in it played 16 notes where 15 were asked for.
  const played = notes.length;
  const completeness = expectedCount > 0
    ? clamp100(100 * (1 - Math.abs(played - expectedCount) / expectedCount))
    : 0;

  // Intonation carries the most weight because it is what these drills are for;
  // timing is real but secondary. Completeness MULTIPLIES rather than adding:
  // as one term among three it was worth so little that playing six of eight
  // notes still scored in the nineties, which is nonsense — half an exercise
  // cannot be a good take however well the half went.
  const quality = timing != null
    ? 0.7 * intonation + 0.3 * timing
    : intonation;
  const score = clamp100(quality * (completeness / 100));

  const wrongNoteCount = notes.filter(
    (n) => n.centsDeviation != null && Math.abs(n.centsDeviation) > WRONG_NOTE_CENTS,
  ).length;
  const missingCount = notes.filter((n) => n.centsDeviation == null).length;
  const allowed = allowedWrongNotes(expectedCount);

  // A count mismatch also means the note-to-click alignment is guesswork, so
  // the per-note marks below it can't be trusted either.
  const disqualifiedReason =
    played !== expectedCount ? 'note_count' as const
    : wrongNoteCount > allowed ? 'wrong_notes' as const
    : missingCount > allowed ? 'missing_notes' as const
    : undefined;

  return {
    score: Math.round(score),
    intonation: Math.round(intonation),
    timing: timing == null ? null : Math.round(timing),
    completeness: Math.round(completeness),
    notes,
    cleanCount: notes.filter((n) => n.clean).length,
    wrongNoteCount,
    missingCount,
    passed: Math.round(score) >= opts.passMark && disqualifiedReason == null,
    passMark: opts.passMark,
    disqualified: disqualifiedReason != null,
    disqualifiedReason,
  };
}

/** Pass mark by coach intensity. A guided player needs a reachable bar. */
export function passMarkFor(intensity: 'guided' | 'balanced' | 'advanced'): number {
  if (intensity === 'advanced') return 85;
  if (intensity === 'balanced') return 75;
  return 65;
}

/** Short verdict band for the result screen. */
export function scoreBand(score: number): 'excellent' | 'good' | 'needs_attention' | 'critical' {
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 55) return 'needs_attention';
  return 'critical';
}
