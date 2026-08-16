import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { RecurrenceStrip } from '../charts/RecurrenceStrip';
import { colors, spacing, radius } from '../../constants/theme';
import { haptic } from '../../lib/haptics';
import { METRIC_META } from '../../constants/metricMeta';
import type { IssueRecurrence } from '../../lib/progressAnalytics';

interface StuckIssueCardProps {
  recurrence: IssueRecurrence;
  onPractice: () => void;
}

/**
 * One issue that keeps coming back, with its per-session presence strip.
 *
 * This is the thing the old Progress screen couldn't say: not "your score is
 * 74" but "this specific fault has shown up in six of your last eight
 * sessions, here's the drill for it".
 */
export function StuckIssueCard({ recurrence, onPractice }: StuckIssueCardProps) {
  const { evidence, presence, seenIn, outOf } = recurrence;
  const icon = METRIC_META[evidence.metricKey]?.icon ?? '🎻';

  return (
    <View style={s.card}>
      <View style={s.titleRow}>
        <Text style={s.icon}>{icon}</Text>
        <Text style={s.title}>{evidence.title}</Text>
      </View>

      {!!evidence.evidenceSummary && (
        <Text style={s.summary} numberOfLines={2}>{evidence.evidenceSummary}</Text>
      )}

      <View style={s.stripRow}>
        <RecurrenceStrip presence={presence} />
        <Text style={s.count}>
          seen in {seenIn} of your last {outOf} sessions
        </Text>
      </View>

      <Pressable
        style={({ pressed }) => [s.cta, pressed && s.ctaPressed]}
        onPress={() => { haptic.medium(); onPractice(); }}
      >
        <Text style={s.ctaText}>Practice this →</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    borderBottomWidth: 4,
    borderBottomColor: '#d1d5db',
    padding: spacing.md,
    gap: spacing.sm,
  },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  icon: { fontSize: 16, lineHeight: 21 },
  title: { flex: 1, fontSize: 14, fontWeight: '700', color: colors.text.primary, lineHeight: 20 },
  summary: { fontSize: 12, color: colors.text.secondary, lineHeight: 17 },
  stripRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  count: { fontSize: 11, color: colors.text.muted, fontWeight: '500' },
  cta: {
    alignSelf: 'flex-start',
    backgroundColor: colors.brand[50],
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
  },
  ctaPressed: { backgroundColor: colors.brand[100] },
  ctaText: { fontSize: 13, fontWeight: '700', color: colors.brand[700] },
});
