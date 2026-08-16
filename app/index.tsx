import { Redirect } from 'expo-router';
import { useAuthStore } from '../src/store/useAuthStore';
import { FORCE_ONBOARDING } from '../src/constants/featureFlags';

export default function Index() {
  const { hasCompletedOnboarding } = useAuthStore();

  if (FORCE_ONBOARDING || !hasCompletedOnboarding) {
    return <Redirect href="/(auth)/onboarding" />;
  }

  // Activation needs no route of its own — it rides on the real screens, so a
  // cold launch mid-flow lands on home and its coachmarks re-arm themselves
  // from the persisted step.
  return <Redirect href="/(tabs)/home" />;
}
