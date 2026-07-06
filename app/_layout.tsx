import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { supabase, isSupabaseConfigured } from '../src/services/supabase';
import { useAuthStore } from '../src/store/useAuthStore';
import { useUserStore } from '../src/store/useUserStore';
import { useAnalysisStore } from '../src/store/useAnalysisStore';
import { fetchProfile, updateProfileFields } from '../src/services/auth';
import { fetchSessionHistory } from '../src/services/analysis';
import { UserProfile } from '../src/types/user';

// Backfill the session list from Supabase so history recorded in previous app
// runs (or on other devices) is browsable. Fire-and-forget; local list wins on
// conflict and nothing blocks startup.
function hydrateSessionHistory(userId: string) {
  if (!isSupabaseConfigured) return;
  fetchSessionHistory(userId)
    .then((summaries) => useAnalysisStore.getState().mergeHistory(summaries))
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
  const { setAuthenticated, signOut, loadGuestCount, loadOnboardingStatus } = useAuthStore();
  const { setProfile } = useUserStore();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const init = async () => {
      // Load persisted local state before rendering navigation
      await Promise.all([loadGuestCount(), loadOnboardingStatus()]);

      // Restore existing Supabase session if one is stored on device
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        setAuthenticated(session.user.id, session.access_token);
        hydrateSessionHistory(session.user.id);
        try {
          const profile = await fetchProfile(session.user.id);
          setProfile(profile);
          reconcileWeeklyGoal(profile);
        } catch {}
      }

      setReady(true);
    };

    init();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (session?.user) {
        setAuthenticated(session.user.id, session.access_token);
        hydrateSessionHistory(session.user.id);
        try {
          const profile = await fetchProfile(session.user.id);
          setProfile(profile);
          reconcileWeeklyGoal(profile);
        } catch {}
      } else {
        signOut();
        setProfile(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Don't render navigation until local storage is loaded.
  // Prevents a flash where hasCompletedOnboarding is false for returning users.
  if (!ready) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="piece" />
        <Stack.Screen name="practice" />
        <Stack.Screen
          name="paywall"
          options={{ presentation: 'modal', headerShown: false }}
        />
        <Stack.Screen
          name="goal"
          options={{ presentation: 'modal', headerShown: false }}
        />
      </Stack>
    </GestureHandlerRootView>
  );
}
