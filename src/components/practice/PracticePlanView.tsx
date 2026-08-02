import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, SafeAreaView } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PracticePlan, PlanScope } from '../../lib/practicePlan';
import { scopeToParams } from '../../lib/practicePlan';
import {
  usePracticeProgressStore,
  completedBlockIdsFor,
  nextIncompleteBlock,
} from '../../store/usePracticeProgressStore';
import { PracticeNode, type NodeState } from './PracticeNode';
import { CoachBubble } from './CoachBubble';
import { DepthButton } from './DepthButton';
import { colors, spacing, radius } from '../../constants/theme';

/**
 * The shared practice-path screen — hero, coach line, the Duolingo-style node
 * path, and the sticky CTA. Rendered for the daily plan, a piece warm-up, and a
 * post-session plan alike; only `kicker`, `coachMessage`, and `scope` differ.
 * Routing to the runner/complete carries the scope so the runner resolves the
 * same plan and its progress stays isolated.
 */
export function PracticePlanView({
  plan,
  kicker,
  coachMessage,
  scope,
  title,
}: {
  plan: PracticePlan;
  kicker: string;
  coachMessage: string;
  scope: PlanScope;
  /** Overrides the hero title (defaults to the plan's primary focus). */
  title?: string;
}) {
  const insets = useSafeAreaInsets();
  const completedByPlan = usePracticeProgressStore((st) => st.completedByPlan);
  const completedIds = useMemo(
    () => completedBlockIdsFor({ completedByPlan }, plan.id),
    [completedByPlan, plan.id],
  );
  const scopeParams = useMemo(() => scopeToParams(scope), [scope]);

  const next = useMemo(() => nextIncompleteBlock(plan, completedIds), [plan, completedIds]);
  const total = plan.blocks.length;
  const doneCount = plan.blocks.filter((b) => completedIds.includes(b.id)).length;
  const allDone = doneCount >= total && total > 0;
  const progressPct = total > 0 ? doneCount / total : 0;

  const openBlock = (id: string) =>
    router.push({ pathname: '/practice/[id]', params: { id, ...scopeParams } });

  const startNext = () => {
    if (allDone) {
      router.push({ pathname: '/practice/complete', params: scopeParams });
      return;
    }
    const target = next ?? plan.blocks[0];
    if (target) openBlock(target.id);
  };

  return (
    <View style={s.root}>
      <SafeAreaView style={s.safe}>
        <ScrollView
          contentContainerStyle={[s.scroll, { paddingBottom: 120 }]}
          showsVerticalScrollIndicator={false}
        >
          <View style={s.hero}>
            <Text style={s.heroKicker}>{kicker}</Text>
            <Text style={s.heroTitle}>{title ?? plan.primaryFocus}</Text>
            <Text style={s.heroSummary}>{`${total} exercises · ~${plan.durationMinutes} min`}</Text>

            <View style={s.progressStrip}>
              <View style={s.progressTrack}>
                <View style={[s.progressFill, { width: `${Math.max(progressPct * 100, 4)}%` }]} />
              </View>
              <Text style={s.progressLabel}>{doneCount}/{total} done</Text>
            </View>
          </View>

          <View style={s.body}>
            <CoachBubble tone="light" message={coachMessage} />

            {plan.rootCauses && plan.rootCauses.length > 0 && (
              <View style={s.rootCauses}>
                <Text style={s.rootCausesLabel}>WHY THIS PLAN</Text>
                {plan.rootCauses.map((cause) => (
                  <View key={cause.id} style={s.rootCauseCard}>
                    <Text style={s.rootCauseTitle}>{cause.label}</Text>
                    <Text style={s.rootCauseBody}>{cause.explanation}</Text>
                  </View>
                ))}
              </View>
            )}

            <View style={s.path}>
              {plan.blocks.map((block, i) => {
                const state: NodeState = completedIds.includes(block.id)
                  ? 'done'
                  : block.id === next?.id
                    ? 'next'
                    : 'available';
                return (
                  <PracticeNode
                    key={block.id}
                    block={block}
                    index={i}
                    state={state}
                    isLast={i === plan.blocks.length - 1}
                    onPress={() => openBlock(block.id)}
                  />
                );
              })}
            </View>

            {allDone && (
              <View style={s.doneBanner}>
                <Ionicons name="trophy" size={22} color={colors.score.excellent} />
                <Text style={s.doneBannerText}>All done — nice work.</Text>
              </View>
            )}
          </View>
        </ScrollView>

        <View style={[s.bottomBar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
          <DepthButton
            label={allDone ? 'See summary' : doneCount > 0 ? 'Continue' : 'Start'}
            icon={allDone ? 'trophy' : 'arrow-forward'}
            onPress={startNext}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  safe: { flex: 1 },
  scroll: { gap: spacing.lg },
  hero: {
    backgroundColor: colors.brand[600],
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
  },
  heroKicker: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  heroTitle: { color: '#fff', fontSize: 28, fontWeight: '900', marginTop: spacing.xs },
  heroSummary: { color: 'rgba(255,255,255,0.85)', fontSize: 14, lineHeight: 20, marginTop: spacing.sm },
  progressStrip: { marginTop: spacing.lg, gap: spacing.xs },
  progressTrack: { height: 10, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.22)', overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 5, backgroundColor: '#fff' },
  progressLabel: { color: 'rgba(255,255,255,0.9)', fontSize: 12, fontWeight: '800' },
  body: { paddingHorizontal: spacing.lg, gap: spacing.lg },
  rootCauses: { gap: spacing.sm },
  rootCausesLabel: {
    fontSize: 12,
    fontWeight: '900',
    color: colors.text.muted,
    letterSpacing: 0.6,
  },
  rootCauseCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderLeftWidth: 3,
    borderLeftColor: colors.brand[400],
    padding: spacing.md,
    gap: 4,
  },
  rootCauseTitle: { fontSize: 15, fontWeight: '800', color: colors.text.primary },
  rootCauseBody: { fontSize: 13, lineHeight: 19, color: colors.text.secondary },
  path: { marginTop: spacing.xs },
  doneBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: '#f0fdf4',
    borderRadius: radius.xl,
    padding: spacing.md,
  },
  doneBannerText: { color: '#166534', fontSize: 14, fontWeight: '800' },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    backgroundColor: colors.background,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e5e7eb',
  },
});
