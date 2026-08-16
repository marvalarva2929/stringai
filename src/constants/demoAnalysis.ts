import type {
  AnalysisResult,
  MetricScore,
  IntonationAnalysis,
  IntonationStabilityAnalysis,
  VibratoAnalysis,
  RhythmAnalysis,
  SessionAssessment,
  LLMFeedback,
} from '../types/analysis';
import { severityFromScore } from '../types/analysis';
import type { NoteEvent } from '../lib/noteFusion';
import type { PracticeEvidence } from '../lib/practiceEvidence';

/**
 * A sample session, shown during activation to someone who doesn't have their
 * violin to hand. It stands in for their own first recording so they can still
 * see — and be walked through — the thing the whole app is built around.
 *
 * Everything here is hand-authored rather than generated, because every card in
 * the results carousel has to have real content on it. An empty vibrato card or
 * a blank intonation timeline would teach the user that those features are
 * hollow, which is worse than not showing them at all.
 *
 * It is deliberately a *flawed* performance: good enough to feel encouraging,
 * wrong enough in specific, nameable ways that the practice plan it produces is
 * obviously worth doing. The running fault is a flat 3rd-finger G on the D
 * string — the most common intonation problem a first-position player has.
 *
 * Invariants (enforced by test/demoAnalysis.test.ts):
 *   - every CategoryId in categories.ts resolves to a scored metric here
 *   - noteEvents are monotonic and inside durationSeconds
 *   - overallScore matches computeOverallScore over the beginner weights
 *
 * It never reaches Supabase, sessionHistory, metricHistory or the analysis
 * quota — see src/lib/activationDemo.ts and the isDemo drop in useAnalysisStore.
 */

export const DEMO_SESSION_ID = 'demo-session';

const BPM = 92;
const BEAT = 60 / BPM;
/** Silence before the first note, so the timeline doesn't start hard against 0. */
const LEAD_IN = 1.4;

// ── The performance ───────────────────────────────────────────
//
// "Twinkle, Twinkle, Little Star" in D major — public domain, and the piece
// almost every first-position player actually has under their fingers.
// D/E/F#/G sit on the D string (open, 1st, 2nd, 3rd finger); A/B on the A string.

interface MelodyNote {
  noteName: string;
  midi: number;
  beats: number;
  string: NoteEvent['string'];
  finger: NoteEvent['inferredFinger'];
}

const N = (
  noteName: string, midi: number, beats: number,
  string: NoteEvent['string'], finger: NoteEvent['inferredFinger'],
): MelodyNote => ({ noteName, midi, beats, string, finger });

const D4 = (b: number) => N('D4', 62, b, 'D', 0);
const E4 = (b: number) => N('E4', 64, b, 'D', 1);
const F4 = (b: number) => N('F#4', 66, b, 'D', 2);
const G4 = (b: number) => N('G4', 67, b, 'D', 3);
const A4 = (b: number) => N('A4', 69, b, 'A', 0);
const B4 = (b: number) => N('B4', 71, b, 'A', 1);

const MELODY: MelodyNote[] = [
  // Twinkle, twinkle, little star
  D4(1), D4(1), A4(1), A4(1), B4(1), B4(1), A4(2),
  // How I wonder what you are
  G4(1), G4(1), F4(1), F4(1), E4(1), E4(1), D4(2),
  // Up above the world so high
  A4(1), A4(1), G4(1), G4(1), F4(1), F4(1), E4(2),
  // Like a diamond in the sky
  A4(1), A4(1), G4(1), G4(1), F4(1), F4(1), E4(2),
  // Twinkle, twinkle, little star
  D4(1), D4(1), A4(1), A4(1), B4(1), B4(1), A4(2),
  // How I wonder what you are
  G4(1), G4(1), F4(1), F4(1), E4(1), E4(1), D4(2),
];

/**
 * The player's habitual pitch error per note, in cents.
 *
 * The 3rd finger is consistently under-reached (G4 badly flat); the 2nd finger
 * creeps sharp toward the leading tone; open strings are of course perfect.
 * These are the numbers everything downstream — the problem-note list, the
 * in-tune rate, the practice plan — is derived from.
 */
const TENDENCY_CENTS: Record<string, number> = {
  'D4': 0,      // open D string
  'A4': 0,      // open A string
  'E4': -6,     // 1st finger, close to true
  'B4': -9,     // 1st finger on the A string, slightly under
  'F#4': 14,    // 2nd finger creeping sharp
  'G4': -34,    // 3rd finger badly flat — the session's headline problem
};

/** Deterministic ±6c wobble so the notes aren't identical. No RNG: the test
 *  fixtures and the rendered timeline must be byte-stable across runs. */
const wobble = (i: number): number => [0, 4, -3, 6, -5, 2, -6, 3][i % 8];

/** Rushing through phrase 3 — the rhythm fault the plan picks up. */
const RUSH_PHRASE = 2;
const RUSH_FACTOR = 0.88;

const round2 = (v: number): number => Math.round(v * 100) / 100;

function buildNoteEvents(): NoteEvent[] {
  const events: NoteEvent[] = [];
  let t = LEAD_IN;

  MELODY.forEach((n, i) => {
    const phrase = Math.floor(i / 7);
    const rushing = phrase === RUSH_PHRASE;
    const beatLen = BEAT * (rushing ? RUSH_FACTOR : 1);
    const duration = n.beats * beatLen;
    // A short gap for the bow change, so notes don't butt up against each other.
    const sounding = duration * 0.92;

    const cents = (TENDENCY_CENTS[n.noteName] ?? 0) + (n.finger === 0 ? 0 : wobble(i));
    // Tone degrades on the down-bow attacks at the start of each phrase.
    const isPhraseStart = i % 7 === 0;

    events.push({
      startSeconds: round2(t),
      endSeconds: round2(t + sounding),
      durationSeconds: round2(sounding),

      pitchHz: round2(440 * Math.pow(2, (n.midi - 69) / 12) * Math.pow(2, cents / 1200)),
      noteName: n.noteName,
      string: n.string,
      inferredFinger: n.finger,
      positionGroup: 'first',

      centsDeviation: cents,
      absCentsDeviation: Math.abs(cents),
      inTune: Math.abs(cents) <= 25,

      fundamentalRatio: isPhraseStart ? 0.61 : 0.79,
      dynamicLevel: isPhraseStart ? 0.72 : 0.55,

      bowContactPoint: null,
      bowAngle: null,
      bowDistanceFromBridge: null,
      bowZone: null,
      wristCollapsed: null,
      shoulderRaised: null,

      distanceFromCrossing: null,
      phrasePosition: round2((i % 7) / 6),
      phraseDurationSeconds: round2(8 * BEAT),
    });

    t += duration;
  });

  return events;
}

export const DEMO_NOTE_EVENTS: NoteEvent[] = buildNoteEvents();

const LAST_NOTE = DEMO_NOTE_EVENTS[DEMO_NOTE_EVENTS.length - 1];
/** Two seconds of tail after the final note, as a real recording would have. */
const DURATION_SECONDS = Math.ceil(LAST_NOTE.endSeconds + 2);

/** Timestamps of the G4s, the notes the whole plan hangs off. */
const G4_TIMES = DEMO_NOTE_EVENTS
  .filter((n) => n.noteName === 'G4')
  .map((n) => ({ startSeconds: n.startSeconds, endSeconds: n.endSeconds }));

const OUT_OF_TUNE = DEMO_NOTE_EVENTS.filter((n) => !n.inTune);

// ── Metrics ───────────────────────────────────────────────────
//
// Scores chosen so the overall lands at 70 under the beginner weights — a
// believable "you can play this, and here's what's holding it back".

const metric = (
  key: MetricScore['key'],
  score: number,
  occurrenceRate: number,
  observationSummary: string,
  extras: Partial<MetricScore> = {},
): MetricScore => ({
  key,
  score,
  flaggedTimestamps: [],
  severity: severityFromScore(score),
  events: [],
  occurrenceRate,
  observationSummary,
  measurementQuality: 'high',
  ...extras,
});

const DEMO_AUDIO_METRICS: MetricScore[] = [
  metric('pitchAccuracy', 68, 0.32, `${OUT_OF_TUNE.length} of ${DEMO_NOTE_EVENTS.length} notes landed out of tune — almost all of them 3rd finger.`, {
    delta: 0,
    flaggedTimestamps: G4_TIMES.slice(0, 4).map((t) => ({ ...t, note: 'G played flat (3rd finger)' })),
    events: G4_TIMES.map((t) => ({ type: 'flat_note', startSeconds: t.startSeconds, endSeconds: t.endSeconds, value: -34 })),
  }),
  metric('intonationStability', 74, 0.18, 'Held notes drifted an average of 11 cents — steadiest on the open strings.', {
    flaggedTimestamps: [{ startSeconds: 12.4, endSeconds: 13.7, note: 'Pitch centre slid flat through the held E' }],
    events: [{ type: 'drift_flat', startSeconds: 12.4, endSeconds: 13.7, value: 17 }],
  }),
  metric('toneQuality', 74, 0.19, 'Tone was clean for 81% of the session; the roughness clustered on phrase-opening down-bows.', {
    flaggedTimestamps: [
      { startSeconds: 1.4, endSeconds: 2.0, note: 'Scratchy attack at the frog' },
      { startSeconds: 10.5, endSeconds: 11.1, note: 'Scratchy attack at the frog' },
      { startSeconds: 19.1, endSeconds: 19.7, note: 'Scratchy attack at the frog' },
    ],
    events: [
      { type: 'onset_scratch', startSeconds: 1.4, endSeconds: 2.0 },
      { type: 'onset_scratch', startSeconds: 10.5, endSeconds: 11.1 },
      { type: 'onset_scratch', startSeconds: 19.1, endSeconds: 19.7 },
      { type: 'scratch', startSeconds: 27.8, endSeconds: 28.3 },
    ],
  }),
  metric('rhythmAccuracy', 70, 0.24, 'The third line ran ahead of the beat by about 12%; the rest sat on the grid.', {
    flaggedTimestamps: [{ startSeconds: 18.9, endSeconds: 26.2, note: 'Rushing — 12% ahead' }],
    events: [{ type: 'rushed', startSeconds: 18.9, endSeconds: 26.2, value: 12 }],
  }),
  metric('vibrato', 58, 0.42, 'No sustained vibrato detected — the two long notes that could carry it were played straight.', {
    flaggedTimestamps: [],
    events: [],
    measurementQuality: 'low',
  }),
  metric('dynamicControl', 64, 0.36, 'Every phrase was played at one level — no shaping between the opening and the peak.', {
    flaggedTimestamps: [
      { startSeconds: 1.4, endSeconds: 9.8, note: 'Flat dynamic shape across the phrase' },
      { startSeconds: 18.9, endSeconds: 26.2, note: 'Flat dynamic shape across the phrase' },
    ],
    events: [
      { type: 'flat_phrase', startSeconds: 1.4, endSeconds: 9.8 },
      { type: 'flat_phrase', startSeconds: 18.9, endSeconds: 26.2 },
    ],
  }),
  metric('bowSmoothness', 66, 0.28, 'Bow speed jumped at 9 of the 42 note changes, mostly on string crossings.', {
    events: [{ type: 'speed_jump', startSeconds: 5.3, endSeconds: 5.6 }],
  }),
];

const DEMO_VIDEO_METRICS: MetricScore[] = [
  metric('posture', 78, 0.14, 'Shoulders stayed level; the scroll dipped gradually through the second half.', {
    flaggedTimestamps: [{ startSeconds: 22.0, endSeconds: 31.0, note: 'Violin scroll dropping' }],
    events: [{ type: 'scroll_drop', startSeconds: 22.0, endSeconds: 31.0, value: 9 }],
  }),
  metric('leftHandWrist', 65, 0.31, 'Left wrist collapsed toward the neck on most 3rd-finger notes.', {
    flaggedTimestamps: G4_TIMES.slice(0, 3).map((t) => ({ ...t, note: 'Wrist collapsed reaching for 3rd finger' })),
    events: G4_TIMES.map((t) => ({ type: 'wrist_collapse', startSeconds: t.startSeconds, endSeconds: t.endSeconds })),
  }),
  metric('bowPlacement', 73, 0.21, 'Contact point wandered toward the fingerboard on the quieter phrases.', {
    events: [{ type: 'sul_tasto', startSeconds: 11.0, endSeconds: 14.5 }],
  }),
  metric('bowAngle', 69, 0.26, 'The bow angled off-parallel on the A string, pulling the sound toward the fingerboard.', {
    events: [{ type: 'skewed_bow', startSeconds: 4.2, endSeconds: 8.9, value: 11 }],
  }),
  metric('bowArmLevel', 72, 0.19, 'Bow arm height lagged the string change from D to A.', {
    events: [{ type: 'arm_level_lag', startSeconds: 3.9, endSeconds: 4.4 }],
  }),
  metric('bowDistribution', 67, 0.29, 'Half notes used barely more bow than the quarters, so they died away early.', {
    flaggedTimestamps: [{ startSeconds: 8.5, endSeconds: 9.8, note: 'Half note ran out of bow' }],
    events: [{ type: 'short_bow', startSeconds: 8.5, endSeconds: 9.8 }],
  }),
];

const DEMO_METRICS: MetricScore[] = [...DEMO_AUDIO_METRICS, ...DEMO_VIDEO_METRICS];

// ── Per-domain analyses ───────────────────────────────────────

const inTuneCount = DEMO_NOTE_EVENTS.length - OUT_OF_TUNE.length;

const DEMO_INTONATION: IntonationAnalysis = {
  totalNoteEvents: DEMO_NOTE_EVENTS.length,
  inTuneCount,
  outOfTuneCount: OUT_OF_TUNE.length,
  inTuneRate: round2(inTuneCount / DEMO_NOTE_EVENTS.length),
  overallTendency: 'flat',
  tendencyCents: -9,
  problemNotes: [
    {
      pitchClass: 'G4',
      totalNoteEvents: G4_TIMES.length,
      outOfTuneCount: G4_TIMES.length,
      errorRate: 1,
      avgDeviationCents: -34,
      tendency: 'flat',
      exampleTimestamps: G4_TIMES.slice(0, 3),
      representativeMidi: 67,
    },
    {
      pitchClass: 'F#4',
      totalNoteEvents: 8,
      outOfTuneCount: 2,
      errorRate: 0.25,
      avgDeviationCents: 14,
      tendency: 'sharp',
      exampleTimestamps: DEMO_NOTE_EVENTS
        .filter((n) => n.noteName === 'F#4')
        .slice(0, 2)
        .map((n) => ({ startSeconds: n.startSeconds, endSeconds: n.endSeconds })),
      representativeMidi: 66,
    },
  ],
  observationSummary: 'Every G came in flat — the 3rd finger is not reaching far enough up the D string.',
  _score: 68,
};

const DEMO_STABILITY: IntonationStabilityAnalysis = {
  assessedCount: 12,
  unsteadyCount: 3,
  avgDriftCents: 11,
  worstNotes: [
    {
      startS: 12.4,
      endS: 13.7,
      noteName: 'E4',
      driftCents: 17,
      noteScore: 62,
      faultType: 'drift_flat',
      feedbackNote: 'The pitch centre slid flat as the note went on — the finger is easing off its weight.',
      cents: [-3, -5, -8, -11, -14, -16, -18, -17],
      centerCents: [-3, -6, -9, -12, -15, -16, -17, -17],
    },
    {
      startS: 8.5,
      endS: 9.8,
      noteName: 'A4',
      driftCents: 9,
      noteScore: 74,
      faultType: 'waver',
      feedbackNote: 'Open A wavered — that is the bow, not the left hand. Keep the speed even to the tip.',
      cents: [0, 3, -2, 5, -4, 2, -3, 1],
      centerCents: [0, 2, 0, 3, -1, 1, -1, 0],
    },
  ],
};

const DEMO_VIBRATO: VibratoAnalysis = {
  eligibleCount: 6,
  avgNoteScore: 58,
  notes: [
    {
      startS: 8.5,
      endS: 9.8,
      durationS: 1.3,
      noteScore: 55,
      rateHz: 0,
      depthCents: 0,
      periodicityScore: 0.08,
      consistencyOk: false,
      feedbackNotes: ['Played straight — long enough to carry vibrato, but none was applied.'],
      cents: [0, 3, -2, 5, -4, 2, -3, 1],
    },
    {
      startS: 17.4,
      endS: 18.6,
      durationS: 1.2,
      noteScore: 61,
      rateHz: 0,
      depthCents: 0,
      periodicityScore: 0.11,
      consistencyOk: false,
      feedbackNotes: ['Straight tone again on the phrase ending.'],
      cents: [-6, -4, -7, -5, -6, -8, -6, -5],
    },
  ],
};

const DEMO_RHYTHM: RhythmAnalysis = {
  bpmEst: BPM,
  beatPeriodSeconds: round2(BEAT),
  tendency: 'rushing',
  gridScore: 70,
  tempoDriftScore: 66,
  rushCount: 7,
  dragCount: 1,
  onGridCount: 34,
  totalNotes: DEMO_NOTE_EVENTS.length,
  localBeatPeriods: [0.65, 0.65, 0.66, 0.64, 0.57, 0.57, 0.58, 0.63, 0.65, 0.65],
  localBeatTimestamps: [1.4, 4.7, 8.0, 11.3, 18.9, 22.0, 25.1, 28.0, 31.0, 33.5],
  flaggedRegions: [
    {
      startSeconds: 18.9,
      endSeconds: 26.2,
      direction: 'rushed',
      deviationPct: 12,
      label: 'Third line ran ahead of the beat',
    },
  ],
  isRubato: false,
};

const DEMO_ASSESSMENT: SessionAssessment = {
  playerCategory: 'foundation',
  techniqueSummary:
    'A confident, steady read of the tune. The bow arm is doing its job; the left hand is what is holding the pitch back, and it is one finger causing nearly all of it.',
  keyObservations: [
    { metricKey: 'pitchAccuracy', note: 'Every G was flat — the 3rd finger is not reaching.' },
    { metricKey: 'toneQuality', note: 'Phrase-opening down-bows start scratchy at the frog.' },
    { metricKey: 'rhythmAccuracy', note: 'The third line accelerated by about 12%.' },
  ],
  postureMetrics: {
    avgShoulderAlignment: 88,
    avgHeadPosition: 82,
    avgElbowLevel: 74,
    avgWristPosture: 65,
    overallFormScore: 78,
  },
  intonationSummary: `${inTuneCount} of ${DEMO_NOTE_EVENTS.length} notes in tune, with a flat tendency of 9 cents.`,
};

const DEMO_LLM_FEEDBACK: LLMFeedback = {
  overallTake:
    "This is a solid performance with one clear thing in the way of it. Your bow is steady and your rhythm is mostly reliable — but every single G you played came in flat, and that one habit is doing most of the damage to the pitch. Fix the 3rd finger and this jumps immediately.",
  items: [
    {
      metricKey: 'pitchAccuracy',
      observation: 'All six G naturals landed roughly 34 cents flat.',
      feedback:
        'Your 3rd finger is stopping short. That usually means the hand is anchored too far back — the wrist collapses in toward the neck and the finger has to stretch instead of drop.',
      exercise: 'Play D–E–F#–G slowly, checking G against the open G string an octave below. Stop when it rings.',
    },
    {
      metricKey: 'toneQuality',
      observation: 'Three phrase-opening down-bows started scratchy at the frog.',
      feedback:
        'You are landing on the string with arm weight already committed. Let the bow start moving a hair before the weight arrives and the attack cleans up.',
      exercise: 'Four slow down-bows from the frog on open D, starting each one from the string, not from the air.',
    },
    {
      metricKey: 'rhythmAccuracy',
      observation: 'The third line ran about 12% ahead of the beat.',
      feedback:
        'It is the easiest line to play, so it got away from you. Rushing usually shows up exactly where the music feels comfortable.',
      exercise: 'Play that line alone at 92 with a click, then again at 80 — hold the tempo through the whole phrase.',
    },
  ],
  generatedAt: '2026-01-01T00:00:00.000Z',
  source: 'static',
};

// ── Practice evidence (L9) ────────────────────────────────────
//
// The three issues the practice plan is built from. Ordered by priority — the
// flat 3rd finger is the one worth doing first.

const DEMO_EVIDENCE: PracticeEvidence[] = [
  {
    id: 'demo-evidence-pitch-g4',
    kind: 'pitch_note',
    metricKey: 'pitchAccuracy',
    title: 'G is landing flat',
    reason: 'All six G naturals were roughly a third of a semitone under pitch.',
    evidenceSummary: `${G4_TIMES.length} of ${G4_TIMES.length} G naturals flat by an average of 34 cents`,
    priority: 1,
    confidence: 0.95,
    supportsLive: true,
    requiresMic: true,
    requiresCamera: false,
    measurementAvailable: true,
    sourceSessionId: DEMO_SESSION_ID,
    sourceRecordedAt: '2026-01-01T00:00:00.000Z',
    sessionCount: 1,
    target: {
      metricKey: 'pitchAccuracy',
      pitchClass: 'G4',
      midiNote: 67,
      noteName: 'G4',
      string: 'D',
      finger: 3,
      tendency: 'flat',
      startSeconds: G4_TIMES[0]?.startSeconds,
      endSeconds: G4_TIMES[0]?.endSeconds,
    },
  },
  {
    id: 'demo-evidence-tone-onset',
    kind: 'tone',
    metricKey: 'toneQuality',
    title: 'Scratchy attacks at the frog',
    reason: 'Every phrase opened with a rough down-bow before the tone settled.',
    evidenceSummary: '3 phrase-opening down-bows started scratchy',
    priority: 2,
    confidence: 0.82,
    supportsLive: true,
    requiresMic: true,
    requiresCamera: false,
    measurementAvailable: true,
    sourceSessionId: DEMO_SESSION_ID,
    sourceRecordedAt: '2026-01-01T00:00:00.000Z',
    sessionCount: 1,
    target: {
      metricKey: 'toneQuality',
      faultType: 'onset_scratch',
      startSeconds: 1.4,
      endSeconds: 2.0,
    },
  },
  {
    id: 'demo-evidence-rhythm-rush',
    kind: 'rhythm',
    metricKey: 'rhythmAccuracy',
    title: 'Rushing through the third line',
    reason: 'The tempo climbed about 12% once the music got comfortable.',
    evidenceSummary: '7 notes ahead of the beat across a 7-second stretch',
    priority: 3,
    confidence: 0.78,
    supportsLive: true,
    requiresMic: true,
    requiresCamera: false,
    measurementAvailable: true,
    sourceSessionId: DEMO_SESSION_ID,
    sourceRecordedAt: '2026-01-01T00:00:00.000Z',
    sessionCount: 1,
    target: {
      metricKey: 'rhythmAccuracy',
      bpmEst: BPM,
      startSeconds: 18.9,
      endSeconds: 26.2,
    },
  },
];

// ── The result ────────────────────────────────────────────────

export const DEMO_ANALYSIS: AnalysisResult = {
  sessionId: DEMO_SESSION_ID,
  userId: 'demo',
  instrument: 'violin',
  piece: {
    id: 'demo-piece',
    title: 'Twinkle, Twinkle, Little Star',
    composer: 'Traditional',
    source: 'manual',
    keySignature: 'D major',
    timeSignature: '4/4',
  },
  durationSeconds: DURATION_SECONDS,
  recordedAt: '2026-01-01T00:00:00.000Z',
  // Verified against the beginner weights in test/demoAnalysis.test.ts — if you
  // change a metric score above, that test tells you the new number.
  overallScore: 70,
  metrics: DEMO_METRICS,
  audioMetrics: DEMO_AUDIO_METRICS,
  videoMetrics: DEMO_VIDEO_METRICS,
  sessionAssessment: DEMO_ASSESSMENT,
  llmFeedback: DEMO_LLM_FEEDBACK,
  intonationAnalysis: DEMO_INTONATION,
  intonationStabilityAnalysis: DEMO_STABILITY,
  vibratoAnalysis: DEMO_VIBRATO,
  rhythmAnalysis: DEMO_RHYTHM,
  metronomeBpm: BPM,
  // No videoUri on purpose — the carousel shows the "your video will appear
  // here" placeholder instead, which is the point of the whole demo path.
  noteEvents: DEMO_NOTE_EVENTS,
  sessionEvidence: DEMO_EVIDENCE,
  isDemo: true,
};
