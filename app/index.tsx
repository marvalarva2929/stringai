import { Redirect } from 'expo-router';
import { useAuthStore } from '../src/store/useAuthStore';
import { FORCE_ONBOARDING } from '../src/constants/featureFlags';

export default function Index() {
  const { hasCompletedOnboarding } = useAuthStore();

  if (FORCE_ONBOARDING || !hasCompletedOnboarding) {
    return <Redirect href="/(auth)/onboarding" />;
  }

  return <Redirect href="/(tabs)/home" />;
}
