import { useEffect, useState, useRef } from 'react';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { supabase, isSupabaseConfigured } from '../src/services/supabase';
import { useAuthStore } from '../src/store/useAuthStore';
import { useUserStore } from '../src/store/useUserStore';
import { useAnalysisStore } from '../src/store/useAnalysisStore';
import { useEntitlementStore } from '../src/store/useEntitlementStore';
import { useActivationStore } from '../src/store/useActivationStore';
import { SubscribeGate, useSubscribeGateActive } from '../src/components/paywall/SubscribeGate';
import { SubscribedReviewHost } from '../src/components/activation/SubscribedReviewHost';
import { AccountGate, useAccountGateActive } from '../src/components/auth/AccountGate';
import { syncTrialRecap } from '../src/services/trialRecapScheduler';
import {
  configurePurchases,
  identifyPurchaser,
  logOutPurchaser,
  onCustomerInfoChange,
  getCustomerInfo,
  restorePurchases,
  setFirebaseAppInstanceId,
} from '../src/services/purchases';
import { fetchProfile, updateProfileFields } from '../src/services/auth';
import { fetchSessionHistory } from '../src/services/analysis';
import { fetchAppInstanceId, setAnalyticsUser, track } from '../src/services/analytics';
import { AnalyticsEvent } from '../src/constants/analyticsEvents';
import { daysAwayBucket } from '../src/lib/analyticsUserProps';
import { daysBetween } from '../src/lib/analyticsTiming';
import { initCrashReporting, setCrashUser, qaCheckpoint } from '../src/services/crashReporting';
import { useAnalyticsIdentity } from '../src/hooks/useAnalyticsIdentity';
import { useScreenTracking } from '../src/hooks/useScreenTracking';
import { UserProfile } from '../src/types/user';
import { ErrorBoundary } from '../src/components/ui/ErrorBoundary';

// Backfill the session list from Supabase so history recorded in previous app
// runs (or on other devices) is browsable. Fire-and-forget; local list wins on
// conflict and nothing blocks startup.
/**
 * A stalled request (e.g. network suspended while the OAuth browser sheet was
 * foregrounded) would otherwise await forever with no rejection — nothing to
 * catch, nothing to time out on its own. This bounds it so the UI can recover.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Request timed out')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function hydrateSessionHistory(userId: string) {
  if (!isSupabaseConfigured) return;
  fetchSessionHistory(userId)
    .then((summaries) => useAnalysisStore.getState().mergeHistory(summaries))
    .catch(() => {});
}

/**
 * Aliases RevenueCat onto the Supabase user id and refreshes the entitlement.
 * Fire-and-forget: an offline launch keeps whatever the persisted entitlement
 * store last knew.
 *
 * Followed by an explicit restore rather than trusting logIn's own response:
 * when the alias is fresh (an anonymous purchase just signed in), the
 * CustomerInfo logIn returns can lag behind what RevenueCat's backend has
 * actually merged — observed as the paywall staying up after a real sign-in
 * until Restore Purchases was tapped manually. Restore forces the same resync
 * automatically instead of leaving it on the user to notice and do by hand.
 */
function hydrateEntitlement(userId: string) {
  const { applyCustomerInfo } = useEntitlementStore.getState();
  identifyPurchaser(userId)
    .then((info) => {
      if (info) applyCustomerInfo(info);
      return restorePurchases().catch(() => null);
    })
    .then((info) => { if (info) applyCustomerInfo(info); })
    .catch(() => {});
}

/**
 * Resolves once a persisted zustand store has rehydrated from AsyncStorage.
 *
 * The subscribe gate reads the entitlement and the activation step, both of
 * which live in persist() stores that rehydrate asynchronously. Rendering
 * before they land would flash the paywall at a paying subscriber on every
 * cold launch — and briefly show the app to someone who has not paid.
 */
function whenHydrated(store: { persist: { hasHydrated: () => boolean; onFinishHydration: (fn: () => void) => () => void } }): Promise<void> {
  if (store.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = store.persist.onFinishHydration(() => { unsub(); resolve(); });
  });
}

const LAST_OPEN_KEY = 'stringai-last-open-at';

/**
 * Emits `resurrected` when someone comes back after a gap, which is the other
 * half of retention: GA4 cohorts show who left, this shows who returned and
 * after how long.
 */
async function trackReturnGap() {
  try {
    const now = new Date();
    const previous = await AsyncStorage.getItem(LAST_OPEN_KEY);
    await AsyncStorage.setItem(LAST_OPEN_KEY, now.toISOString());
    if (!previous) return;

    const away = daysBetween(previous, now);
    if (away >= 2) {
      track(AnalyticsEvent.RESURRECTED, { days_away_bkt: daysAwayBucket(away), days_away: away });
    }
  } catch {
    // A missing timestamp only costs one event.
  }
}

/**
 * Ties the three identity systems together. Analytics and Crashlytics key off
 * the Supabase user id, and RevenueCat needs the GA4 app instance id so its
 * server-side subscription events can be matched back to a GA4 user — that link
 * is what makes churn measurable when the app is never opened.
 */
function identifyForTelemetry(userId: string | null) {
  setAnalyticsUser(userId);
  setCrashUser(userId);
  fetchAppInstanceId()
    .then(setFirebaseAppInstanceId)
    .catch(() => {});
}

// Server goal wins locally; a local-only goal (set as guest) backfills to the DB.
function reconcileWeeklyGoal(profile: UserProfile) {
  const { weeklyGoalMinutes, setWeeklyGoal } = useAuthStore.getState();
  if (profile.weeklyGoalMinutes) {
    if (profile.weeklyGoalMinutes !== weeklyGoalMinutes) {
      setWeeklyGoal(profile.weeklyGoalMinutes);
    }
  } else if (weeklyGoalMinutes) {
    updateProfileFields(profile.id, { weekly_goal_minutes: weeklyGoalMinutes }).catch(() => {});
  }
}

export default function RootLayout() {
  const { setAuthenticated, signOut, loadOnboardingStatus } = useAuthStore();
  const { setProfile } = useUserStore();
  const { applyCustomerInfo, resetEntitlement } = useEntitlementStore();
  const [ready, setReady] = useState(false);

  useScreenTracking();
  useAnalyticsIdentity();

  useEffect(() => {
    // Must precede any other Purchases call; no-ops without an API key.
    configurePurchases();
    // Chains Crashlytics onto unhandled promise rejections, which the SDK's own
    // global handler does not cover.
    initCrashReporting();
    qaCheckpoint('app_launch'); // TEMPORARY — QA walkthrough checkpoint
    trackReturnGap();

    // Tracking only — the reminder has no deep link, so opening it just brings
    // the app forward. Open rate is what says whether reminders are working.
    const notificationSub = Notifications.addNotificationResponseReceivedListener(() => {
      track(AnalyticsEvent.REMINDER_NOTIF_OPEN);
    });

    const init = async () => {
      // Load persisted local state before rendering navigation. The two
      // persist() stores are awaited because the subscribe gate reads them —
      // see whenHydrated.
      await Promise.all([
        loadOnboardingStatus(),
        whenHydrated(useEntitlementStore),
        whenHydrated(useActivationStore),
      ]);

      // Restore existing Supabase session if one is stored on device
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        setAuthenticated(session.user.id, session.access_token);
        identifyForTelemetry(session.user.id);
        hydrateSessionHistory(session.user.id);
        hydrateEntitlement(session.user.id);
        try {
          const profile = await withTimeout(fetchProfile(session.user.id), 10000);
          setProfile(profile);
          reconcileWeeklyGoal(profile);
        } catch {}
      } else {
        // Guests are still tracked, just without a stable id across installs.
        identifyForTelemetry(null);
        // A guest can still hold an entitlement (purchased, then signed out).
        getCustomerInfo()
          .then((info) => { if (info) applyCustomerInfo(info); })
          .catch(() => {});
      }

      // Rewrites the pre-conversion recap with current numbers. Runs after the
      // entitlement and session history have hydrated, and is a no-op (plus a
      // cancel) for anyone not in a trial.
      void syncTrialRecap();

      setReady(true);
    };

    init();

    // Renewals, expiries, and purchases made on another device all arrive here
    // as a push, so nothing polls for entitlement changes.
    const unsubscribePurchases = onCustomerInfoChange((info) => {
      applyCustomerInfo(info);
      // A trial that just started, converted, or lapsed changes whether the
      // recap should exist at all — and this is the only place a change made on
      // another device is observed.
      void syncTrialRecap();
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (session?.user) {
        setAuthenticated(session.user.id, session.access_token);
        identifyForTelemetry(session.user.id);
        hydrateSessionHistory(session.user.id);
        hydrateEntitlement(session.user.id);
        try {
          const profile = await withTimeout(fetchProfile(session.user.id), 10000);
          setProfile(profile);
          reconcileWeeklyGoal(profile);
        } catch {}
      } else {
        signOut();
        setProfile(null);
        resetEntitlement();
        identifyForTelemetry(null);
        logOutPurchaser().catch(() => {});
      }
    });

    return () => {
      subscription.unsubscribe();
      unsubscribePurchases();
      notificationSub.remove();
    };
  }, []);

  // Subscribed to unconditionally (rules of hooks), but only ever rendered
  // below, once `ready` guarantees both persisted stores have rehydrated — so
  // it is never briefly wrong in either direction.
  const gateActive = useSubscribeGateActive();
  // Mutually exclusive with the above by construction: this one requires `pro`,
  // that one requires its absence.
  const accountGateActive = useAccountGateActive();
  const blocked = gateActive || accountGateActive;

  // The gates above are overlays, not routes — they cover the navigator
  // rather than replacing what's underneath. Signing in or restoring a
  // purchase from inside one clears it, but the Stack itself never moved off
  // wherever app/index.tsx first resolved to (onboarding, if FORCE_ONBOARDING
  // is on). One place to send it home once every wall is actually down, so
  // that logic doesn't need repeating inside every gate's success handler.
  const wasBlocked = useRef(false);
  useEffect(() => {
    if (wasBlocked.current && !blocked) {
      router.replace('/(tabs)/home');
    }
    wasBlocked.current = blocked;
  }, [blocked]);

  // Don't render navigation until local storage is loaded.
  // Prevents a flash where hasCompletedOnboarding is false for returning users.
  if (!ready) return null;

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="piece" />
          <Stack.Screen name="practice" />
          <Stack.Screen
            name="goal"
            options={{ presentation: 'modal', headerShown: false }}
          />
          <Stack.Screen
            name="reminders"
            options={{ presentation: 'modal', headerShown: false }}
          />
          <Stack.Screen
            name="chat"
            options={{ presentation: 'modal', headerShown: false }}
          />
          <Stack.Screen
            name="changelog"
            options={{ presentation: 'modal', headerShown: false }}
          />
        </Stack>
        {/* Over the navigator, not inside it — see SubscribeGate. */}
        {gateActive && <SubscribeGate />}
        {/* Straight after the purchase clears the wall — see AccountGate. */}
        {accountGateActive && <AccountGate />}
        {/* Fires once both walls are down. See the component. */}
        <SubscribedReviewHost blocked={blocked} />
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
