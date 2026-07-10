import { useMemo } from 'react';
import { useAnalysisStore } from '../store/useAnalysisStore';
import { useAuthStore } from '../store/useAuthStore';
import { useUserStore } from '../store/useUserStore';
import { computePracticePlan, type PracticePlan, type PlanScope } from '../lib/practicePlan';
import type { AnalysisResult } from '../types/analysis';

function recentRichSessions(
  currentResult: AnalysisResult | null,
  cache: Record<string, AnalysisResult>,
): AnalysisResult[] {
  const byId = new Map<string, AnalysisResult>();
  for (const result of Object.values(cache)) byId.set(result.sessionId, result);
  if (currentResult) byId.set(currentResult.sessionId, currentResult);
  return [...byId.values()].sort(
    (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
  );
}

/** Practice plan for a given scope (daily / session / piece). All three views
 *  read the same frozen evidence; only the scope differs. */
export function usePracticePlan(scope: PlanScope): PracticePlan {
  const metricHistory = useAnalysisStore((s) => s.metricHistory);
  const currentResult = useAnalysisStore((s) => s.currentResult);
  const sessionResultCache = useAnalysisStore((s) => s.sessionResultCache);
  const { playerCategory, weeklyGoalMinutes } = useAuthStore();
  const { profile } = useUserStore();

  const richSessions = useMemo(
    () => recentRichSessions(currentResult, sessionResultCache),
    [currentResult, sessionResultCache],
  );

  const scopeKey = scope.kind === 'daily' ? 'daily'
    : scope.kind === 'session' ? `session:${scope.sessionId}`
    : `piece:${scope.pieceId}`;

  return useMemo(() => computePracticePlan({
    recentSessions: richSessions,
    metricHistory,
    playerCategory: profile?.playerCategory ?? playerCategory,
    weeklyGoalMinutes: profile?.weeklyGoalMinutes ?? weeklyGoalMinutes,
    skillLevel: profile?.skillLevel ?? 'beginner',
    sessionWindow: 5,
    scope,
  }), [
    richSessions,
    metricHistory,
    profile?.playerCategory,
    profile?.weeklyGoalMinutes,
    profile?.skillLevel,
    playerCategory,
    weeklyGoalMinutes,
    scopeKey,
  ]);
}

/** The daily practice plan (recent window across all pieces). */
export function useDailyPracticePlan(): PracticePlan {
  return usePracticePlan({ kind: 'daily' });
}

/** Post-session plan: exercises for exactly the session just analyzed. */
export function useSessionPracticePlan(sessionId: string): PracticePlan {
  return usePracticePlan({ kind: 'session', sessionId });
}

/** Warm-up / focus plan drawn from every session of the pinned piece. */
export function usePiecePracticePlan(pieceId: string): PracticePlan {
  return usePracticePlan({ kind: 'piece', pieceId });
}
