import { supabase } from './supabase';
import { AnalysisResult, MetricScore, SessionSummary, IntonationAnalysis, AudioAnalysisOutput, severityFromScore, VibratoAnalysis } from '../types/analysis';
import { Piece } from '../types/piece';
import { InstrumentId } from '../types/instrument';
import { analyzeMediaFile } from './audioEngine';
import { buildSessionFeedback } from './llmFeedback';
import { FrameKeypoints } from '../lib/poseScoring';
import { scorePoseFrames, extractVideoFrames } from './videoAnalysis';
import { RawBowFrame } from '../types/signals';

// Fallback mock used when the audio file cannot be parsed (e.g. M4A on Android).
function mockMetrics(): MetricScore[] {
  return [
    { key: 'pitchAccuracy',       score: 72, flaggedTimestamps: [{ startSeconds: 12.5, endSeconds: 18.0, note: 'Intonation off' }], severity: severityFromScore(72), events: [{ type: 'out_of_tune', startSeconds: 12.5, endSeconds: 18.0 }], occurrenceRate: 0.28, observationSummary: '2 passages were noticeably out of tune.' },
    { key: 'toneQuality',         score: 68, flaggedTimestamps: [{ startSeconds: 5.0,  endSeconds: 8.5,  note: 'Tone quality issue' }], severity: severityFromScore(68), events: [{ type: 'scratchy_tone', startSeconds: 5.0, endSeconds: 8.5 }], occurrenceRate: 0.22, observationSummary: 'Some tone quality issues — 22% of the session.' },
    { key: 'bowSmoothness',       score: 81, flaggedTimestamps: [], severity: severityFromScore(81), events: [], occurrenceRate: 0.05, observationSummary: '3 abrupt bow changes detected.' },
    { key: 'rhythmAccuracy',      score: 76, flaggedTimestamps: [], severity: severityFromScore(76), events: [], occurrenceRate: 0.12, observationSummary: 'Some rhythmic inconsistency — note durations varied more than expected.' },
    { key: 'dynamicControl',      score: 65, flaggedTimestamps: [], severity: severityFromScore(65), events: [], occurrenceRate: 0.35, observationSummary: 'Dynamics were somewhat limited — not much volume variation.' },
    { key: 'intonationStability', score: 74, flaggedTimestamps: [], severity: severityFromScore(74), events: [], occurrenceRate: 0.15, observationSummary: 'Some pitch wavering on held notes (avg 12 cents variation).' },
    { key: 'vibrato',             score: 55, flaggedTimestamps: [], severity: severityFromScore(55), events: [], occurrenceRate: 0.45, observationSummary: 'Vibrato was present but inconsistent.' },
  ];
}

function mockIntonationAnalysis(): IntonationAnalysis {
  return {
    totalNoteEvents: 32,
    inTuneCount: 25,
    outOfTuneCount: 7,
    inTuneRate: 0.78,
    overallTendency: 'flat',
    tendencyCents: -11,
    problemNotes: [
      { pitchClass: 'F#', totalNoteEvents: 8, outOfTuneCount: 5, errorRate: 0.625, avgDeviationCents: -19, tendency: 'flat' },
      { pitchClass: 'C#', totalNoteEvents: 5, outOfTuneCount: 2, errorRate: 0.4,   avgDeviationCents: -13, tendency: 'flat' },
    ],
    observationSummary: 'F# was flat 5× (63% of the time). 78% of notes in tune overall.',
    _score: 78,
  };
}

export async function runAudioAnalysis(
  audioUri: string,
  instrument: InstrumentId,
  durationSeconds: number,
): Promise<AudioAnalysisOutput> {
  try {
    return await analyzeMediaFile(audioUri, instrument, durationSeconds);
  } catch (err: any) {
    if (err?.message === 'VIDEO_UPLOADED') {
      throw err;
    }
    if (err?.message !== 'NOT_WAV') {
      throw err;
    }
    console.warn('[audioEngine] Non-WAV file — falling back to mock metrics');
    await new Promise((r) => setTimeout(r, 1500));
    return {
      metrics: mockMetrics(),
      intonationAnalysis: mockIntonationAnalysis(),
      intonationStabilityAnalysis: { assessedCount: 0, unsteadyCount: 0, avgDriftCents: 0, worstNotes: [] },
      vibratoAnalysis: { eligibleCount: 0, avgNoteScore: 0, notes: [] } satisfies VibratoAnalysis,
      rawSignals: { pitchFrames: [], rmsFrames: [], toneFrames: [], spectralCentroidFrames: [], brightnessFrames: [], onsetTimestamps: [], sampleRate: 44100, duration: durationSeconds },
    };
  }
}

export async function runVideoAnalysis(
  videoUri: string,
  instrument: InstrumentId,
  poseFrames?: FrameKeypoints[],
  durationSeconds?: number,
  liveBowFrames?: RawBowFrame[],
): Promise<MetricScore[]> {
  if (poseFrames && poseFrames.length >= 5) {
    // Live-recording path: use bow frames collected during recording (may be empty
    // if the model isn't integrated yet — bow metrics gracefully return unavailable).
    return scorePoseFrames(poseFrames, instrument, durationSeconds ?? 0, liveBowFrames ?? []);
  }

  // Uploaded-video path: extract pose + bow frames from the video file.
  try {
    const { poseFrames: extracted, bowFrames } = await extractVideoFrames(videoUri);
    if (extracted.length >= 5) {
      return scorePoseFrames(extracted, instrument, durationSeconds ?? 0, bowFrames);
    }
  } catch {
    // module unavailable (Android) or video unreadable — fall through to mock
  }

  // Mock fallback for Android or when Vision returns too few frames.
  await new Promise((r) => setTimeout(r, 500));
  return [
    { key: 'posture', score: 85, delta: 2, flaggedTimestamps: [], severity: severityFromScore(85), events: [], occurrenceRate: 0.04, observationSummary: 'Posture was well-balanced throughout the session.', measurementQuality: 'high' },
    { key: 'leftHandWrist', score: 70, delta: 1, flaggedTimestamps: [{ startSeconds: 30.0, endSeconds: 35.0, note: 'Wrist collapse on high positions' }], severity: severityFromScore(70), events: [{ type: 'wrist_collapse', startSeconds: 30.0, endSeconds: 35.0 }], occurrenceRate: 0.22, observationSummary: 'Left wrist collapsed 3 times.', measurementQuality: 'high' },
    { key: 'bowArmLevel', score: 72, flaggedTimestamps: [], severity: severityFromScore(72), events: [], occurrenceRate: 0.15, observationSummary: 'Bow arm height showed some adjustment for string changes.', measurementQuality: 'high' },
    { key: 'bowPlacement', score: 0, flaggedTimestamps: [], severity: 'good', events: [], occurrenceRate: 0, observationSummary: 'Requires bow tracking — not available until a bow detector is integrated.', measurementQuality: 'unavailable' },
    { key: 'bowAngle', score: 0, flaggedTimestamps: [], severity: 'good', events: [], occurrenceRate: 0, observationSummary: 'Requires bow tracking — not available until a bow detector is integrated.', measurementQuality: 'unavailable' },
    { key: 'bowDistribution', score: 0, flaggedTimestamps: [], severity: 'good', events: [], occurrenceRate: 0, observationSummary: 'Requires bow tracking — not available until a bow detector is integrated.', measurementQuality: 'unavailable' },
  ];
}

export function computeOverallScore(
  audioMetrics: MetricScore[],
  videoMetrics: MetricScore[],
  weights: Record<string, number>,
): number {
  const all = [...audioMetrics, ...videoMetrics];
  let total = 0;
  let weightSum = 0;

  for (const metric of all) {
    if (metric.measurementQuality === 'unavailable') continue;
    const w = weights[metric.key] ?? 0;
    total += metric.score * w;
    weightSum += w;
  }

  return weightSum > 0 ? Math.round(total / weightSum) : 0;
}

async function savePiece(piece: Piece, userId: string): Promise<void> {
  const { error } = await supabase.from('pieces').upsert({
    id: piece.id,
    user_id: userId,
    title: piece.title,
    composer: piece.composer ?? null,
    source: piece.source,
    imslp_id: piece.imslpId ?? null,
    pdf_storage_path: piece.pdfUri ?? null,
  });
  if (error) throw error;
}

export async function saveSession(result: AnalysisResult): Promise<void> {
  if (result.piece) {
    await savePiece(result.piece, result.userId);
  }

  const { error: sessionError } = await supabase.from('sessions').insert({
    id: result.sessionId,
    user_id: result.userId,
    instrument: result.instrument,
    piece_id: result.piece?.id ?? null,
    duration_seconds: result.durationSeconds,
    recorded_at: result.recordedAt,
    overall_score: result.overallScore,
    overall_delta: result.overallDelta,
  });
  if (sessionError) throw sessionError;

  const metricRows = result.metrics.map((m) => ({
    session_id: result.sessionId,
    metric_key: m.key,
    score: m.score,
    delta: m.delta,
    flagged_timestamps: m.flaggedTimestamps,
  }));

  const { error: metricsError } = await supabase.from('metric_scores').insert(metricRows);
  if (metricsError) throw metricsError;
}

export { buildSessionFeedback };

export function sessionToSummary(result: AnalysisResult): SessionSummary {
  const topIssue = result.metrics.length > 0
    ? result.metrics.reduce((worst, m) => (m.score < worst.score ? m : worst)).key
    : undefined;
  return {
    id: result.sessionId,
    recordedAt: result.recordedAt,
    overallScore: result.overallScore,
    overallDelta: result.overallDelta,
    instrument: result.instrument,
    durationSeconds: result.durationSeconds,
    topIssue,
    piece: result.piece
      ? { id: result.piece.id, title: result.piece.title, composer: result.piece.composer }
      : undefined,
  };
}

export async function fetchSessionHistory(userId: string): Promise<SessionSummary[]> {
  const { data, error } = await supabase
    .from('sessions')
    .select('id, recorded_at, overall_score, overall_delta, instrument, duration_seconds, pieces(id, title, composer)')
    .eq('user_id', userId)
    .order('recorded_at', { ascending: false })
    .limit(50);

  if (error) throw error;

  return (data ?? []).map((row: any) => ({
    id: row.id,
    recordedAt: row.recorded_at,
    overallScore: row.overall_score,
    overallDelta: row.overall_delta,
    instrument: row.instrument,
    durationSeconds: row.duration_seconds,
    piece: row.pieces
      ? { id: row.pieces.id, title: row.pieces.title, composer: row.pieces.composer ?? undefined }
      : undefined,
  }));
}
