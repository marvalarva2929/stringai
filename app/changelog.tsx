import React from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { CHANGELOG, UP_NEXT } from '../src/constants/changelog';
import { colors, spacing, radius } from '../src/constants/theme';

/**
 * What's New — the shipping cadence, visible.
 *
 * See the header of src/constants/changelog.ts for why this exists. It is a
 * plain render of that file; all the editing happens there.
 */
export default function ChangelogModal() {
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <Text style={styles.title}>What's New</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.close}>Done</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + spacing.xxl }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.intro}>
          StringAI is built by one person. Here's what's landed recently, and what I'm working on
          next.
        </Text>

        {CHANGELOG.map((entry) => (
          <View key={entry.date} style={styles.entry}>
            <View style={styles.entryHead}>
              <Text style={styles.entryDate}>{formatDate(entry.date)}</Text>
              {entry.version && <Text style={styles.entryVersion}>v{entry.version}</Text>}
            </View>
            {entry.changes.map((change) => (
              <View key={change} style={styles.changeRow}>
                <View style={styles.bullet} />
                <Text style={styles.changeText}>{change}</Text>
              </View>
            ))}
          </View>
        ))}

        <Text style={styles.sectionHeader}>Up next</Text>
        <View style={styles.nextCard}>
          {UP_NEXT.map((item) => (
            <View key={item} style={styles.changeRow}>
              <Ionicons name="ellipse-outline" size={13} color={colors.brand[600]} style={styles.nextIcon} />
              <Text style={styles.changeText}>{item}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.footnote}>
          No dates on those — I'd rather ship them than promise them.
        </Text>
      </ScrollView>
    </View>
  );
}

/** "2026-08-11" -> "11 August 2026". Parsed as UTC so the date can't slip a day. */
function formatDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.md,
  },
  title: { fontSize: 24, fontWeight: '800', color: colors.text.primary },
  close: { fontSize: 15, fontWeight: '700', color: colors.brand[600] },

  body: { paddingHorizontal: spacing.xl, gap: spacing.lg },
  intro: { fontSize: 14, color: colors.text.secondary, lineHeight: 20 },

  entry: {
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: spacing.lg,
    gap: spacing.sm,
  },
  entryHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  entryDate: { fontSize: 15, fontWeight: '800', color: colors.text.primary },
  entryVersion: { fontSize: 12, fontWeight: '700', color: colors.text.muted },

  changeRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  bullet: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.brand[600],
    marginTop: 7,
  },
  nextIcon: { marginTop: 3 },
  changeText: { flex: 1, fontSize: 14, color: colors.text.secondary, lineHeight: 20 },

  sectionHeader: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.text.muted,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  nextCard: {
    backgroundColor: '#f0f9ff',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: '#bae6fd',
    padding: spacing.lg,
    gap: spacing.sm,
  },
  footnote: { fontSize: 13, color: colors.text.muted, fontStyle: 'italic', textAlign: 'center' },
});
