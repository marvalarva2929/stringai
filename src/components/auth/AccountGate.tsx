import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useAuthStore } from '../../store/useAuthStore';
import { useEntitlementStore } from '../../store/useEntitlementStore';
import { isPro } from '../../lib/entitlements';
import { AccountStep } from '../onboarding/AccountStep';
import { syncOnboardingAnswersToProfile, backfillPreAccountSession } from '../../lib/onboardingSync';

/**
 * The account wall, shown to a paying user who hasn't made an account yet.
 *
 * Account creation used to be the last step of onboarding, before the user had
 * seen anything the app does. That put a signup form — and an email round-trip
 * that frequently never arrives — directly in front of the value moment, where
 * it cost the most. It now runs immediately *after* the purchase instead, when
 * intent is at its highest and the user has a concrete reason to want their
 * work saved.
 *
 * Rendered as an overlay rather than a route, for the same reason as
 * SubscribeGate: purchasing doesn't navigate, so there is no single screen to
 * hang this on, and a cold launch between paying and signing up must land back
 * here rather than somewhere inside the app.
 *
 * Ordering matters — this sits *below* SubscribeGate in app/_layout.tsx, and
 * its own predicate requires `pro`, so the two can never be on screen at once.
 */
export function useAccountGateActive(): boolean {
  const hasCompletedOnboarding = useAuthStore((s) => s.hasCompletedOnboarding);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const accountDeferred = useAuthStore((s) => s.accountDeferred);
  const entitlement = useEntitlementStore((s) => s.entitlement);

  // Only ever asked of someone who has paid. A user still outside the paywall
  // meets SubscribeGate instead; asking them to make an account first would
  // rebuild the wall this change exists to remove.
  return hasCompletedOnboarding && isPro(entitlement) && !isAuthenticated && !accountDeferred;
}

export function AccountGate() {
  return (
    <View style={styles.fill}>
      <AccountStep
        onCreated={(userId) => {
          // The gate clears on its own once setAuthenticated lands; these only
          // flush what has been waiting in local storage for an account to
          // exist — the onboarding answers, and the diagnostic recording that
          // was made before there was anywhere to save it.
          syncOnboardingAnswersToProfile(userId);
          backfillPreAccountSession(userId);
        }}
        onConfirmationSent={() => useAuthStore.getState().deferAccount()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Opaque: this renders over the navigator, and the screen underneath is
  // whatever activation happened to end on.
  fill: { ...StyleSheet.absoluteFillObject, backgroundColor: '#fff' },
});
