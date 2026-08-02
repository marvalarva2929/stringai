import type {
  AnalysisResult,
  MetricKey,
  MetricScore,
  MeasurementQuality,
  PlayerCategory,
  PitchClassIssue,
} from '../types/analysis';
import type { MetricHistoryEntry } from '../store/useAnalysisStore';
import { METRIC_META } from '../constants/metricMeta';
import { collectIssueSources, mergeIssues } from './practiceIssues';

export type PracticeEvidenceKind =
  | 'pitch_note'
  | 'pitch_tendency'
  | 'intonation_stability'
  | 'vibrato'
  | 'rhythm'
  | 'tone'
  | 'bow_pattern'
  | 'phrase'
  | 'metric_fallback';

export interface PracticeEvidenceTarget {
  metricKey?: MetricKey;
  pitchClass?: string;
  midiNote?: number;
  noteName?: string;
  string?: string;
  finger?: number;
  tendency?: string;
  startSeconds?: number;
  endSeconds?: number;
  phraseId?: number;
  /** Detected tempo (BPM) from the flagged session's rhythm analysis — seeds the
   *  click-track drill at the tempo the player actually struggled at, instead of
   *  a generic default. */
  bpmEst?: number;
  /** Dominant MetricScore.events[].type for this metric (e.g. a ToneFault name)
   *  — lets the block builder route to a fault-specific exercise instead of
   *  the generic per-metric one. Undefined when the metric has no events or
   *  they're not distinguishing. */
  faultType?: string;
}

export interface PracticeEvidence {
  id: string;
  kind: PracticeEvidenceKind;
  metricKey: MetricKey;
  title: string;
  reason: string;
  evidenceSummary: string;
  priority: number;
  confidence: number;
  supportsLive: boolean;
  requiresMic: boolean;
  requiresCamera: boolean;
  measurementAvailable: boolean;
  /** Quality of the measurement behind this issue. Statistical findings and
   *  note-level evidence are inherently 'high' (left undefined = high); only
   *  metric-derived evidence can be 'proxy' or 'low'. Used to stop the LLM
   *  curator resting a root cause on a proxy-quality signal. */
  measurementQuality?: MeasurementQuality;
  sourceSessionId?: string;
  sourceRecordedAt?: string;
  sessionCount: number;
  target: PracticeEvidenceTarget;
}

export interface PracticeEvidenceInput {
  recentSessions?: AnalysisResult[];
  metricHistory?: MetricHistoryEntry[];
  sessionWindow?: number;
  playerCategory?: PlayerCategory | null;
}

export interface PracticeEvidenceResult {
  sessionCount: number;
  evidence: PracticeEvidence[];
  allMetricAverages: Partial<Record<MetricKey, number>>;
}

// Measurement isn't reliable enough yet — excluded from evidence/exercises
// even if older persisted data still references them (see poseScoring.ts's
// scorePoseMetrics(), which no longer computes either metric).
const UNTRACKED_METRICS = new Set<MetricKey>(['bowArmLevel', 'leftHandWrist']);

const FORM_METRICS = new Set<MetricKey>([
  'posture',
  'leftHandWrist',
  'bowPlacement',
  'bowAngle',
  'bowArmLevel',
  'bowDistribution',
]);

const BOW_METRICS = new Set<MetricKey>([
  'bowPlacement',
  'bowAngle',
  'bowArmLevel',
  'bowDistribution',
  'bowSmoothness',
]);

const METRIC_TO_KIND: Partial<Record<MetricKey, PracticeEvidenceKind>> = {
  pitchAccuracy: 'pitch_note',
  intonationStability: 'intonation_stability',
  toneQuality: 'tone',
  bowSmoothness: 'bow_pattern',
  vibrato: 'vibrato',
  rhythmAccuracy: 'rhythm',
  dynamicControl: 'phrase',
  bowPlacement: 'bow_pattern',
  bowAngle: 'bow_pattern',
  bowArmLevel: 'bow_pattern',
  bowDistribution: 'bow_pattern',
  leftHandWrist: 'metric_fallback',
  posture: 'metric_fallback',
};

function metricLabel(key: MetricKey): string {
  return METRIC_META[key]?.label ?? key;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function normalizeSessions(sessions: AnalysisResult[] = [], sessionWindow: number): AnalysisResult[] {
  const byId = new Map<string, AnalysisResult>();
  for (const session of sessions) byId.set(session.sessionId, session);
  return [...byId.values()]
    .sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime())
    .slice(0, sessionWindow);
}

export function computeMetricAverages(
  metricHistory: MetricHistoryEntry[] = [],
  recentSessions: AnalysisResult[] = [],
  sessionWindow = 5,
): Partial<Record<MetricKey, number>> {
  const accumulator = new Map<MetricKey, number[]>();
  const recentHistory = metricHistory.slice(0, sessionWindow);

  if (recentHistory.length > 0) {
    for (const entry of recentHistory) {
      for (const score of entry.scores) {
        const scores = accumulator.get(score.key) ?? [];
        scores.push(score.score);
        accumulator.set(score.key, scores);
      }
    }
  } else {
    for (const session of normalizeSessions(recentSessions, sessionWindow)) {
      for (const score of session.metrics) {
        const scores = accumulator.get(score.key) ?? [];
        scores.push(score.score);
        accumulator.set(score.key, scores);
      }
    }
  }

  const averages: Partial<Record<MetricKey, number>> = {};
  for (const [key, scores] of accumulator.entries()) {
    averages[key] = Math.round(average(scores));
  }
  return averages;
}

function metricMeasurementAvailable(metric: MetricScore): boolean {
  return metric.measurementQuality !== 'unavailable';
}

function liveRequirementsForMetric(metricKey: MetricKey): Pick<PracticeEvidence, 'supportsLive' | 'requiresMic' | 'requiresCamera'> {
  if (BOW_METRICS.has(metricKey) || FORM_METRICS.has(metricKey)) {
    return { supportsLive: true, requiresMic: false, requiresCamera: true };
  }
  return { supportsLive: true, requiresMic: true, requiresCamera: false };
}

function pushEvidence(
  byId: Map<string, PracticeEvidence>,
  evidence: PracticeEvidence,
): void {
  const current = byId.get(evidence.id);
  if (!current || evidence.priority + evidence.confidence > current.priority + current.confidence) {
    byId.set(evidence.id, evidence);
  }
}

function pieceSuffix(session: AnalysisResult): string {
  return session.piece?.title ? ` in ${session.piece.title}` : '';
}

function stringAndFingerFromMidi(midi?: number): { string?: 'G' | 'D' | 'A' | 'E'; finger?: number } {
  if (midi == null) return {};
  const string = inferStringFromMidi(midi);
  const finger = inferFingerFromMidi(midi, string);
  return { string, finger };
}

const OPEN_STRING_HZ: Record<'G' | 'D' | 'A' | 'E', number> = {
  G: 196.0,
  D: 293.7,
  A: 440.0,
  E: 659.3,
};

function inferStringFromMidi(midi: number): 'G' | 'D' | 'A' | 'E' {
  const hz = midiToHz(midi);
  if (hz >= 659) return 'E';
  if (hz >= 440) return 'A';
  if (hz >= 294) return 'D';
  return 'G';
}

function inferFingerFromMidi(midi: number, str: 'G' | 'D' | 'A' | 'E'): number {
  const hz = midiToHz(midi);
  const semis = Math.max(0, Math.round(12 * Math.log2(hz / OPEN_STRING_HZ[str])));
  if (semis === 0) return 0;
  if (semis <= 2) return 1;
  if (semis <= 4) return 2;
  if (semis <= 6) return 3;
  return 4;
}

function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function addPitchNoteEvidence(byId: Map<string, PracticeEvidence>, session: AnalysisResult): void {
  const issues = session.intonationAnalysis?.problemNotes ?? [];
  for (const issue of issues.slice(0, 4)) {
    if (!isActionablePitchIssue(issue)) continue;
    const tendency = issue.tendency === 'mixed' ? 'inconsistently' : issue.tendency;
    pushEvidence(byId, {
      id: `pitch_note:${issue.pitchClass}`,
      kind: 'pitch_note',
      metricKey: 'pitchAccuracy',
      title: `${issue.pitchClass} landing`,
      reason: `${issue.pitchClass} was ${tendency} in ${issue.outOfTuneCount} of ${issue.totalNoteEvents} attempts${pieceSuffix(session)}.`,
      evidenceSummary: `${Math.round(issue.errorRate * 100)}% miss rate, average ${Math.abs(issue.avgDeviationCents).toFixed(0)} cents ${issue.tendency}.`,
      priority: 96 + issue.errorRate * 24 + Math.min(issue.outOfTuneCount, 10),
      confidence: clamp01(issue.totalNoteEvents / 12),
      supportsLive: true,
      requiresMic: true,
      requiresCamera: false,
      measurementAvailable: true,
      sourceSessionId: session.sessionId,
      sourceRecordedAt: session.recordedAt,
      sessionCount: 1,
      target: {
        metricKey: 'pitchAccuracy',
        pitchClass: issue.pitchClass,
        midiNote: issue.representativeMidi,
        ...stringAndFingerFromMidi(issue.representativeMidi),
        tendency: issue.tendency,
        startSeconds: issue.exampleTimestamps?.[0]?.startSeconds,
        endSeconds: issue.exampleTimestamps?.[0]?.endSeconds,
      },
    });
  }
}

function isActionablePitchIssue(issue: PitchClassIssue): boolean {
  return issue.totalNoteEvents >= 2 && (issue.errorRate >= 0.3 || Math.abs(issue.avgDeviationCents) >= 15);
}

function addStabilityEvidence(byId: Map<string, PracticeEvidence>, session: AnalysisResult): void {
  const notes = session.intonationStabilityAnalysis?.worstNotes ?? [];
  for (const note of notes.slice(0, 2)) {
    if (note.noteScore >= 78 && note.driftCents < 12) continue;
    pushEvidence(byId, {
      id: `stability:${note.noteName}`,
      kind: 'intonation_stability',
      metricKey: 'intonationStability',
      title: `${note.noteName} pitch hold`,
      reason: `${note.noteName} wavered during sustained notes${pieceSuffix(session)}.`,
      evidenceSummary: `${note.faultType.replace(/_/g, ' ')} with ${Math.round(note.driftCents)} cents of center-line drift.`,
      priority: 86 + Math.max(0, 80 - note.noteScore),
      confidence: clamp01((note.endS - note.startS) / 3),
      supportsLive: true,
      requiresMic: true,
      requiresCamera: false,
      measurementAvailable: true,
      sourceSessionId: session.sessionId,
      sourceRecordedAt: session.recordedAt,
      sessionCount: 1,
      target: {
        metricKey: 'intonationStability',
        noteName: note.noteName,
        pitchClass: note.noteName,
        startSeconds: note.startS,
        endSeconds: note.endS,
      },
    });
  }
}

function addVibratoEvidence(byId: Map<string, PracticeEvidence>, session: AnalysisResult): void {
  const vibratoMetric = session.metrics.find((m) => m.key === 'vibrato');
  const analysis = session.vibratoAnalysis;
  if (!analysis && (!vibratoMetric || vibratoMetric.score >= 78)) return;

  const worst = analysis?.notes
    ? [...analysis.notes].sort((a, b) => a.noteScore - b.noteScore)[0]
    : undefined;
  if (analysis && analysis.eligibleCount > 0 && analysis.avgNoteScore >= 78 && (!worst || worst.noteScore >= 72)) return;

  // `eligibleCount` counts notes the detector *considered*, not ones it measured.
  // Confidence must come from analysed notes only — otherwise an empty
  // vibratoAnalysis scores 0.75 and outranks corroborated bow findings.
  const measuredNotes = analysis?.notes.length ?? 0;
  const measurementAvailable = measuredNotes > 0;

  const noteLabel = worst ? `note at ${Math.round(worst.startS)}s` : 'sustained notes';
  pushEvidence(byId, {
    id: 'vibrato:primary',
    kind: 'vibrato',
    metricKey: 'vibrato',
    title: 'Vibrato consistency',
    reason: worst
      ? `Vibrato was least stable on the ${noteLabel}.`
      : 'Vibrato needs isolated live practice before it is reliable in pieces.',
    evidenceSummary: worst
      ? `${Math.round(worst.rateHz * 10) / 10} Hz, ${Math.round(worst.depthCents)} cents depth, note score ${Math.round(worst.noteScore)}.`
      : vibratoMetric?.observationSummary ?? 'Vibrato evidence was limited or inconsistent.',
    priority: 88 + Math.max(0, 80 - (analysis?.avgNoteScore ?? vibratoMetric?.score ?? 60)),
    confidence: measurementAvailable ? clamp01(measuredNotes / 8) : 0.35,
    supportsLive: true,
    requiresMic: true,
    requiresCamera: false,
    measurementAvailable,
    sourceSessionId: session.sessionId,
    sourceRecordedAt: session.recordedAt,
    sessionCount: 1,
    target: {
      metricKey: 'vibrato',
      startSeconds: worst?.startS,
      endSeconds: worst?.endS,
    },
  });
}

function addRhythmEvidence(byId: Map<string, PracticeEvidence>, session: AnalysisResult): void {
  const rhythm = session.rhythmAnalysis;
  const metric = session.metrics.find((m) => m.key === 'rhythmAccuracy');
  if (!rhythm && (!metric || metric.score >= 78)) return;
  const issueCount = (rhythm?.rushCount ?? 0) + (rhythm?.dragCount ?? 0);
  if (rhythm && issueCount === 0 && rhythm.gridScore >= 78) return;
  const tendency = rhythm?.tendency ?? 'uneven';
  pushEvidence(byId, {
    id: 'rhythm:primary',
    kind: 'rhythm',
    metricKey: 'rhythmAccuracy',
    title: 'Rhythm grid',
    reason: rhythm?.tendency
      ? `Your timing tended toward ${rhythm.tendency}${pieceSuffix(session)}.`
      : metric?.observationSummary ?? 'Rhythm needs a controlled metronome check.',
    evidenceSummary: rhythm
      ? `${issueCount} timing regions, estimated tempo ${Math.round(rhythm.bpmEst)} BPM.`
      : metric?.observationSummary ?? 'Metric score flagged rhythm accuracy.',
    priority: 76 + issueCount * 4 + Math.max(0, 75 - (metric?.score ?? rhythm?.gridScore ?? 65)),
    confidence: rhythm ? clamp01(Math.max(rhythm.totalNotes, issueCount) / 16) : 0.45,
    supportsLive: true,
    requiresMic: true,
    requiresCamera: false,
    measurementAvailable: true,
    sourceSessionId: session.sessionId,
    sourceRecordedAt: session.recordedAt,
    sessionCount: 1,
    target: {
      metricKey: 'rhythmAccuracy',
      tendency,
      startSeconds: rhythm?.flaggedRegions[0]?.startSeconds,
      endSeconds: rhythm?.flaggedRegions[0]?.endSeconds,
      bpmEst: rhythm?.bpmEst,
    },
  });
}

function addPatternEvidence(byId: Map<string, PracticeEvidence>, session: AnalysisResult): void {
  for (const finding of session.patternFindings ?? []) {
    const metricKey = metricForFinding(finding.testId);
    const kind = kindForFinding(finding.testId);
    const isBow = kind === 'bow_pattern';
    pushEvidence(byId, {
      id: `pattern:${finding.testId}`,
      kind,
      metricKey,
      title: titleForFinding(finding.testId),
      reason: finding.summary,
      evidenceSummary: `${finding.evidence.groupA.label}: ${formatEvidenceValue(finding.evidence.groupA.value)}; ${finding.evidence.groupB.label}: ${formatEvidenceValue(finding.evidence.groupB.value)}.`,
      priority: 82 + finding.confidence * 18 + severityBoost(finding.severity),
      confidence: finding.confidence,
      supportsLive: true,
      requiresMic: !isBow,
      requiresCamera: isBow,
      measurementAvailable: true,
      sourceSessionId: session.sessionId,
      sourceRecordedAt: session.recordedAt,
      sessionCount: 1,
      target: {
        metricKey,
        startSeconds: finding.timestamps[0]?.startSeconds,
        endSeconds: finding.timestamps[0]?.endSeconds,
      },
    });
  }
}

/** Most frequent MetricScore.events[].type, or undefined if there are none. */
function dominantFaultType(metric: MetricScore): string | undefined {
  if (!metric.events || metric.events.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const event of metric.events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function addMetricEvidence(byId: Map<string, PracticeEvidence>, session: AnalysisResult): void {
  for (const metric of session.metrics) {
    if (UNTRACKED_METRICS.has(metric.key)) continue;
    if (metric.score >= 78 || !metricMeasurementAvailable(metric)) continue;
    const kind = METRIC_TO_KIND[metric.key] ?? 'metric_fallback';
    const reqs = liveRequirementsForMetric(metric.key);
    pushEvidence(byId, {
      id: `metric:${metric.key}`,
      kind,
      metricKey: metric.key,
      title: metricLabel(metric.key),
      reason: metric.observationSummary || `${metricLabel(metric.key)} is the lowest recent technique area.`,
      evidenceSummary: `Recent score ${metric.score}; severity ${metric.severity.replace(/_/g, ' ')}.`,
      priority: 62 + Math.max(0, 85 - metric.score),
      confidence: metric.flaggedTimestamps.length > 0 ? 0.75 : 0.5,
      ...reqs,
      measurementAvailable: metricMeasurementAvailable(metric),
      measurementQuality: metric.measurementQuality,
      sourceSessionId: session.sessionId,
      sourceRecordedAt: session.recordedAt,
      sessionCount: 1,
      target: {
        metricKey: metric.key,
        startSeconds: metric.flaggedTimestamps[0]?.startSeconds,
        endSeconds: metric.flaggedTimestamps[0]?.endSeconds,
        faultType: dominantFaultType(metric),
      },
    });
  }
}

function addMetricHistoryFallback(
  byId: Map<string, PracticeEvidence>,
  metricHistory: MetricHistoryEntry[],
  sessionWindow: number,
): void {
  const recent = metricHistory.slice(0, sessionWindow);
  if (recent.length === 0) return;
  const scoresByMetric = new Map<MetricKey, MetricScore[]>();
  for (const entry of recent) {
    for (const score of entry.scores) {
      const scores = scoresByMetric.get(score.key) ?? [];
      scores.push(score);
      scoresByMetric.set(score.key, scores);
    }
  }

  for (const [metricKey, scores] of scoresByMetric.entries()) {
    if (UNTRACKED_METRICS.has(metricKey)) continue;
    const avgScore = average(scores.map((s) => s.score));
    if (avgScore >= 85) continue;
    const sample = scores[0];
    const measurementAvailable = scores.some(metricMeasurementAvailable);
    // Best quality seen across the window's samples for this metric.
    const quality: MeasurementQuality | undefined =
      scores.find((s) => s.measurementQuality === 'high')?.measurementQuality ??
      scores.find((s) => s.measurementQuality === 'proxy')?.measurementQuality ??
      scores.find((s) => s.measurementQuality)?.measurementQuality;
    const reqs = liveRequirementsForMetric(metricKey);
    pushEvidence(byId, {
      id: `history:${metricKey}`,
      kind: METRIC_TO_KIND[metricKey] ?? 'metric_fallback',
      metricKey,
      title: metricLabel(metricKey),
      reason: `${metricLabel(metricKey)} has averaged ${Math.round(avgScore)} across recent sessions.`,
      evidenceSummary: sample.observationSummary || `Average score ${Math.round(avgScore)} from ${scores.length} recent samples.`,
      priority: 54 + (100 - avgScore) * (scores.length / recent.length),
      confidence: clamp01(scores.length / recent.length),
      ...reqs,
      measurementAvailable,
      measurementQuality: quality,
      supportsLive: reqs.supportsLive && measurementAvailable,
      sourceSessionId: recent[0]?.sessionId,
      sourceRecordedAt: recent[0]?.recordedAt,
      sessionCount: scores.length,
      target: { metricKey },
    });
  }
}

function metricForFinding(testId: string): MetricKey {
  if (testId.includes('vibrato')) return 'vibrato';
  if (testId.includes('rhythm')) return 'rhythmAccuracy';
  if (testId.includes('dynamic') || testId.includes('phrase')) return 'dynamicControl';
  if (testId.includes('tone')) return 'toneQuality';
  if (testId.includes('bow') || testId.includes('tip')) return 'bowDistribution';
  return 'pitchAccuracy';
}

function kindForFinding(testId: string): PracticeEvidenceKind {
  if (testId.includes('bow') || testId.includes('tip')) return 'bow_pattern';
  if (testId.includes('dynamic') || testId.includes('phrase')) return 'phrase';
  if (testId.includes('tone')) return 'tone';
  if (testId.includes('rhythm')) return 'rhythm';
  if (testId.includes('finger') || testId.includes('tendency')) return 'pitch_tendency';
  return 'metric_fallback';
}

function titleForFinding(testId: string): string {
  const titles: Record<string, string> = {
    intonation_fatigue: 'End-of-session intonation',
    finger_accuracy_gap: 'Finger accuracy gap',
    pitch_tendency: 'Pitch tendency',
    dynamic_range_narrow: 'Dynamic range',
    bow_distribution_narrow: 'Bow distribution',
    upper_bow_tone_degradation: 'Upper-bow tone',
    tip_dynamic_ceiling: 'Tip dynamic ceiling',
  };
  return titles[testId] ?? testId.replace(/_/g, ' ');
}

function severityBoost(severity: 'minor' | 'moderate' | 'significant'): number {
  if (severity === 'significant') return 12;
  if (severity === 'moderate') return 7;
  return 3;
}

function formatEvidenceValue(value: number): string {
  if (Math.abs(value) < 1) return value.toFixed(2);
  return Math.round(value).toString();
}

/**
 * All practice evidence for a SINGLE session, computed from its analyses. This
 * is the unit that gets persisted on the AnalysisResult at analysis time so the
 * results screen and the daily plan read the exact same issues — one source of
 * truth rather than two independent derivations.
 */
export function buildSessionEvidence(session: AnalysisResult): PracticeEvidence[] {
  const byId = new Map<string, PracticeEvidence>();
  addPitchNoteEvidence(byId, session);
  addStabilityEvidence(byId, session);
  addVibratoEvidence(byId, session);
  addRhythmEvidence(byId, session);
  addPatternEvidence(byId, session);
  addMetricEvidence(byId, session);
  return [...byId.values()];
}

export function buildPracticeEvidence(input: PracticeEvidenceInput): PracticeEvidenceResult {
  const sessionWindow = input.sessionWindow ?? 5;
  const sessions = normalizeSessions(input.recentSessions, sessionWindow);
  const metricHistory = input.metricHistory ?? [];

  // Gather frozen per-session evidence (rich sessions + persisted history) and
  // merge it through the shared query layer, so the daily plan applies the same
  // recurrence-boost + recency-decay as issuesRecent — one aggregation path.
  const sources = collectIssueSources({ recentSessions: input.recentSessions, metricHistory });
  const byId = new Map<string, PracticeEvidence>();
  for (const evidence of mergeIssues(sources.slice(0, sessionWindow))) byId.set(evidence.id, evidence);

  // Score-level fallback covers metrics from sessions saved before evidence was
  // frozen; pushEvidence keeps the stronger of any overlap.
  addMetricHistoryFallback(byId, metricHistory, sessionWindow);

  const evidence = [...byId.values()].sort((a, b) => {
    const diff = b.priority * b.confidence - a.priority * a.confidence;
    if (diff !== 0) return diff;
    return a.title.localeCompare(b.title);
  });

  return {
    sessionCount: Math.max(sources.length, sessions.length, Math.min(metricHistory.length, sessionWindow)),
    evidence,
    allMetricAverages: computeMetricAverages(metricHistory, sessions, sessionWindow),
  };
}
