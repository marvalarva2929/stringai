import React, { useMemo } from 'react';
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
import { colors, spacing, radius } from '../../src/constants/theme';

export default function PracticeCompleteScreen() {
  const params = useLocalSearchParams<{ sessionId?: string; pieceId?: string }>();
  const plan = usePracticePlan(scopeFromParams(params));
  const completedByPlan = usePracticeProgressStore((st) => st.completedByPlan);

  const doneCount = useMemo(() => {
    const completed = completedBlockIdsFor({ completedByPlan }, plan.id);
    return plan.blocks.filter((b) => completed.includes(b.id)).length;
  }, [completedByPlan, plan.id, plan.blocks]);

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.body}>
        <MaestroAvatar size="lg" bounce message="That's a wrap — you showed up and did the work." />

        <Text style={s.title}>Session complete</Text>
        <Text style={s.sub}>You worked through today's recommended path.</Text>

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
        <DepthButton label="Back to path" icon="arrow-forward" onPress={() => router.replace('/(tabs)/train')} />
        <DepthButton label="Done for today" icon="home" variant="neutral" onPress={() => router.replace('/(tabs)/home')} />
      </View>
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
