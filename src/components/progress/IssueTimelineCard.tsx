import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { IssueTimelineEntry } from '../../lib/issueTimeline';
import { VERDICT_LABEL, formatTimelineDate } from '../../lib/issueTimeline';
import { RecurrenceStrip } from '../charts/RecurrenceStrip';
import { colors, radius, spacing } from '../../constants/theme';

// ─────────────────────────────────────────────────────────────
// One issue, over time, on one piece.
//
// The card has to hold two facts side by side without implying one caused the
// other: what the measurement did, and how much work the player put in. Saying
// "your 7 takes fixed this" would be a claim the data can't support. Showing
// "24¢ → 9¢" next to "7 takes over 4 days" lets the player draw the obvious
// conclusion themselves, which is both honest and more convincing.
// ─────────────────────────────────────────────────────────────

const VERDICT_STYLE: Record<IssueTimelineEntry['verdict'], { color: string; icon: string; bg: string }> = {
  fixed: { color: '#166534', icon: 'checkmark-circle', bg: '#f0fdf4' },
  improving: { color: '#0369a1', icon: 'trending-down', bg: colors.brand[50] },
  stuck: { color: '#b45309', icon: 'remove-circle', bg: '#fffbeb' },
  new: { color: colors.text.muted, icon: 'help-circle', bg: '#f9fafb' },
};

export function IssueTimelineCard({ entry }: { entry: IssueTimelineEntry }) {
  const verdict = VERDICT_STYLE[entry.verdict];
  const { practice } = entry;

  return (
    <View style={s.card}>
      <View style={s.head}>
        <View style={s.headCopy}>
          <Text style={s.title}>{entry.evidence.title}</Text>
          <Text style={s.since}>First seen {formatTimelineDate(entry.firstSeen)}</Text>
        </View>
        <View style={[s.badge, { backgroundColor: verdict.bg }]}>
          <Ionicons name={verdict.icon as never} size={13} color={verdict.color} />
          <Text style={[s.badgeText, { color: verdict.color }]}>{VERDICT_LABEL[entry.verdict]}</Text>
        </View>
      </View>

      <Text style={s.summary}>{entry.summary}</Text>

      <View style={s.stripRow}>
        <RecurrenceStrip presence={entry.presence} />
        <Text style={s.stripLabel}>
          {entry.presence.filter(Boolean).length} of {entry.presence.length} takes
        </Text>
      </View>

      {/* The work done, stated as its own fact rather than as the cause. */}
      {entry.exercises.length > 0 ? (
        <View style={s.practice}>
          <Ionicons name="barbell-outline" size={14} color={colors.text.muted} />
          <Text style={s.practiceText}>
            <Text style={s.practiceStrong}>{entry.exercises[0]}</Text>
            {' · '}
            {practice.total} take{practice.total === 1 ? '' : 's'}
            {practice.passed > 0 ? `, ${practice.passed} passed` : ''}
            {practice.days > 1 ? ` over ${practice.days} days` : ''}
          </Text>
        </View>
      ) : (
        <View style={s.practice}>
          <Ionicons name="ellipse-outline" size={14} color={colors.text.muted} />
          <Text style={s.practiceText}>No practice logged against this one yet.</Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: 1.5,
    borderColor: '#eef2f7',
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  headCopy: { flex: 1, gap: 1 },
  title: { fontSize: 15, fontWeight: '900', color: colors.text.primary },
  since: { fontSize: 12, color: colors.text.muted, fontWeight: '600' },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radius.full,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  badgeText: { fontSize: 11, fontWeight: '900' },
  summary: { fontSize: 13, lineHeight: 19, color: colors.text.secondary },
  stripRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stripLabel: { fontSize: 11, fontWeight: '700', color: colors.text.muted },
  practice: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  practiceText: { flex: 1, fontSize: 12, lineHeight: 17, color: colors.text.muted },
  practiceStrong: { fontWeight: '800', color: colors.text.secondary },
});
