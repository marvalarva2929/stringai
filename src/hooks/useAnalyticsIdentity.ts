import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';

import { buildCrashKeys, buildUserProperties } from '../lib/analyticsUserProps';
import type { AnalyticsUserSnapshot } from '../lib/analyticsUserProps';
import { computeStreak } from '../lib/streak';
import { setUserProps } from '../services/analytics';
import { setCrashKeys } from '../services/crashReporting';
import { getCachedAttStatus, refreshTrackingStatus } from '../services/trackingPermission';
import { useActivationStore } from '../store/useActivationStore';
import { useAnalysisStore } from '../store/useAnalysisStore';
import { useAuthStore } from '../store/useAuthStore';
import { useEntitlementStore } from '../store/useEntitlementStore';
import { useOnboardingStore } from '../store/useOnboardingStore';
import { useReminderStore } from '../store/useReminderStore';
import { useUserStore } from '../store/useUserStore';

/** Reads every store at once so a single change republishes a consistent set. */
function snapshot(notifPermission: string | null): AnalyticsUserSnapshot {
  const auth = useAuthStore.getState();
  const { entitlement } = useEntitlementStore.getState();
  const { profile } = useUserStore.getState();
  const activation = useActivationStore.getState();
  const answers = useOnboardingStore.getState();
  const reminders = useReminderStore.getState();
  const { sessionHistory } = useAnalysisStore.getState();

  return {
    tier: entitlement.tier,
    inTrial: entitlement.inTrial,
    isAuthenticated: auth.isAuthenticated,
    skillLevel: profile?.skillLevel ?? answers.experienceId,
    playerCategory: auth.playerCategory,
    // Goals are multi-select; the first is the one the user reached for first.
    learningGoal: answers.learningGoals[0] ?? null,
    dailyTime: answers.dailyTimeId,
    weeklyGoalMinutes: auth.weeklyGoalMinutes,
    violinSize: answers.violinSize,
    handedness: answers.handedness,
    focusPreference: answers.focusPreference,
    activationStep: activation.step,
    usedDemo: activation.usedDemo,
    sessionCount: sessionHistory.length,
    streakDays: computeStreak(sessionHistory),
    remindersEnabled: reminders.enabled,
    notifPermission,
    attStatus: getCachedAttStatus(),
  };
}

/**
 * Keeps GA4 user properties and Crashlytics custom keys in step with app state.
 *
 * These are the dimensions every funnel is sliced by — free vs. pro, activated
 * vs. not, streak bucket — and the context that turns a Crashlytics stack trace
 * into a reproducible scenario. Republished on any relevant store change rather
 * than on a timer, and deduped so a no-op change costs nothing.
 */
export function useAnalyticsIdentity(): void {
  const lastPublished = useRef<string>('');
  const notifPermission = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const publish = () => {
      const s = snapshot(notifPermission.current);
      const props = buildUserProperties(s);
      const serialized = JSON.stringify(props);
      if (serialized === lastPublished.current) return;
      lastPublished.current = serialized;

      setUserProps(props);
      setCrashKeys(buildCrashKeys(s));
    };

    // Both are async reads that feed properties; publish once each resolves.
    Notifications.getPermissionsAsync()
      .then(({ status }) => {
        if (cancelled) return;
        notifPermission.current = status;
        publish();
      })
      .catch(() => {});
    refreshTrackingStatus()
      .then(() => !cancelled && publish())
      .catch(() => {});

    publish();

    const unsubscribers = [
      useAuthStore.subscribe(publish),
      useEntitlementStore.subscribe(publish),
      useUserStore.subscribe(publish),
      useActivationStore.subscribe(publish),
      useOnboardingStore.subscribe(publish),
      useReminderStore.subscribe(publish),
      useAnalysisStore.subscribe(publish),
    ];

    return () => {
      cancelled = true;
      unsubscribers.forEach((u) => u());
    };
  }, []);
}
