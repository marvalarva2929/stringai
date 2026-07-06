import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, spacing, radius } from '../../constants/theme';
import { haptic } from '../../lib/haptics';
import { GOAL_TIERS, GoalTier, RECOMMENDED_TIER_ID } from '../../lib/weeklyGoal';

interface CommitmentPickerProps {
  selectedTierId: string | null;
  onSelect: (tier: GoalTier) => void;
}

// Weekly commitment tier cards. Styled for the brand gradient background,
// matching the goal-picker cards in onboarding.
export function CommitmentPicker({ selectedTierId, onSelect }: CommitmentPickerProps) {
  return (
    <View style={styles.list}>
      {GOAL_TIERS.map((tier) => {
        const isSelected = selectedTierId === tier.id;
        return (
          <Pressable
            key={tier.id}
            style={[styles.card, isSelected && styles.cardSelected]}
            onPress={() => { haptic.success(); onSelect(tier); }}
          >
            <View style={styles.cardText}>
              <View style={styles.labelRow}>
                <Text style={[styles.cardTitle, isSelected && styles.cardTitleSelected]}>
                  {tier.label}
                </Text>
                {tier.id === RECOMMENDED_TIER_ID && (
                  <View style={styles.recommendedPill}>
                    <Text style={styles.recommendedText}>RECOMMENDED</Text>
                  </View>
                )}
              </View>
              <Text style={[styles.cardDesc, isSelected && styles.cardDescSelected]}>
                {tier.minutes} min / week · {tier.sublabel}
              </Text>
            </View>
            {isSelected && (
              <View style={styles.checkCircle}>
                <Text style={styles.checkmark}>✓</Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.md },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.15)',
    padding: spacing.md,
    gap: spacing.md,
  },
  cardSelected: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderColor: '#fff',
  },
  cardText: { flex: 1 },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: 4,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.85)',
  },
  cardTitleSelected: {
    color: '#fff',
  },
  cardDesc: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.6)',
    lineHeight: 18,
  },
  cardDescSelected: {
    color: 'rgba(255,255,255,0.8)',
  },
  recommendedPill: {
    backgroundColor: '#fff',
    borderRadius: radius.full,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  recommendedText: {
    fontSize: 9,
    fontWeight: '800',
    color: colors.brand[600],
    letterSpacing: 0.5,
  },
  checkCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkmark: {
    fontSize: 13,
    color: colors.brand[600],
    fontWeight: '800',
  },
});
