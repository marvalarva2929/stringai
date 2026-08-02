import { useEffect, useMemo } from 'react';
import { useAnalysisStore } from '../store/useAnalysisStore';
import { useAuthStore } from '../store/useAuthStore';
import { useUserStore } from '../store/useUserStore';
import { useCuratedPlanStore } from '../store/useCuratedPlanStore';
import { useDailyPlanSnapshotStore } from '../store/useDailyPlanSnapshotStore';
import { computePracticePlan, type PracticePlan, type PlanScope } from '../lib/practicePlan';
import { applyCuratedCopy } from '../lib/practiceCuration';
import type { AnalysisResult } from '../types/analysis';

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

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
  const curatedBlocksByPlan = useCuratedPlanStore((s) => s.curatedBlocksByPlan);

  const richSessions = useMemo(
    () => recentRichSessions(currentResult, sessionResultCache),
    [currentResult, sessionResultCache],
  );

  const scopeKey = scope.kind === 'daily' ? 'daily'
    : scope.kind === 'session' ? `session:${scope.sessionId}`
    : `piece:${scope.pieceId}`;

  const liveBasePlan = useMemo(() => computePracticePlan({
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

  // The daily plan is frozen for the whole calendar day once first computed —
  // a session recorded mid-day must not reshuffle today's warmup, only feed
  // into tomorrow's. Session/piece scopes are unaffected: those are expected
  // to reflect their evidence live.
  const isDaily = scope.kind === 'daily';
  const today = todayDateString();
  const snapshotDate = useDailyPlanSnapshotStore((s) => s.snapshotDate);
  const snapshot = useDailyPlanSnapshotStore((s) => s.snapshot);
  const hasHydrated = useDailyPlanSnapshotStore((s) => s.hasHydrated);
  const setSnapshot = useDailyPlanSnapshotStore((s) => s.setSnapshot);

  useEffect(() => {
    if (!isDaily || !hasHydrated) return;
    if (snapshotDate !== today) setSnapshot(today, liveBasePlan);
  }, [isDaily, hasHydrated, snapshotDate, today, liveBasePlan, setSnapshot]);

  const basePlan =
    isDaily && hasHydrated && snapshotDate === today && snapshot ? snapshot : liveBasePlan;

  // Session-scoped plans may have grounded LLM copy waiting from the
  // analyze-feedback response (see app/(tabs)/analyze.tsx) — overlay it onto
  // the deterministic blocks and surface the root causes that go with it.
  return useMemo(() => {
    const curated = curatedBlocksByPlan[basePlan.id];
    if (!curated || curated.length === 0) return basePlan;
    const rootCauses = scope.kind === 'session'
      ? richSessions.find((s) => s.sessionId === scope.sessionId)?.llmFeedback?.rootCauses
      : undefined;
    return { ...basePlan, blocks: applyCuratedCopy(basePlan.blocks, curated), rootCauses };
  }, [basePlan, curatedBlocksByPlan, richSessions, scope]);
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
