import { useAnalysisStore } from '../store/useAnalysisStore';
import { DEMO_ANALYSIS, DEMO_SESSION_ID } from '../constants/demoAnalysis';

/**
 * Puts the sample analysis on screen for a user in activation who doesn't have
 * their instrument to hand.
 *
 * This is the *fallback* path. The first run now asks for a real take — see
 * DiagnosticTake — and only lands here when the user says they can't play right
 * now, or the microphone is unavailable.
 *
 * The important part is everything this deliberately does NOT do. A real
 * analysis (processMedia in app/(tabs)/analyze.tsx) also calls saveSession,
 * addToHistory, addToMetricHistory and cacheSessionResult. Skipping all of them
 * is what keeps the sample out of the user's Supabase rows, their streak
 * (computeStreak reads sessionHistory), and their trends. The diagnostic take
 * deliberately does the opposite: it is the user's own playing, so it counts.
 *
 * setResult moves the store to phase 'done', which is what makes the analyze
 * screen render the results carousel.
 */
export function loadDemoAnalysis(): void {
  useAnalysisStore.getState().setResult(DEMO_ANALYSIS);
}

export const isDemoSessionId = (sessionId: string | undefined): boolean =>
  sessionId === DEMO_SESSION_ID;
