import React, { useEffect, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, SafeAreaView } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons, FontAwesome6 } from '@expo/vector-icons';
import { MaestroAvatar } from '../../src/components/ui/MaestroAvatar';
import { usePracticePlan } from '../../src/hooks/useDailyPracticePlan';
import { scopeFromParams } from '../../src/lib/practicePlan';
import {
  usePracticeProgressStore,
  completedBlockIdsFor,
} from '../../src/store/usePracticeProgressStore';
import { DepthButton } from '../../src/components/practice/DepthButton';
import { useActivationStore } from '../../src/store/useActivationStore';
import { useReviewPrompt } from '../../src/components/activation/useReviewPrompt';
import { ReviewPromptModal } from '../../src/components/activation/ReviewPromptModal';
import { track } from '../../src/services/analytics';
import { AnalyticsEvent } from '../../src/constants/analyticsEvents';
import { colors, spacing, radius } from '../../src/constants/theme';

/** Long enough for the completion screen to land before anything is asked of them. */
const REVIEW_DELAY_MS = 1600;

export default function PracticeCompleteScreen() {
  const params = useLocalSearchParams<{ sessionId?: string; pieceId?: string }>();
  const scope = scopeFromParams(params);
  const plan = usePracticePlan(scope);
  const completedByPlan = usePracticeProgressStore((st) => st.completedByPlan);

  const doneCount = useMemo(() => {
    const completed = completedBlockIdsFor({ completedByPlan }, plan.id);
    return plan.blocks.filter((b) => completed.includes(b.id)).length;
  }, [completedByPlan, plan.id, plan.blocks]);

  // ── Review prompt ────────────────────────────────────────────
  //
  // Finishing a practice plan is a good organic moment to ask: the user has
  // just done the whole loop and has something to show for it. During the
  // first run it is NOT — that user hasn't subscribed yet, and asking for an
  // endorsement immediately before the paywall spent one of three annual
  // prompts on someone who might never convert. So activation ends here
  // silently and the first ask waits for `trial_started`.
  const activationStep = useActivationStore((st) => st.step);
  const inActivation = activationStep === 'practice';
  const review = useReviewPrompt('practice_complete');

  const askedRef = useRef(false);
  useEffect(() => {
    if (askedRef.current) return;
    askedRef.current = true;
    // A GA4 Key Event: reaching this screen is the end of the core loop.
    track(AnalyticsEvent.PRACTICE_PLAN_COMPLETE, {
      scope: scope.kind,
      blocks_done: doneCount,
      blocks_total: plan.blocks.length,
      duration_min: plan.durationMinutes,
      in_activation: inActivation,
    });
    if (inActivation) {
      // Hands over to SubscribeGate. No prompt, no delay.
      useActivationStore.getState().complete();
      return;
    }
    const t = setTimeout(() => review.maybeAsk(), REVIEW_DELAY_MS);
    return () => clearTimeout(t);
  }, [inActivation, review]);

  const closeReview = () => review.close();

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.body}>
        <MaestroAvatar size="lg" bounce message="That's a wrap — you showed up and did the work." />

        <Text style={s.title}>
          {scope.kind === 'session' ? 'Practice session complete' : 'Warm-up complete'}
        </Text>
        <Text style={s.sub}>
          {scope.kind === 'session'
            ? 'Great work — record again to hear the difference.'
            : scope.kind === 'piece'
              ? "You're warmed up — go play your piece."
              : "You finished today's warm-up."}
        </Text>

        <View style={s.statRow}>
          <View style={s.statCard}>
            <FontAwesome6 name="check-double" size={22} color={colors.brand[600]} />
            <Text style={s.statNum}>{doneCount}/{plan.blocks.length}</Text>
            <Text style={s.statLabel}>Exercises</Text>
          </View>
          <View style={s.statCard}>
            <Ionicons name="time" size={24} color={colors.brand[600]} />
            <Text style={s.statNum}>~{plan.durationMinutes}</Text>
            <Text style={s.statLabel}>Minutes</Text>
          </View>
        </View>
      </View>

      <View style={s.bottomBar}>
        {scope.kind === 'session' ? (
          <DepthButton label="Record again" icon="videocam" onPress={() => router.replace('/practice/pick')} />
        ) : (
          <DepthButton label="Done" icon="home" onPress={() => router.replace('/(tabs)/home')} />
        )}
        {scope.kind === 'session' ? (
          <DepthButton label="Done" icon="home" variant="neutral" onPress={() => router.replace('/(tabs)/home')} />
        ) : (
          <DepthButton
            label="Back to warm-up"
            icon="arrow-back"
            variant="neutral"
            onPress={() =>
              scope.kind === 'daily'
                ? router.replace('/(tabs)/train')
                : router.replace({ pathname: '/practice/plan', params })
            }
          />
        )}
      </View>

      <ReviewPromptModal visible={review.visible} trigger="practice_complete" onClose={closeReview} />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg, gap: spacing.md },
  title: { fontSize: 30, fontWeight: '900', color: colors.text.primary, marginTop: spacing.lg },
  sub: { fontSize: 15, color: colors.text.secondary, textAlign: 'center' },
  statRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg },
  statCard: {
    width: 130,
    backgroundColor: '#fff',
    borderRadius: radius.xl,
    paddingVertical: spacing.lg,
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1.5,
    borderColor: '#eef2f7',
  },
  statNum: { fontSize: 24, fontWeight: '900', color: colors.text.primary },
  statLabel: { fontSize: 12, fontWeight: '700', color: colors.text.muted, textTransform: 'uppercase', letterSpacing: 0.4 },
  bottomBar: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.sm },
});
