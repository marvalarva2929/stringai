/**
 * LLM Feedback Generation
 *
 * Generates specific, event-based coaching from the session's metric observations.
 *
 * Currently implemented as a local generator that produces coaching directly
 * from observation summaries and technique meta. This is designed so the
 * implementation can be swapped to a Supabase Edge Function call with no
 * changes to the call site:
 *
 *   // Future: replace localFeedbackGeneration with:
 *   const { data } = await supabase.functions.invoke('generate-coaching', { body: req });
 *   return data as LLMFeedback;
 */

import { MetricScore, LLMFeedback, LLMCoachingItem, PlayerCategory, IntonationAnalysis } from '../types/analysis';
import { METRIC_META } from '../constants/metricMeta';
import { EXERCISES } from '../constants/exercises';
import { Piece } from '../types/piece';
import { INTONATION_COACHING, PITCH_CLASS_TO_FINGER } from '../constants/intonationSpec';

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
