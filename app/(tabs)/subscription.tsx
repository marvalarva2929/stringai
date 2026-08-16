import { View } from 'react-native';

// Never shown. The tab bar intercepts this slot and pushes /chat (see
// app/(tabs)/_layout.tsx) — everyone inside the app is a subscriber, so the
// slot that was once the subscribe star is permanently the chat entry point.
// The route exists only because Expo Router requires a file for the tab.
//
// The paywall is not a route at all any more: it renders as an overlay from
// SubscribeGate, mounted outside the navigator in app/_layout.tsx.
export default function SubscriptionTab() {
  return <View />;
}
