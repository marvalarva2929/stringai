import { InstrumentId } from './instrument';
import { Piece } from './piece';

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

export interface LLMFeedback {
  overallTake: string;
  items: LLMCoachingItem[];
  generatedAt: string;
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
  foundationIssues: Issue[];
  refinementIssues: Issue[];
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
  audioQualityWarning?: string;
  videoUri?: string;  // local path to the session video for replay
  noteEvents?: import('../lib/noteFusion').NoteEvent[];
}

// Raw intermediate signals from audio DSP — consumed by noteFusion.ts
export interface RawAudioSignals {
  pitchFrames: { frequency: number | null; timestamp: number }[];
  rmsFrames:   { value: number; timestamp: number }[];
  toneFrames:  { fundamentalRatio: number; timestamp: number }[];
  onsetTimestamps: number[];
  sampleRate: number;
  duration: number;
}

// Return type for audio analysis (includes both metrics and note-level intonation)
export interface AudioAnalysisOutput {
  metrics: MetricScore[];
  intonationAnalysis: IntonationAnalysis;
  rawSignals: RawAudioSignals;
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
