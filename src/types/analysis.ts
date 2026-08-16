import type { InstrumentId } from './instrument';
import type { Piece } from './piece';

export type MetricKey =
  | 'pitchAccuracy'
  | 'intonationStability'
  | 'toneQuality'
  | 'bowSmoothness'
  | 'vibrato'
  | 'rhythmAccuracy'
  | 'dynamicControl'
  | 'bowPlacement'
  | 'bowAngle'
  | 'bowArmLevel'
  | 'bowDistribution'
  | 'leftHandWrist'
  | 'posture';

export type SeverityBand = 'excellent' | 'good' | 'needs_attention' | 'critical';

export function severityFromScore(score: number): SeverityBand {
  if (score >= 90) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'needs_attention';
  return 'critical';
}

export interface FlaggedTimestamp {
  startSeconds: number;
  endSeconds: number;
  note?: string;
}

export interface TechniqueEvent {
  type: string;           // violation id, e.g. 'wrist_collapse', 'sul_tasto'
  startSeconds: number;
  endSeconds: number;
  value?: number;         // measured magnitude (e.g., degrees, cents)
}

/**
 * Tone-quality fault categories, derived from violin acoustics (Schelleng's
 * force/speed/contact-point space). Used as TechniqueEvent.type for the
 * toneQuality metric so coaching can name the specific fault.
 */
export type ToneFault =
  | 'clean'            // ideal Helmholtz regime — no fault
  | 'scratch'          // over-pressure / crunch (force too high for speed)
  | 'rasp'             // general roughness / raised noise floor (mild over-pressure)
  | 'thin'             // surface sound / under-pressure (force too low for speed)
  | 'ponticello'       // bow too close to bridge — glassy, weak fundamental
  | 'tasto'            // bow too close to fingerboard — dull, weak highs
  | 'whistle'          // whistle / harmonic squeak / wolf
  | 'onset_scratch'    // attack starts scratchy then clears
  | 'delayed_speech'   // note speaks late (airy onset that catches)
  | 'decay'            // tone thins / degrades toward the end of a note
  | 'flicker';         // uneven / flickering tone within a note

export type MeasurementQuality = 'high' | 'low' | 'proxy' | 'unavailable';

export interface MetricScore {
  key: MetricKey;
  score: number;          // INTERNAL: 0-100, kept for trend tracking — never shown in UI
  delta?: number;         // INTERNAL: vs. previous 3-session average
  flaggedTimestamps: FlaggedTimestamp[];  // INTERNAL: powers the session timeline
  severity: SeverityBand; // INTERNAL
  // Event-based reporting — shown to the user
  events: TechniqueEvent[];
  occurrenceRate: number;       // 0-1: fraction of session time/frames with this issue
  observationSummary: string;   // "Wrist collapsed 23 times" — the user-facing description
  /** Omitted or 'high' for reliable metrics; 'unavailable' excludes from overall score. */
  measurementQuality?: MeasurementQuality;
  /** Per-frame time series for metrics that support graphing. Not persisted to DB. */
  timeSeries?: Array<{ t: number; v: number }>;
  /** Per-frame debug intermediates for wrist angle diagnosis. Not persisted to DB. */
  debugSeries?: Array<{ t: number; cos: number | null; magF: number | null; magH: number | null; mode: '3D' | '2D' }>;
  /** Runtime-only debug payload for dynamics tuning. Stripped before persistence. */
  _dynDebug?: DynDebugInfo;
}

export type PhraseShape = 'arch' | 'rising' | 'falling' | 'plateau' | 'unclassified' | 'melodic_contour';

export interface DynPhraseDebug {
  startSec: number;
  endSec: number;
  durS: number;
  cv2: number;
  slopeNorm: number;
  peakPos: number;
  shape: PhraseShape;
  /** Issue type that fired for this phrase, if any */
  issue?: string;
  confidence?: number;
}

export interface DynDebugInfo {
  dynamicRatio: number;
  maxSlow: number;
  minSlow: number;
  jitterScore: number;
  rangeScore: number;
  shapeScore: number;
  score: number;
  phrases: DynPhraseDebug[];
  /** All candidate issues before confidence filter and MAX_EVENTS cap */
  allIssues: { type: string; startSec: number; endSec: number; confidence: number; note: string }[];
  ranked: { type: string; confidence: number }[];
}

// ─────────────────────────────────────────────────────────────
// LLM Feedback
// ─────────────────────────────────────────────────────────────

export interface LLMCoachingItem {
  metricKey: MetricKey;
  observation: string;  // What was detected (= observationSummary)
  feedback: string;     // Coaching response
  exercise?: string;    // Recommended drill text
}

export interface LLMPhraseFeedback {
  phraseId: number;
  observation: string;
  tip: string;
  /**
   * The phrase's start time in seconds, echoed back by the model. Lets the
   * results UI seek to the moment even when the id doesn't resolve — a session
   * re-opened from history has no phraseFeatures to look the id up in.
   */
  start_t?: number;
}

export interface LLMFeedback {
  overallTake: string;
  items: LLMCoachingItem[];
  generatedAt: string;
  /** Present only on Edge Function (Claude) responses, not static fallback. */
  phraseFeedback?: LLMPhraseFeedback[];
  /**
   * The 1-3 underlying causes tying multiple issues together — the "big picture"
   * narrative. Always the GROUNDED result of groundCuratedPlan() against this
   * session's issues, never the raw Claude output; absent on the static fallback
   * and whenever nothing survived grounding.
   */
  rootCauses?: import('../lib/practiceCuration').CuratedRootCause[];
  /**
   * Grounded copy for the session-scoped practice plan's blocks (Phase 3.5).
   * Not persisted on AnalysisResult long-term storage the way the rest of
   * llmFeedback is expected to be read back — the caller (app/(tabs)/analyze.tsx)
   * moves this into useCuratedPlanStore keyed by planId immediately, since
   * that's what usePracticePlan actually reads from.
   */
  curatedBlocks?: import('../lib/practiceCuration').CuratedBlockSpec[];
  /** 'claude' = Edge Function; absent/'static' = local template fallback. */
  source?: 'claude' | 'static';
}

// ─────────────────────────────────────────────────────────────
// Intonation analysis types
// ─────────────────────────────────────────────────────────────

export interface PitchClassIssue {
  pitchClass: string;        // full note name including octave, e.g. "B4", "F#5"
  totalNoteEvents: number;   // times this note was played
  outOfTuneCount: number;    // times it was out of tune
  errorRate: number;         // 0-1
  avgDeviationCents: number; // signed: negative = flat, positive = sharp
  tendency: 'flat' | 'sharp' | 'mixed';
  exampleTimestamps?: { startSeconds: number; endSeconds: number }[];  // up to 3
  representativeMidi?: number; // most common MIDI note played for this pitch class (includes octave)
}

export interface IntonationAnalysis {
  totalNoteEvents: number;
  inTuneCount: number;
  outOfTuneCount: number;
  inTuneRate: number;        // 0-1
  overallTendency: 'flat' | 'sharp' | 'neutral';
  tendencyCents: number;     // signed average across all detected notes
  problemNotes: PitchClassIssue[];  // sorted by outOfTuneCount desc
  observationSummary: string;
  _score: number;            // 0-100 internal score for trend tracking
}

export interface VibratoNoteResult {
  startS: number;
  endS: number;
  durationS: number;
  noteScore: number;
  rateHz: number;
  depthCents: number;
  periodicityScore: number;
  consistencyOk: boolean;
  /**
   * Whether a real oscillation in the vibrato band was found on this note. Optional because
   * analyses persisted before this field existed don't carry it; consumers fall back to the
   * rate/depth check in hasVibrato().
   */
  detected?: boolean;
  feedbackNotes: string[];
  cents: number[];
}

export interface VibratoAnalysis {
  eligibleCount: number;
  avgNoteScore: number;
  notes: VibratoNoteResult[];
}

export interface RhythmFlaggedRegion {
  startSeconds: number;
  endSeconds: number;
  direction: 'rushed' | 'dragged';
  deviationPct: number;
  label: string;
}

export interface RhythmAnalysis {
  bpmEst: number;
  beatPeriodSeconds: number;
  tendency: 'rushing' | 'dragging' | null;
  gridScore: number;
  tempoDriftScore: number;
  rushCount: number;
  dragCount: number;
  onGridCount: number;
  totalNotes: number;
  /** Moving-average beat period per window (seconds). Not persisted to DB. */
  localBeatPeriods: number[];
  /** Session timestamp for each localBeatPeriods sample (seconds). */
  localBeatTimestamps: number[];
  flaggedRegions: RhythmFlaggedRegion[];
  isRubato: boolean;
  ioiCv?: number;
}

// Per-note intonation STABILITY detail (within-note pitch-center steadiness).
// Distinct from intonation accuracy (PitchClassIssue) and from vibrato: it reports how
// the pitch CENTER drifted/wavered within a held note, after vibrato is removed.
export type IntonationFaultType = 'drift_sharp' | 'drift_flat' | 'scoop' | 'waver';

export interface IntonationStabilityNoteResult {
  startS: number;
  endS: number;
  noteName: string;          // nearest ET note to the center, e.g. "F#4"
  driftCents: number;        // center-line std — the stability measure
  noteScore: number;         // 0-100
  faultType: IntonationFaultType;
  feedbackNote: string;      // actionable coaching string
  cents: number[];           // raw deviation from the note median (faint background line)
  centerCents: number[];     // vibrato-removed center line (bold line — the variation shown)
}

export interface IntonationStabilityAnalysis {
  assessedCount: number;     // notes assessed for stability
  unsteadyCount: number;     // notes above the attention threshold
  avgDriftCents: number;
  worstNotes: IntonationStabilityNoteResult[];  // ranked worst-first, capped
}

// ─────────────────────────────────────────────────────────────
// Coaching / Assessment types
// ─────────────────────────────────────────────────────────────

export type PlayerCategory = 'foundation' | 'refinement';

export interface RecommendedExercise {
  id: string;
  title: string;
  duration: string;
  instructions: string;
}

export interface Issue {
  metricKey: MetricKey;
  title: string;
  description: string;
  exercise?: RecommendedExercise;
}

export interface PostureMetrics {
  avgShoulderAlignment: number;
  avgHeadPosition: number;
  avgElbowLevel: number;
  avgWristPosture: number;
  overallFormScore: number;
}

export interface SessionAssessment {
  playerCategory: PlayerCategory;
  techniqueSummary: string;
  keyObservations: { metricKey: MetricKey; note: string }[];
  postureMetrics: PostureMetrics;
  intonationSummary?: string;
}

export interface AnalysisResult {
  sessionId: string;
  userId: string;
  instrument: InstrumentId;
  piece?: Piece;
  durationSeconds: number;
  recordedAt: string;
  overallScore: number;
  overallDelta?: number;
  metrics: MetricScore[];
  audioMetrics: MetricScore[];
  videoMetrics: MetricScore[];
  sessionAssessment?: SessionAssessment;
  llmFeedback?: LLMFeedback;
  intonationAnalysis?: IntonationAnalysis;
  intonationStabilityAnalysis?: IntonationStabilityAnalysis;
  vibratoAnalysis?: VibratoAnalysis;
  rhythmAnalysis?: RhythmAnalysis;
  audioQualityWarning?: string;
  /** Tempo the player set on the metronome for this take, when they used one.
   *  Recorded intent — rhythm scoring still estimates the played tempo itself. */
  metronomeBpm?: number;
  videoUri?: string;  // local path to the session video for replay
  noteEvents?: import('../lib/noteFusion').NoteEvent[];
  /** L8 findings that fired. Persisted with the session for L10 coaching. */
  patternFindings?: import('../lib/patternDetection').StatisticalFinding[];
  /** L7 per-phrase musical descriptors. Plain data, so unlike sessionSignals it
   *  survives persistence — phrase-scoped practice blocks need these windows. */
  phraseFeatures?: import('../lib/phraseFeatures').PhraseFeatures[];
  /**
   * The ranked musical picture sent to the coach — see lib/musicalEvidence.ts.
   * Held on the result so chat can discuss this session before the server-side
   * write of musical_evidence has landed.
   */
  musicalEvidence?: import('../lib/musicalEvidence').MusicalEvidence;
  /** L7.5 key, musical figures, and per-kind contrasts. Plain data; this is what
   *  lets an exercise say "arpeggios in G" instead of "pitch accuracy". */
  musicalContext?: import('../lib/musicalContext').MusicalContext;
  /** L9 per-session practice evidence ("issues"), computed once at analysis time.
   *  The single source of truth the results screen and the daily/session plans
   *  both read, instead of each re-deriving from raw analyses. */
  sessionEvidence?: import('../lib/practiceEvidence').PracticeEvidence[];
  /** Which analysis version froze `sessionEvidence`. See EVIDENCE_VERSION. */
  evidenceVersion?: number;
  /** L3 substrate. In-memory only — contains closures (TimeSeries.sample/window)
   *  that don't survive JSON serialization; stripped from persistence and from
   *  all but the newest sessionResultCache entry. */
  sessionSignals?: import('./signals').SessionSignals;
  /** Sample data shown during activation to a user who doesn't have their
   *  instrument to hand. Never saved to Supabase, never counted against the
   *  analysis quota, never added to sessionHistory/metricHistory — and dropped
   *  on rehydration (see useAnalysisStore) so it can't resurface as a real
   *  session on the next launch. */
  isDemo?: boolean;
  /** Runtime-only: true while the Pro Claude coaching upgrade is in flight for
   *  this session (set before the first render, cleared on success/failure by
   *  app/(tabs)/analyze.tsx). Powers the results screen's coaching-loading
   *  state; never meaningfully persisted (a reload just means it's absent). */
  coachingPending?: boolean;
}

// Raw intermediate signals from audio DSP — consumed by noteFusion.ts
export interface RawAudioSignals {
  pitchFrames: { frequency: number | null; timestamp: number }[];
  rmsFrames:   { value: number; timestamp: number }[];
  toneFrames:  { fundamentalRatio: number; timestamp: number }[];
  spectralCentroidFrames: { value: number; timestamp: number }[];
  brightnessFrames:       { value: number; timestamp: number }[];
  onsetTimestamps: number[];
  /** Merged flux+pitch onsets BEFORE same-note collapsing. Same-pitch bow-change
   *  candidates survive here — noteFusion re-validates them against bow speed. */
  uncollapsedOnsetTimestamps: number[];
  sampleRate: number;
  duration: number;
}

// Return type for audio analysis (includes both metrics and note-level intonation)
export interface AudioAnalysisOutput {
  metrics: MetricScore[];
  intonationAnalysis: IntonationAnalysis;
  intonationStabilityAnalysis: IntonationStabilityAnalysis;
  vibratoAnalysis: VibratoAnalysis;
  rhythmAnalysis?: RhythmAnalysis;
  rawSignals: RawAudioSignals;
  /**
   * True when the decoder rejected the file and these are the mock metrics, not
   * a real analysis. The user is shown no difference, so this flag is the only
   * way the app can tell — reported as `analysis_degraded`.
   */
  usedMockMetrics?: boolean;
}

export interface SessionSummary {
  id: string;
  recordedAt: string;
  overallScore: number;
  overallDelta?: number;
  instrument: InstrumentId;
  durationSeconds: number;
  topIssue?: MetricKey;
  piece?: { id: string; title: string; composer?: string };
}
