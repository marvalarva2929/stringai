/**
 * Intonation Detection Specification
 *
 * Documents everything the intonation analysis engine looks for, why each
 * category matters, and what the thresholds mean.
 *
 * This drives both the detection logic in intonationAnalysis.ts and
 * the coaching text generation in llmFeedback.ts.
 */

// ─────────────────────────────────────────────────────────────
// Detection thresholds
// ─────────────────────────────────────────────────────────────

export const INTONATION_THRESHOLDS = {
  /**
   * A note is "out of tune" when it deviates more than this from the nearest
   * equal-tempered pitch. 25 cents = a quarter tone — clearly audible to any
   * trained ear and unpleasant in any musical context.
   */
  outOfTuneCents: 25,

  /**
   * A note is "slightly off" in the 10–25 cent range. Not grossly wrong, but
   * noticeably impure in ensemble or when played against a drone.
   */
  slightlyOffCents: 10,

  /**
   * A pitch class is considered a "problem note" if the student plays it out
   * of tune more than this fraction of the time.
   */
  problemNoteErrorRate: 0.3,

  /**
   * Minimum error occurrences to surface a pitch class as a problem note
   * (guards against reporting a note that appeared only once).
   */
  problemNoteMinCount: 2,

  /**
   * The overall tendency is called "flat" or "sharp" if the mean signed deviation
   * across all detected notes exceeds this threshold.
   */
  tendencyCents: 8,

  /**
   * Minimum duration (seconds) for a pitch to be counted as a "note event"
   * rather than a transient or passing tone.
   */
  minNoteEventSeconds: 0.08,

  // ── Accuracy & false-positive reduction ────────────────────────────────────

  /**
   * YIN frames to skip at the start of each note event before computing
   * deviation. The first frame often captures the attack transient (finger
   * landing, bow making contact) rather than the settled pitch.
   * At a 50ms hop rate, 1 frame ≈ 50ms of onset ignored.
   */
  onsetTrimFrames: 1,

  /**
   * After onset-trimming, this many frames are needed before we trust the
   * out-of-tune verdict. Events below this count use a stricter threshold.
   * 3 frames ≈ 150ms of settled note.
   */
  minConfidenceFrames: 3,

  /**
   * Threshold multiplier applied to short events (< minConfidenceFrames).
   * A 2-frame note needs its average to exceed 25 × 1.4 = 35 ¢ before being
   * flagged — filters bow-change blips and micro-transients.
   */
  shortNoteMultiple: 1.4,

  /**
   * Fraction of trimmed frames that must individually exceed the threshold in
   * the same direction as the average. Prevents a single-frame outlier from
   * dragging the average past the cutoff.
   * Applied only when minConfidenceFrames is met.
   */
  frameAgreementRate: 0.55,

  /**
   * Each individual frame must reach this fraction of outOfTuneCents to count
   * as "agreeing" with the overall direction. Set lower than 1.0 so that
   * frames at 15 ¢ still count toward agreement on a 25 ¢ violation.
   */
  frameAgreementSensitivity: 0.6,

  /**
   * If the trimmed average exceeds outOfTuneCents × this multiple, skip the
   * frame-agreement check — the note is obviously out of tune.
   */
  highConfidenceMultiple: 1.8,

  /**
   * Seconds subtracted from a detected note-event's startSeconds when
   * producing the exampleTimestamps shown in the UI. Corrects for the YIN
   * onset lag (one hop = 50ms): the player pressed the finger before the
   * first frame that detected the new pitch class.
   */
  onsetLagSeconds: 0.05,
};

// ─────────────────────────────────────────────────────────────
// What to detect, and why it matters
// ─────────────────────────────────────────────────────────────

export const INTONATION_DETECTION_TARGETS = [

  {
    id: 'per_pitch_class_accuracy',
    name: 'Per-note accuracy',
    description:
      'Group every detected note by its pitch class (F#, C#, etc.) and measure ' +
      'what fraction of occurrences were in tune. This reveals finger placement habits — ' +
      'if F# is flat 70% of the time, the 2nd finger position needs adjustment, ' +
      'not just random attention.',
    importance:
      'Random errors are hard to practice. Systematic errors on specific notes ' +
      'are easy to fix: place that finger, check the pitch, build the muscle memory.',
    violinContext:
      'The most common problem notes on violin are: ' +
      'F# (2nd finger on D/A strings — tends flat when elbow is not supported), ' +
      'C# (2nd finger on A/E strings — same cause), ' +
      'G# (2nd finger on E string — often sharp due to over-extension), ' +
      'B♭ (2nd finger lower, rare in standard keys — needs intentional drop). ' +
      'Third finger notes (C, G, D) tend sharp when the hand frame collapses. ' +
      'Fourth finger (D, A, E) tends sharp when the wrist pushes the hand up.',
    whatToReport:
      'For each pitch class with errorRate > 30%, report: ' +
      'how many times it appeared, how many were out of tune, ' +
      'average deviation in cents, and direction (flat/sharp).',
  },

  {
    id: 'overall_tendency',
    name: 'Overall flat or sharp tendency',
    description:
      'Calculate the mean signed cents deviation across all detected notes. ' +
      'A systematic bias toward flat or sharp is distinct from random errors.',
    importance:
      'Flat tendency usually means the player is not pressing the string fully ' +
      'to the fingerboard, or the bow pressure is too light (under-powered bow ' +
      'makes notes sound flat). Sharp tendency often means pressing too hard ' +
      'with the left hand (excess pressure raises pitch by pulling the string sharp).',
    violinContext:
      'Beginners most commonly play flat — they fear hurting their fingers and ' +
      'do not push fully to the fingerboard. Intermediate players who are working ' +
      'on tone sometimes press too hard and go sharp. ' +
      'A flat tendency > 15 cents on average is significant.',
    whatToReport:
      'If mean deviation is outside ±8 cents, report the overall tendency and magnitude.',
  },

  {
    id: 'note_event_deduplication',
    name: 'Note events vs. raw frames',
    description:
      'YIN runs every 50ms. A 2-second held note produces ~40 frames of the same pitch. ' +
      'The analysis collapses consecutive frames of the same pitch class into a single ' +
      '"note event" and counts out-of-tune events, not out-of-tune frames. ' +
      'This makes the count meaningful: "F# was flat 5 times" means 5 separate ' +
      'instances of playing F# out of tune, not 200 frames of the same bad note.',
    importance:
      'Frame-level counting massively overstates the problem. ' +
      'Event-level counting maps directly to musical reality.',
    whatToReport:
      'Always report in note events, never in raw frames.',
  },

  {
    id: 'high_position_accuracy',
    name: 'High-position accuracy drop',
    description:
      'Notes above D5 (roughly 3rd position and higher) are typically less reliable ' +
      'because position shifts require spatial calibration. ' +
      'If accuracy drops significantly for pitches above a certain frequency, ' +
      'this indicates a position-shifting problem.',
    importance:
      'Position shifting is a distinct skill from first-position intonation. ' +
      'If the student plays well in first position but poorly above it, ' +
      'they need specific shifting practice, not general intonation work.',
    violinContext:
      'Approximate boundaries: ' +
      'First position: up to D5 (open E = E5). ' +
      'Second position: D5–F#5. ' +
      'Third position: G5–B5. ' +
      'High position is generally anything above E5.',
    whatToReport:
      'If error rate for notes above D5 is noticeably higher than for notes below, ' +
      'surface this as a position-accuracy issue.',
  },

  {
    id: 'trending',
    name: 'Session-to-session improvement',
    description:
      'Compare the current session\'s out-of-tune event count (and rate) to the previous ' +
      'session. Express improvement as a percentage reduction: ' +
      '"You played 40% fewer out-of-tune notes than last session."',
    importance:
      'Intonation improves slowly. Students often cannot hear their own improvement. ' +
      'Showing a specific number makes the progress visible and motivating.',
    whatToReport:
      'If previous session data is available and the out-of-tune count changed ' +
      'by ≥20%, report the percentage improvement or regression.',
  },
];

// ─────────────────────────────────────────────────────────────
// Violin note → likely finger mapping (first position)
// ─────────────────────────────────────────────────────────────

/**
 * Maps pitch class to the most common violin finger in first position.
 * Used to generate coaching text: "Your 2nd finger tends to land flat."
 *
 * Not exhaustive — only covers the most common first-position notes.
 * Higher positions are not mapped (too many possibilities).
 */
export const PITCH_CLASS_TO_FINGER: Partial<Record<string, {
  finger: 1 | 2 | 3 | 4;
  strings: string;
  note: string;
}>> = {
  'A':  { finger: 1, strings: 'G',   note: 'A3 (1st finger G string)' },
  'B':  { finger: 2, strings: 'G/A', note: 'B3 or B4 (2nd finger G or 1st finger A)' },
  'C':  { finger: 3, strings: 'G/A', note: 'C4 or C5 (3rd finger G or A)' },
  'C#': { finger: 2, strings: 'A/E', note: 'C#5 (2nd finger A string) — most common' },
  'D':  { finger: 4, strings: 'G',   note: 'D4 (4th finger G) or open D' },
  'E':  { finger: 1, strings: 'D/A', note: 'E4 or E5 (1st finger D/A)' },
  'F#': { finger: 2, strings: 'D/A', note: 'F#4 or F#5 (2nd finger D or A string) — very common' },
  'G':  { finger: 3, strings: 'D/A', note: 'G4 or G5 (3rd finger D or A)' },
  'G#': { finger: 2, strings: 'E',   note: 'G#5 (2nd finger E string)' },
};

// ─────────────────────────────────────────────────────────────
// Coaching templates for common scenarios
// ─────────────────────────────────────────────────────────────

export const INTONATION_COACHING = {
  flatTendency:
    'A flat tendency usually means the fingers are not pressing fully to the fingerboard, ' +
    'or the bow is under-powered. Try playing with a drone tuner and focus on firm, ' +
    'decisive left-hand placement.',

  sharpTendency:
    'A sharp tendency usually means excess left-hand pressure. ' +
    'Heavy pressing raises pitch by pulling the string sharp. ' +
    'Focus on light, curved fingertip contact — the string only needs to touch the fingerboard, not be pushed through it.',

  secondFingerFlat:
    'The 2nd finger tends to land flat when the elbow is not underneath the violin neck. ' +
    'Check your left elbow position — it should support the hand, keeping the fingers ' +
    'arched over the strings rather than reaching.',

  secondFingerSharp:
    'The 2nd finger tends to land sharp when the hand frame is too open or the wrist ' +
    'pushes the fingers forward. Keep the hand frame consistent — 2nd finger should ' +
    'stay at its natural interval from 1st finger.',

  thirdFingerGeneral:
    '3rd finger intonation is closely linked to the entire hand frame. ' +
    'If your 3rd finger is off, check that fingers 1 and 2 are placed correctly first — ' +
    'the 3rd finger builds on the foundation of the first two.',

  highPositionGeneral:
    'High-position intonation requires the ear to guide the shift, not just muscle memory. ' +
    'Practice shifts in slow motion: leave from the old note, travel, arrive, then check the new note with a tuner.',
};
