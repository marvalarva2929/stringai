import { useAuthStore } from '../store/useAuthStore';
import { useOnboardingStore } from '../store/useOnboardingStore';
import { useAnalysisStore } from '../store/useAnalysisStore';
import { updateProfileFields, } from '../services/auth';
import { saveSession } from '../services/analysis';
import { isSupabaseConfigured } from '../services/supabase';
import { isDemoSessionId } from './activationDemo';
import { EXPERIENCE_LEVELS } from '../constants/onboardingContent';

/**
 * Pushes the answers collected during onboarding onto the user's `profiles`
 * row, once an account exists to push them to.
 *
 * This used to happen inline at the end of onboarding, because the account was
 * created there. It isn't any more — signing up now happens after the purchase,
 * so the answers sit in local storage for the whole first run and get flushed
 * here when the account finally appears.
 *
 * Fire-and-forget by design, matching saveSession and updateSessionLlmFeedback:
 * a profile write failing is not worth an error dialog in front of someone who
 * has just paid. The answers stay in local storage either way, and
 * reconcileWeeklyGoal in app/_layout.tsx re-syncs the goal on later launches.
 */
export function syncOnboardingAnswersToProfile(userId: string): void {
  const { experienceId } = useOnboardingStore.getState();
  const { weeklyGoalMinutes } = useAuthStore.getState();
  const experience = EXPERIENCE_LEVELS.find((e) => e.id === experienceId);

  updateProfileFields(userId, {
    skill_level: experience?.skillLevel ?? 'beginner',
    ...(weeklyGoalMinutes ? { weekly_goal_minutes: weeklyGoalMinutes } : {}),
  }).catch(() => {});
}

/**
 * Persists the first-run diagnostic once there is an account to attach it to.
 *
 * The diagnostic is a real recording of the user's own playing, but it happens
 * before signup — so processMedia's `saveSession` call is skipped (it requires
 * an authenticated profile id) and the session lives only on the device. That
 * is fine until the user reinstalls or picks up a second device, at which point
 * their first-ever analysis is simply gone, along with the baseline every
 * later "you've improved" comparison is measured against.
 *
 * Only ever touches `currentResult`: it is the one analysis that can predate
 * the account, and it survives restarts (see the persist partialize in
 * useAnalysisStore). The sample analysis is explicitly excluded — it is not the
 * user's playing and must never reach their history.
 */
export function backfillPreAccountSession(userId: string): void {
  if (!isSupabaseConfigured) return;
  const result = useAnalysisStore.getState().currentResult;
  if (!result || isDemoSessionId(result.sessionId)) return;
  // 'guest' is what processMedia stamps when no profile existed at analysis
  // time. Anything else already belongs to a real account.
  if (result.userId !== 'guest') return;

  saveSession({ ...result, userId }).catch(() => {});
}
