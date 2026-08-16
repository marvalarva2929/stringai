/**
 * Assembles the CoachContext both AI surfaces read.
 *
 * Chat used to receive five fields per session (date, score, top issue, piece,
 * duration) and nothing about what the coach had recommended, so it could not
 * answer "why am I doing this drill?" — it had never been told there was a
 * drill. This builder is the fix: one description of the student, handed to
 * post-session coaching and to chat alike.
 *
 * Pure and dependency-free (no stores, no services) so it runs under the Node
 * test harness, matching lib/streak.ts and lib/entitlements.ts.
 */

import type { CoachContext, CoachingSummary, SessionContext } from
  '../../supabase/functions/_shared/coachContext';
import { CATEGORIES } from '../constants/categories';
import type { LLMFeedback, MetricScore, SessionSummary } from '../types/analysis';
import type { MetricHistoryEntry } from '../store/useAnalysisStore';

export type { CoachContext } from '../../supabase/functions/_shared/coachContext';

/** Mean of the metrics in a category, rounded. Undefined when none were measured. */
function categoryScore(scores: MetricScore[], keys: string[]): number | undefined {
  const present = scores.filter((s) => keys.includes(s.key));
  if (present.length === 0) return undefined;
  return Math.round(present.reduce((sum, s) => sum + s.score, 0) / present.length);
}

/** Per-category rollup, e.g. { intonation: 72, tone: 54 }. */
export function categoryScores(scores: MetricScore[]): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const cat of CATEGORIES) {
    const score = categoryScore(scores, cat.keys);
    if (score !== undefined) out[cat.id] = score;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The coach's output, reduced to what a conversation needs: the take, the
 * causes, and the drills. Deliberately drops issue ids and per-phrase notes —
 * chat talks to the student, and neither is speakable.
 */
export function coachingSummary(
  feedback: LLMFeedback | undefined,
  /**
   * The plan as rendered, from the session row. Read separately because
   * `feedback.curatedBlocks` is ALWAYS absent here: analyze.tsx strips it
   * before caching (it lives in useCuratedPlanStore), so the previous version
   * of this function produced an empty block list for every session without
   * ever failing — the client half of the exercise sync was dead code.
   */
  plan?: { title: string; minutes: number; whyThisDrill: string }[],
): CoachingSummary | undefined {
  if (!feedback && !plan) return undefined;
  const rootCauses = (feedback?.rootCauses ?? []).map((c) => ({
    label: c.label,
    explanation: c.explanation,
  }));
  const blocks = (plan ?? []).map((b) => ({
    title: b.title,
    minutes: b.minutes,
    whyThisDrill: b.whyThisDrill,
  }));
  if (!feedback?.overallTake && rootCauses.length === 0 && blocks.length === 0) return undefined;
  return { summary: feedback?.overallTake ?? '', rootCauses, blocks };
}

export interface BuildCoachContextInput {
  instrument: string;
  skillLevel?: string;
  playerCategory?: string;
  /** Most recent first — the app already stores it that way. */
  sessionHistory: SessionSummary[];
  /** Per-session metric scores, for category rollups. Keyed by session id. */
  metricHistory?: MetricHistoryEntry[];
  /**
   * The coach's stored output per session id. Only the newest few are actually
   * rendered (see SESSIONS_WITH_FULL_COACHING), so callers need not resolve
   * every session's feedback.
   */
  coachingBySessionId?: Record<string, LLMFeedback | undefined>;
  /** The plan as rendered, per session id. */
  planBySessionId?: Record<string, { title: string; minutes: number; whyThisDrill: string }[] | undefined>;
  /**
   * The musical picture per session id. Supplied by the client so a session
   * analysed seconds ago can be discussed before the server write has landed —
   * musical_evidence is written with the coaching upgrade, which arrives
   * several seconds after the results screen does.
   */
  musicalEvidenceBySessionId?: Record<string, unknown>;
}

export function buildCoachContext(input: BuildCoachContextInput): CoachContext {
  const scoresBySession = new Map<string, MetricScore[]>();
  for (const entry of input.metricHistory ?? []) {
    scoresBySession.set(entry.sessionId, entry.scores);
  }

  const sessions: SessionContext[] = input.sessionHistory.map((s) => {
    const scores = scoresBySession.get(s.id);
    return {
      sessionId: s.id,
      recordedAt: s.recordedAt,
      overallScore: s.overallScore,
      overallDelta: s.overallDelta,
      piece: s.piece?.title,
      durationSeconds: s.durationSeconds,
      categoryScores: scores ? categoryScores(scores) : undefined,
      topIssue: s.topIssue,
      coaching: coachingSummary(
        input.coachingBySessionId?.[s.id],
        input.planBySessionId?.[s.id],
      ),
      musicalEvidence: input.musicalEvidenceBySessionId?.[s.id],
    };
  });

  return {
    instrument: input.instrument,
    skillLevel: input.skillLevel,
    playerCategory: input.playerCategory,
    sessions,
  };
}
