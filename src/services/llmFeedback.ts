/**
 * LLM Feedback Generation
 *
 * Two paths:
 *  - fetchCoachingFeedback(): Supabase Edge Function → Claude (L10). Async,
 *    network-dependent, returns richer feedback (phrase notes, practice plan).
 *  - buildSessionFeedback(): local template generator. Synchronous, offline,
 *    used as the immediate result and as the fallback when the Edge call
 *    fails or the user is not authenticated.
 */

import { MetricScore, LLMFeedback, LLMCoachingItem, PlayerCategory, IntonationAnalysis } from '../types/analysis';
import { METRIC_META } from '../constants/metricMeta';
import { EXERCISES } from '../constants/exercises';
import { Piece } from '../types/piece';
import { INTONATION_COACHING, PITCH_CLASS_TO_FINGER } from '../constants/intonationSpec';
import { supabase } from './supabase';
import type { StatisticalFinding } from '../lib/patternDetection';
import type { PhraseFeatures } from '../lib/phraseFeatures';
import type { PracticeEvidence } from '../lib/practiceEvidence';

/** Compact the frozen issue set into what the coaching model may cite. */
export function issuesForCoaching(
  issues: PracticeEvidence[],
): NonNullable<CoachingInput['issues']> {
  return issues.map((issue) => ({
    id: issue.id,
    summary: `${issue.title}: ${issue.evidenceSummary || issue.reason}`,
    quality: (issue.measurementQuality === 'proxy' || issue.measurementQuality === 'low'
      ? issue.measurementQuality
      : 'high') as 'high' | 'proxy' | 'low',
  }));
}

// ─────────────────────────────────────────────────────────────
// Edge Function path (L10 — Claude coaching)
// ─────────────────────────────────────────────────────────────

export interface CoachingInput {
  instrument: string;
  piece?: { title: string; composer?: string };
  skillLevel: 'beginner' | 'intermediate' | 'advanced';
  playerCategory: PlayerCategory;
  metrics: { key: string; score: number; severity: string; observationSummary: string }[];
  patternFindings: { testId: string; summary: string; evidence: unknown; severity: string }[];
  phraseFeatures?: PhraseFeatures[];
  /** The exact issue set the model may cite. Every curated block/root cause must
   *  reference one of these ids — the client rejects any it invents. */
  issues?: { id: string; summary: string; quality: 'high' | 'proxy' | 'low' }[];
}

const EDGE_TIMEOUT_MS = 10_000;

export function buildCoachingInput(
  metrics: MetricScore[],
  playerCategory: PlayerCategory,
  skillLevel: 'beginner' | 'intermediate' | 'advanced',
  piece?: Piece,
  findings?: StatisticalFinding[],
  phraseFeatures?: PhraseFeatures[],
  issues?: PracticeEvidence[],
): CoachingInput {
  return {
    instrument: 'violin',
    piece: piece ? { title: piece.title, composer: piece.composer } : undefined,
    skillLevel,
    playerCategory,
    metrics: metrics
      .filter((m) => m.measurementQuality !== 'unavailable')
      .map((m) => ({
        key: m.key,
        score: m.score,
        severity: m.severity,
        observationSummary: m.observationSummary,
      })),
    patternFindings: (findings ?? []).map((f) => ({
      testId: f.testId,
      summary: f.summary,
      evidence: f.evidence,
      severity: f.severity,
    })),
    phraseFeatures,
    issues: issues ? issuesForCoaching(issues) : undefined,
  };
}

/** Thrown when the caller is not entitled to Claude coaching (Edge Function 402). */
export class EntitlementRequiredError extends Error {
  constructor() {
    super('Claude coaching requires an active Pro subscription.');
    this.name = 'EntitlementRequiredError';
  }
}

/**
 * Call the analyze-feedback Edge Function (Claude). Throws on network error,
 * timeout, or malformed response — the caller keeps the static fallback.
 *
 * A free user reaching this throws EntitlementRequiredError, which callers must
 * swallow silently: free users hit it on every session by design, so surfacing
 * it as an error would mean an error toast after every analysis.
 */
export async function fetchCoachingFeedback(input: CoachingInput): Promise<LLMFeedback> {
  const invoke = supabase.functions.invoke('analyze-feedback', { body: input });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('coaching request timed out')), EDGE_TIMEOUT_MS),
  );
  const { data, error } = await Promise.race([invoke, timeout]);
  if (error) {
    // supabase-js wraps a non-2xx as FunctionsHttpError with the Response on
    // `context`; a 402 is the server declining, not a failure worth retrying.
    const status = (error as { context?: { status?: number } }).context?.status;
    if (status === 402) throw new EntitlementRequiredError();
    throw error;
  }

  if (typeof data?.summary !== 'string' || !Array.isArray(data?.insights)) {
    throw new Error('malformed coaching response');
  }

  return {
    overallTake: data.summary,
    items: data.insights.map((i: any): LLMCoachingItem => ({
      metricKey: i.metricKey,
      observation: i.observation ?? '',
      feedback: i.feedback ?? '',
      exercise: i.exercise || undefined,
    })),
    phraseFeedback: Array.isArray(data.phrase_feedback) ? data.phrase_feedback : undefined,
    generatedAt: new Date().toISOString(),
    source: 'claude',
  };
}

// ─────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────

export function buildSessionFeedback(
  allMetrics: MetricScore[],
  playerCategory: PlayerCategory,
  piece?: Piece,
  previousMetrics?: MetricScore[],
  intonationAnalysis?: IntonationAnalysis,
): LLMFeedback {
  // Select the top issues: sort by a combined severity signal
  const issues = allMetrics
    .filter((m) => m.measurementQuality !== 'unavailable')
    .filter((m) => m.occurrenceRate > 0.05 || m.score < 78)
    .sort((a, b) => issuePriority(b) - issuePriority(a))
    .slice(0, 4);

  const overallTake = buildOverallTake(issues, playerCategory, piece);

  // Build per-metric coaching items, substituting richer intonation coaching when available.
  // Deduplicate by metricKey — pitchAccuracy and intonationStability both resolve to the
  // same intonation item, so only the first one is kept.
  const items: LLMCoachingItem[] = [];
  const seenKeys = new Set<string>();
  for (const m of issues) {
    let item: LLMCoachingItem;
    if (
      (m.key === 'pitchAccuracy' || m.key === 'intonationStability') &&
      intonationAnalysis &&
      intonationAnalysis.outOfTuneCount > 0
    ) {
      item = buildIntonationCoachingItem(intonationAnalysis, playerCategory);
    } else {
      const prev = previousMetrics?.find((p) => p.key === m.key);
      item = buildCoachingItem(m, playerCategory, prev);
    }
    if (!seenKeys.has(item.metricKey)) {
      seenKeys.add(item.metricKey);
      items.push(item);
    }
  }

  return { overallTake, items, generatedAt: new Date().toISOString() };
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

function issuePriority(m: MetricScore): number {
  // Weight occurrence rate 60%, score severity 40%
  return m.occurrenceRate * 0.6 + (1 - m.score / 100) * 0.4;
}

function buildOverallTake(
  issues: MetricScore[],
  category: PlayerCategory,
  piece?: Piece,
): string {
  const pieceRef = piece ? ` on "${piece.title}"` : '';

  if (issues.length === 0) {
    return category === 'foundation'
      ? `Solid session${pieceRef}. Your fundamentals are coming together — keep the consistency.`
      : `Strong session${pieceRef}. Your technique looked clean throughout. Keep pushing for that consistency.`;
  }

  const top = issues[0];
  const topLabel = METRIC_META[top.key]?.label?.toLowerCase() ?? 'technique';

  if (category === 'foundation') {
    if (issues.length === 1) {
      return `Good effort${pieceRef}. Your main area to focus on right now is ${topLabel} — getting this habit right will unlock faster progress in everything else.`;
    }
    return `Good effort${pieceRef}. The most impactful thing to fix right now is ${topLabel}. Once that habit is established, the other issues will be easier to address.`;
  }

  // Refinement
  if (issues.length === 1) {
    return `Solid session${pieceRef}. Your ${topLabel} is the one thing that will noticeably elevate your playing — clean this up and the overall quality will jump.`;
  }
  return `Solid session${pieceRef}. The biggest opportunity right now is ${topLabel}. Address that first — it has the most impact on what you're trying to achieve${piece ? ' in this piece' : ''}.`;
}

function buildCoachingItem(
  metric: MetricScore,
  category: PlayerCategory,
  prev?: MetricScore,
): LLMCoachingItem {
  const meta = METRIC_META[metric.key];

  // Coaching text from the technique tips, tuned to the current severity
  const baseFeedback = meta?.tips[metric.severity] ?? '';

  // Trend comparison — only surface meaningful changes
  let trendClause = '';
  if (prev && prev.occurrenceRate > 0.05) {
    const improvement = prev.occurrenceRate - metric.occurrenceRate;
    if (improvement >= 0.2) {
      trendClause = ' This is a clear improvement from your last session.';
    } else if (improvement <= -0.2) {
      trendClause = ' This is more of an issue than your last session — worth extra attention this week.';
    }
  } else if (prev && metric.occurrenceRate <= 0.05 && prev.occurrenceRate > 0.15) {
    trendClause = ' Noticeably better than your last session.';
  }

  const feedback = baseFeedback + trendClause;

  // Pick a matched exercise
  const exercises = EXERCISES.filter((e) => e.metricKey === metric.key);
  const preferredDifficulty = metric.score < 50 || category === 'foundation' ? 'beginner' : 'intermediate';
  const exercise =
    exercises.find((e) => e.difficulty === preferredDifficulty) ??
    exercises.find((e) => e.difficulty === 'beginner') ??
    exercises[0];

  return {
    metricKey: metric.key,
    observation: metric.observationSummary,
    feedback,
    exercise: exercise
      ? `${exercise.title} (${exercise.duration}): ${exercise.instructions}`
      : undefined,
  };
}

function buildIntonationCoachingItem(
  analysis: IntonationAnalysis,
  category: PlayerCategory,
): LLMCoachingItem {
  const topNote = analysis.problemNotes[0];

  // Tendency coaching
  let tendencyCoaching = '';
  if (analysis.overallTendency === 'flat') {
    tendencyCoaching = INTONATION_COACHING.flatTendency;
  } else if (analysis.overallTendency === 'sharp') {
    tendencyCoaching = INTONATION_COACHING.sharpTendency;
  }

  // Specific note coaching
  let noteCoaching = '';
  if (topNote) {
    const fingerInfo = PITCH_CLASS_TO_FINGER[topNote.pitchClass];
    if (fingerInfo?.finger === 2 && topNote.tendency === 'flat') {
      noteCoaching = ' ' + INTONATION_COACHING.secondFingerFlat;
    } else if (fingerInfo?.finger === 2 && topNote.tendency === 'sharp') {
      noteCoaching = ' ' + INTONATION_COACHING.secondFingerSharp;
    } else if (fingerInfo?.finger === 3) {
      noteCoaching = ' ' + INTONATION_COACHING.thirdFingerGeneral;
    }
  }

  // Exercise — use the pitch accuracy drill
  const exercises = EXERCISES.filter((e) => e.metricKey === 'pitchAccuracy');
  const exercise =
    exercises.find((e) => e.difficulty === (category === 'foundation' ? 'beginner' : 'intermediate')) ??
    exercises[0];

  const feedback = (tendencyCoaching + noteCoaching).trim() ||
    `Focus on specific notes: practice ${topNote?.pitchClass ?? 'problem notes'} slowly with a tuner drone until the pitch locks in reliably.`;

  return {
    metricKey: 'pitchAccuracy',
    observation: analysis.observationSummary,
    feedback,
    exercise: exercise ? `${exercise.title} (${exercise.duration}): ${exercise.instructions}` : undefined,
  };
}
