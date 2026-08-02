import { Redirect } from 'expo-router';

// The old "/tips" exercise picker has been replaced by the Train tab path.
// Kept as a redirect so any lingering links/deep links resolve gracefully.
export default function TipsRedirect() {
  return <Redirect href="/(tabs)/train" />;
}
