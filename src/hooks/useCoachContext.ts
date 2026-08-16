import { useMemo } from 'react';

import { buildCoachContext, type CoachContext } from '../lib/coachContext';
import { useAnalysisStore } from '../store/useAnalysisStore';
import { useAuthStore } from '../store/useAuthStore';
import { useUserStore } from '../store/useUserStore';
import type { LLMFeedback } from '../types/analysis';

/**
 * The student record, assembled once and shared by every coach surface.
 *
 * Both the standalone chat and the results-carousel chat read this, so neither
 * can end up with a narrower view of the student than the other — the bug this
 * replaces was exactly that: two chat surfaces, two different (and both wrong)
 * pictures of what the coach had said.
 *
 * Coaching output comes from `sessionResultCache`, which is where analyze.tsx
 * puts each result — including the Claude/DeepSeek upgrade once it lands. Only
 * the newest few sessions are actually rendered into the prompt, so an
 * uncached older session costs nothing.
 */
export function useCoachContext(): CoachContext {
  const sessionHistory = useAnalysisStore((s) => s.sessionHistory);
  const metricHistory = useAnalysisStore((s) => s.metricHistory);
  const sessionResultCache = useAnalysisStore((s) => s.sessionResultCache);
  const currentResult = useAnalysisStore((s) => s.currentResult);
  const profile = useUserStore((s) => s.profile);
  const playerCategory = useAuthStore((s) => s.playerCategory);

  return useMemo(() => {
    const coachingBySessionId: Record<string, LLMFeedback | undefined> = {};
    const musicalEvidenceBySessionId: Record<string, unknown> = {};
    for (const [id, result] of Object.entries(sessionResultCache ?? {})) {
      if (result?.llmFeedback) coachingBySessionId[id] = result.llmFeedback;
      if (result?.musicalEvidence) musicalEvidenceBySessionId[id] = result.musicalEvidence;
    }
    // The session on screen may not be in the cache yet on first render.
    if (currentResult?.sessionId) {
      if (currentResult.llmFeedback) {
        coachingBySessionId[currentResult.sessionId] = currentResult.llmFeedback;
      }
      if (currentResult.musicalEvidence) {
        musicalEvidenceBySessionId[currentResult.sessionId] = currentResult.musicalEvidence;
      }
    }

    return buildCoachContext({
      instrument: profile?.instrument ?? 'violin',
      skillLevel: profile?.skillLevel,
      playerCategory: profile?.playerCategory ?? playerCategory ?? undefined,
      sessionHistory,
      metricHistory,
      coachingBySessionId,
      musicalEvidenceBySessionId,
    });
  }, [sessionHistory, metricHistory, sessionResultCache, currentResult, profile, playerCategory]);
}
