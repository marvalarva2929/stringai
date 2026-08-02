import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, Pressable } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUserStore } from '../../src/store/useUserStore';
import { useEntitlementStore } from '../../src/store/useEntitlementStore';
import { canUseCuratedExercises } from '../../src/lib/entitlements';
import { usePracticePlan } from '../../src/hooks/useDailyPracticePlan';
import { scopeFromParams } from '../../src/lib/practicePlan';
import { PracticePlanView } from '../../src/components/practice/PracticePlanView';
import { Button } from '../../src/components/ui/Button';
import { colors, spacing } from '../../src/constants/theme';

/**
 * A scoped practice plan (piece warm-up or post-session curated exercises),
 * reached from the home pinned-piece card and the results screen. Daily lives
 * in the Train tab. The post-session curated exercises are a Pro feature.
 */
export default function ScopedPlanScreen() {
  const params = useLocalSearchParams<{ sessionId?: string; pieceId?: string }>();
  const scope = scopeFromParams(params);
  const plan = usePracticePlan(scope);
  const currentPiece = useUserStore((st) => st.profile?.currentPiece);
  const entitlement = useEntitlementStore((st) => st.entitlement);

  if (scope.kind === 'session' && !canUseCuratedExercises(entitlement)) {
    return (
      <SafeAreaView style={s.lockedSafe}>
        <View style={s.lockedBody}>
          <View style={s.lockedBadge}>
            <Ionicons name="lock-closed" size={28} color={colors.brand[600]} />
          </View>
          <Text style={s.lockedTitle}>Curated exercises</Text>
          <Text style={s.lockedSub}>
            Exercises picked from your recording to get better at this piece — a Pro feature.
          </Text>
          <Button label="Upgrade to Pro" fullWidth onPress={() => router.push('/paywall')} />
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Text style={s.lockedBack}>Not now</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (scope.kind === 'session') {
    return (
      <PracticePlanView
        plan={plan}
        scope={scope}
        kicker="Practice session"
        title="Curated exercises"
        coachMessage="Picked from this recording to get better at this piece — clear them, then record again."
      />
    );
  }

  return (
    <PracticePlanView
      plan={plan}
      scope={scope}
      kicker="Piece warm-up"
      coachMessage={`A few exercises from what "${currentPiece?.title ?? 'this piece'}" has needed lately — then play it through.`}
    />
  );
}

const s = StyleSheet.create({
  lockedSafe: { flex: 1, backgroundColor: colors.background },
  lockedBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  lockedBadge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.brand[50],
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockedTitle: { fontSize: 26, fontWeight: '900', color: colors.text.primary },
  lockedSub: {
    fontSize: 15,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 21,
    marginBottom: spacing.sm,
  },
  lockedBack: { fontSize: 15, fontWeight: '700', color: colors.text.muted, padding: spacing.sm },
});
