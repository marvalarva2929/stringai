import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useAuthStore } from '../../store/useAuthStore';
import { useActivationStore } from '../../store/useActivationStore';
import { useEntitlementStore } from '../../store/useEntitlementStore';
import { requiresSubscription } from '../../lib/entitlements';
import { PaywallView } from './PaywallView';

/**
 * The subscription wall. StringAI is subscription-only, so this is the last
 * screen of the first run and the only way into the app.
 *
 * It renders *over* the navigator rather than being a route, deliberately.
 * Activation can end in four different places — the practice-completion screen,
 * a coachmark skip, the tour's own Skip button, and a cold launch that resumes
 * past it — and `app/index.tsx` only evaluates on launch. Guarding each of
 * those routes would be a standing invitation to miss the fifth one. An overlay
 * has no route to escape to and nothing to keep in sync.
 */
export function useSubscribeGateActive(): boolean {
  const hasCompletedOnboarding = useAuthStore((s) => s.hasCompletedOnboarding);
  const activationStep = useActivationStore((s) => s.step);
  const entitlement = useEntitlementStore((s) => s.entitlement);

  // Activation is the guided first run; interrupting it with a paywall would
  // wall the user off before they have seen what they are paying for. Both
  // terminal states count as finished — someone who skipped out still finished.
  const activationOver = activationStep === 'done' || activationStep === 'dismissed';

  return hasCompletedOnboarding && activationOver && requiresSubscription(entitlement);
}

export function SubscribeGate() {
  return (
    <View style={StyleSheet.absoluteFill}>
      <PaywallView
        mandatory
        source="activation_gate"
        // Unreachable: `mandatory` renders neither the ✕ nor "Maybe Later".
        // The gate clears when the entitlement changes, not when it is closed.
        onClose={() => {}}
      />
    </View>
  );
}
