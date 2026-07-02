import { View } from 'react-native';

// Tab bar intercepts the subscription icon and pushes /paywall directly.
// This screen is never shown — it only exists to satisfy the Expo Router route.
export default function SubscriptionTab() {
  return <View />;
}
