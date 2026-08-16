import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useAuthStore } from '../src/store/useAuthStore';
import { CommitmentPicker } from '../src/components/onboarding/CommitmentPicker';
import { GOAL_TIERS, GoalTier } from '../src/lib/weeklyGoal';
import { BigButton } from '../src/components/ui/BigButton';
import { MaestroAvatar } from '../src/components/ui/MaestroAvatar';
import { updateProfileFields } from '../src/services/auth';
import { track } from '../src/services/analytics';
import { AnalyticsEvent } from '../src/constants/analyticsEvents';
import { colors, spacing } from '../src/constants/theme';

export default function GoalModal() {
  const { weeklyGoalMinutes, setWeeklyGoal, isAuthenticated, userId } = useAuthStore();
  const [selectedTier, setSelectedTier] = useState<GoalTier | null>(
    GOAL_TIERS.find((t) => t.minutes === weeklyGoalMinutes) ?? null,
  );

  const save = async () => {
    if (!selectedTier) return;
    track(AnalyticsEvent.WEEKLY_GOAL_SET, {
      minutes: selectedTier.minutes,
      changed: selectedTier.minutes !== weeklyGoalMinutes,
    });
    await setWeeklyGoal(selectedTier.minutes);
    if (isAuthenticated && userId) {
      updateProfileFields(userId, { weekly_goal_minutes: selectedTier.minutes }).catch(() => {});
    }
    router.back();
  };

  return (
    <LinearGradient
      colors={[colors.brand[900], colors.brand[700], colors.brand[500]]}
      style={styles.container}
    >
      <Pressable onPress={() => router.back()} style={styles.closeBtn}>
        <Text style={styles.closeText}>✕</Text>
      </Pressable>

      <View style={styles.content}>
        <Text style={styles.title}>Weekly Practice Goal</Text>
        <Text style={styles.subtitle}>
          Students who set a weekly goal improve twice as fast. How much time can you give?
        </Text>
        <CommitmentPicker
          selectedTierId={selectedTier?.id ?? null}
          onSelect={setSelectedTier}
        />
      </View>

      <View style={styles.footer}>
        {selectedTier && (
          <MaestroAvatar
            key={selectedTier.id}
            size="sm"
            message={selectedTier.reinforcement}
            bubblePosition="above"
          />
        )}
        <BigButton label="Save Goal" onPress={save} disabled={!selectedTier} />
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  closeBtn: { position: 'absolute', top: 24, right: 20, zIndex: 10, padding: 8 },
  closeText: { color: 'rgba(255,255,255,0.65)', fontSize: 18 },
  content: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: 72,
    gap: spacing.md,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
  footer: {
    paddingHorizontal: spacing.xl,
    paddingBottom: 48,
    paddingTop: spacing.md,
  },
});
