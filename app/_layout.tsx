import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { supabase } from '../src/services/supabase';
import { useAuthStore } from '../src/store/useAuthStore';
import { useUserStore } from '../src/store/useUserStore';
import { fetchProfile } from '../src/services/auth';

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
        try {
          const profile = await fetchProfile(session.user.id);
          setProfile(profile);
        } catch {}
      }

      setReady(true);
    };

    init();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (session?.user) {
        setAuthenticated(session.user.id, session.access_token);
        try {
          const profile = await fetchProfile(session.user.id);
          setProfile(profile);
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
        <Stack.Screen
          name="paywall"
          options={{ presentation: 'modal', headerShown: false }}
        />
      </Stack>
    </GestureHandlerRootView>
  );
}
