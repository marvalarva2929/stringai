import { supabase } from './supabase';
import { AnalysisResult, MetricScore, SessionSummary, IntonationAnalysis, AudioAnalysisOutput, severityFromScore, VibratoAnalysis, LLMFeedback } from '../types/analysis';
import { Piece } from '../types/piece';
import { InstrumentId } from '../types/instrument';
import type { MetricHistoryEntry, SessionHeadline } from '../store/useAnalysisStore';
import { analyzeMediaFile } from './audioEngine';
import { buildSessionFeedback } from './llmFeedback';

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
      usedMockMetrics: true,
      metrics: mockMetrics(),
      intonationAnalysis: mockIntonationAnalysis(),
      intonationStabilityAnalysis: { assessedCount: 0, unsteadyCount: 0, avgDriftCents: 0, worstNotes: [] },
      vibratoAnalysis: { eligibleCount: 0, avgNoteScore: 0, notes: [] } satisfies VibratoAnalysis,
      rawSignals: { pitchFrames: [], rmsFrames: [], toneFrames: [], spectralCentroidFrames: [], brightnessFrames: [], onsetTimestamps: [], uncollapsedOnsetTimestamps: [], sampleRate: 44100, duration: durationSeconds },
    };
  }
}

// Mock fallback for Android or when Vision returns too few frames.
export async function mockVideoMetrics(): Promise<MetricScore[]> {
  await new Promise((r) => setTimeout(r, 500));
  return [
    { key: 'posture', score: 85, delta: 2, flaggedTimestamps: [], severity: severityFromScore(85), events: [], occurrenceRate: 0.04, observationSummary: 'Posture was well-balanced throughout the session.', measurementQuality: 'high' },
    { key: 'leftHandWrist', score: 70, delta: 1, flaggedTimestamps: [{ startSeconds: 30.0, endSeconds: 35.0, note: 'Wrist collapse on high positions' }], severity: severityFromScore(70), events: [{ type: 'wrist_collapse', startSeconds: 30.0, endSeconds: 35.0 }], occurrenceRate: 0.22, observationSummary: 'Left wrist collapsed 3 times.', measurementQuality: 'high' },
    { key: 'bowArmLevel', score: 72, flaggedTimestamps: [], severity: severityFromScore(72), events: [], occurrenceRate: 0.15, observationSummary: 'Bow arm height showed some adjustment for string changes.', measurementQuality: 'high' },
    { key: 'bowPlacement', score: 0, flaggedTimestamps: [], severity: 'good', events: [], occurrenceRate: 0, observationSummary: 'Bow tracking is not available on this device.', measurementQuality: 'unavailable' },
    { key: 'bowAngle', score: 0, flaggedTimestamps: [], severity: 'good', events: [], occurrenceRate: 0, observationSummary: 'Bow tracking is not available on this device.', measurementQuality: 'unavailable' },
    { key: 'bowDistribution', score: 0, flaggedTimestamps: [], severity: 'good', events: [], occurrenceRate: 0, observationSummary: 'Bow tracking is not available on this device.', measurementQuality: 'unavailable' },
  ];
}

// Scoring lives in src/lib/scoring.ts so it stays importable from plain Node
// tests — this module pulls in supabase and expo-file-system, which don't.
// Re-exported here because every existing caller imports it from this path.
export { computeOverallScore, activeScoreWeights, HIDDEN_SCORE_KEYS } from '../lib/scoring';

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
    llm_feedback: result.llmFeedback ?? null,
    pattern_findings: result.patternFindings ?? null,
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

/** Cache Claude coaching on the session row so re-viewing never re-calls the LLM. */
export async function updateSessionLlmFeedback(
  sessionId: string,
  feedback: LLMFeedback,
  /**
   * The drill plan the student actually sees, stored in `sessions.coach_plan`
   * so chat can talk about it by the names on screen.
   *
   * These are the DETERMINISTIC block titles from practiceBlocks.ts, not the
   * LLM's. The model never invents a drill — applyCuratedCopy only overwrites a
   * block's `reason` — so storing its titles meant chat described exercises the
   * student had never seen. Deliberately not folded into llm_feedback: the plan
   * is rendered from useCuratedPlanStore, and a second copy there could be read
   * back as a stale source of truth. This copy is a record of what we told them.
   */
  coachPlan?: { title: string; minutes: number; whyThisDrill: string }[],
  /** The session's musical picture — see lib/musicalEvidence.ts. */
  musicalEvidence?: unknown,
): Promise<void> {
  const { error } = await supabase
    .from('sessions')
    .update({
      llm_feedback: feedback,
      ...(coachPlan ? { coach_plan: coachPlan } : {}),
      ...(musicalEvidence ? { musical_evidence: musicalEvidence } : {}),
    })
    .eq('id', sessionId);
  if (error) throw error;
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

/**
 * Pick the genuinely-measured figures out of a finished analysis. These live on
 * intonationAnalysis / rhythmAnalysis / vibratoAnalysis, which are in-memory
 * only, so without this they are gone by the next app launch and trends have to
 * fall back to the internal 0-100 score.
 */
export function buildSessionHeadline(result: AnalysisResult): SessionHeadline {
  const headline: SessionHeadline = {};

  const intonation = result.intonationAnalysis;
  if (intonation && intonation.totalNoteEvents > 0) {
    headline.inTuneRate = intonation.inTuneRate;
    headline.totalNotes = intonation.totalNoteEvents;
    headline.tendencyCents = intonation.tendencyCents;
  }

  const stability = result.intonationStabilityAnalysis;
  if (stability && stability.assessedCount > 0) {
    headline.avgDriftCents = stability.avgDriftCents;
  }

  // rhythmAccuracy's occurrenceRate is a real fraction of off-grid notes
  // (audioEngine computes it as 1 - onGridCount/iois.length), unlike the
  // metrics whose occurrenceRate is just their score restated.
  const rhythm = result.metrics.find((m) => m.key === 'rhythmAccuracy');
  if (rhythm && rhythm.measurementQuality !== 'unavailable') {
    headline.onGridRate = 1 - rhythm.occurrenceRate;
  }
  if (result.rhythmAnalysis?.bpmEst) {
    headline.bpmEst = result.rhythmAnalysis.bpmEst;
  }

  // Likewise toneQuality's is a real fraction of session time (sectionSecs/duration).
  const tone = result.metrics.find((m) => m.key === 'toneQuality');
  if (tone && tone.measurementQuality !== 'unavailable') {
    headline.cleanToneRate = 1 - tone.occurrenceRate;
  }

  const vibrato = result.vibratoAnalysis;
  if (vibrato && vibrato.eligibleCount > 0) {
    headline.vibratoEligible = vibrato.eligibleCount;
    headline.vibratoAvgScore = vibrato.avgNoteScore;
  }

  return headline;
}

/**
 * Build the persisted per-metric history record for a session.
 *
 * Drops the per-frame debug payloads: MetricScore carries `timeSeries`,
 * `debugSeries` and `_dynDebug` for the live results screen, and persisting
 * those across 13 metrics × every session would grow AsyncStorage without
 * bound. Their type comments already say they aren't persisted.
 */
export function sessionToMetricHistoryEntry(result: AnalysisResult): MetricHistoryEntry {
  const scores: MetricScore[] = result.metrics.map((metric) => {
    const { timeSeries, debugSeries, _dynDebug, ...rest } = metric;
    return rest;
  });

  return {
    sessionId: result.sessionId,
    recordedAt: result.recordedAt,
    scores,
    evidence: result.sessionEvidence,
    // Carried so a later analysis improvement can tell this copy is stale.
    // History keeps no raw material, so an unstamped entry can only be trusted
    // or discarded — see withoutStaleEvidence.
    evidenceVersion: result.evidenceVersion,
    pieceId: result.piece?.id,
    headline: buildSessionHeadline(result),
  };
}

/**
 * Reconstruct a partial AnalysisResult from Supabase for a session recorded in
 * a previous app run (the in-memory sessionResultCache is empty after a
 * restart). Degraded by design: no video, noteEvents, or sessionSignals —
 * the session screen renders scores/feedback without them.
 */
export async function fetchSessionResult(sessionId: string): Promise<AnalysisResult | null> {
  const { data: session, error } = await supabase
    .from('sessions')
    .select('id, user_id, instrument, duration_seconds, recorded_at, overall_score, overall_delta, llm_feedback, pattern_findings, pieces(id, title, composer)')
    .eq('id', sessionId)
    .maybeSingle();
  if (error) throw error;
  if (!session) return null;

  const { data: metricRows, error: metricsError } = await supabase
    .from('metric_scores')
    .select('metric_key, score, delta, flagged_timestamps')
    .eq('session_id', sessionId);
  if (metricsError) throw metricsError;

  const metrics: MetricScore[] = (metricRows ?? []).map((row: any) => ({
    key: row.metric_key,
    score: row.score,
    delta: row.delta ?? undefined,
    flaggedTimestamps: row.flagged_timestamps ?? [],
    severity: severityFromScore(row.score),
    events: [],
    occurrenceRate: 0,
    observationSummary: '',
  }));

  const s: any = session;
  return {
    sessionId: s.id,
    userId: s.user_id,
    instrument: s.instrument,
    piece: s.pieces
      ? { id: s.pieces.id, title: s.pieces.title, composer: s.pieces.composer ?? undefined, source: 'manual' }
      : undefined,
    durationSeconds: s.duration_seconds,
    recordedAt: s.recorded_at,
    overallScore: s.overall_score,
    overallDelta: s.overall_delta ?? undefined,
    metrics,
    audioMetrics: metrics,
    videoMetrics: [],
    llmFeedback: s.llm_feedback ?? undefined,
    patternFindings: s.pattern_findings ?? undefined,
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
