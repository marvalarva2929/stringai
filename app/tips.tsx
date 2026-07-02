import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  SafeAreaView,
} from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useAnalysisStore } from '../src/store/useAnalysisStore';
import { EXERCISES, Exercise, Difficulty, exercisesForMetric } from '../src/constants/exercises';
import { computePracticePlan, metricLabel, metricIcon, WeakArea } from '../src/lib/practicePlan';
import { MetricKey } from '../src/types/analysis';
import { colors, spacing, radius } from '../src/constants/theme';

const DIFFICULTY_COLOR: Record<Difficulty, string> = {
  beginner: '#22c55e',
  intermediate: '#f59e0b',
  advanced: '#ef4444',
};

const METRIC_KEYS = Array.from(new Set(EXERCISES.map((e) => e.metricKey))) as MetricKey[];

// ── Score bar ─────────────────────────────────────────────────────────────────

function ScoreBar({ score }: { score: number }) {
  const color = score >= 85 ? colors.score.excellent
    : score >= 70 ? '#16a34a'
    : score >= 50 ? colors.score.needs_attention
    : colors.score.critical;
  return (
    <View style={bar.row}>
      <View style={bar.track}>
        <View style={[bar.fill, { width: `${score}%` as any, backgroundColor: color }]} />
      </View>
      <Text style={[bar.label, { color }]}>{score}</Text>
    </View>
  );
}
const bar = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  track: { flex: 1, height: 6, backgroundColor: '#e5e7eb', borderRadius: 3, overflow: 'hidden' },
  fill: { position: 'absolute', top: 0, left: 0, bottom: 0, borderRadius: 3 },
  label: { width: 28, textAlign: 'right', fontSize: 11, fontWeight: '700' },
});

// ── Exercise card ─────────────────────────────────────────────────────────────

function ExerciseCard({ ex, defaultExpanded = false }: { ex: Exercise; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <Pressable style={exc.wrap} onPress={() => setExpanded((v) => !v)}>
      <View style={exc.header}>
        <View style={exc.headerLeft}>
          <Text style={exc.title}>{ex.title}</Text>
          <Text style={exc.focus}>{ex.focus}</Text>
        </View>
        <View style={exc.meta}>
          <View style={[exc.badge, { backgroundColor: DIFFICULTY_COLOR[ex.difficulty] + '22' }]}>
            <Text style={[exc.badgeText, { color: DIFFICULTY_COLOR[ex.difficulty] }]}>
              {ex.difficulty}
            </Text>
          </View>
          <Text style={exc.duration}>{ex.duration}</Text>
        </View>
      </View>
      {expanded && (
        <View style={exc.body}>
          <Text style={exc.instructions}>{ex.instructions}</Text>
        </View>
      )}
      <Text style={exc.toggle}>{expanded ? '▲ Hide' : '▼ Show instructions'}</Text>
    </Pressable>
  );
}
const exc = StyleSheet.create({
  wrap: {
    backgroundColor: '#fff',
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  headerLeft: { flex: 1, gap: 2 },
  title: { fontSize: 14, fontWeight: '700', color: colors.text.primary },
  focus: { fontSize: 12, color: colors.text.secondary, lineHeight: 17 },
  meta: { alignItems: 'flex-end', gap: spacing.xs },
  badge: { borderRadius: radius.sm, paddingHorizontal: 7, paddingVertical: 2 },
  badgeText: { fontSize: 10, fontWeight: '700', textTransform: 'capitalize' },
  duration: { fontSize: 10, color: colors.text.muted, fontWeight: '600' },
  body: {
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  instructions: { fontSize: 13, color: colors.text.secondary, lineHeight: 20 },
  toggle: { fontSize: 11, color: colors.brand[500], fontWeight: '600', marginTop: spacing.xs },
});

// ── Weak area section ─────────────────────────────────────────────────────────

function WeakAreaSection({ area }: { area: WeakArea }) {
  const icon = metricIcon(area.metricKey);
  const label = metricLabel(area.metricKey);
  return (
    <View style={wa.wrap}>
      <View style={wa.header}>
        <Text style={wa.icon}>{icon}</Text>
        <View style={wa.headerText}>
          <Text style={wa.label}>{label}</Text>
          <Text style={wa.sub}>
            Avg score across {area.sessionCount} session{area.sessionCount === 1 ? '' : 's'}
          </Text>
        </View>
        <Text style={wa.score}>{area.avgScore}</Text>
      </View>
      <View style={wa.barRow}>
        <ScoreBar score={area.avgScore} />
      </View>
      <View style={wa.exercises}>
        {area.exercises.map((ex) => (
          <ExerciseCard key={ex.id} ex={ex} defaultExpanded />
        ))}
      </View>
    </View>
  );
}
const wa = StyleSheet.create({
  wrap: {
    backgroundColor: colors.brand[50],
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.brand[200],
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  icon: { fontSize: 24 },
  headerText: { flex: 1 },
  label: { fontSize: 16, fontWeight: '700', color: colors.brand[800] },
  sub: { fontSize: 11, color: colors.brand[600], marginTop: 1 },
  score: { fontSize: 28, fontWeight: '800', color: colors.brand[700] },
  barRow: { paddingTop: 8 },
  exercises: { gap: spacing.sm, marginTop: spacing.xs },
});

// ── Library metric group ──────────────────────────────────────────────────────

function LibraryMetricGroup({
  metricKey,
  avgScore,
}: {
  metricKey: MetricKey;
  avgScore?: number;
}) {
  const [open, setOpen] = useState(false);
  const exercises = exercisesForMetric(metricKey);
  const icon = metricIcon(metricKey);
  const label = metricLabel(metricKey);

  return (
    <View style={lib.group}>
      <Pressable style={lib.row} onPress={() => setOpen((v) => !v)}>
        <Text style={lib.icon}>{icon}</Text>
        <View style={lib.rowText}>
          <Text style={lib.label}>{label}</Text>
          <Text style={lib.count}>{exercises.length} exercise{exercises.length === 1 ? '' : 's'}</Text>
        </View>
        {avgScore != null && (
          <View style={lib.scoreChip}>
            <Text style={[lib.scoreText, { color: avgScore >= 70 ? colors.score.excellent : colors.score.needs_attention }]}>
              avg {avgScore}
            </Text>
          </View>
        )}
        <Text style={lib.chevron}>{open ? '▲' : '▼'}</Text>
      </Pressable>
      {open && (
        <View style={lib.body}>
          {exercises.map((ex) => (
            <ExerciseCard key={ex.id} ex={ex} />
          ))}
        </View>
      )}
    </View>
  );
}
const lib = StyleSheet.create({
  group: {
    backgroundColor: '#fff',
    borderRadius: radius.md,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    gap: spacing.sm,
  },
  icon: { fontSize: 20 },
  rowText: { flex: 1 },
  label: { fontSize: 14, fontWeight: '700', color: colors.text.primary },
  count: { fontSize: 11, color: colors.text.muted, marginTop: 1 },
  scoreChip: {
    backgroundColor: '#f3f4f6',
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  scoreText: { fontSize: 11, fontWeight: '700' },
  chevron: { fontSize: 13, color: colors.text.muted, fontWeight: '600', marginLeft: spacing.xs },
  body: { padding: spacing.sm, paddingTop: 0, gap: spacing.sm },
});

// ── Main screen ───────────────────────────────────────────────────────────────

export default function TipsScreen() {
  const metricHistory = useAnalysisStore((s) => s.metricHistory);

  const plan = useMemo(() => computePracticePlan(metricHistory, 5), [metricHistory]);

  const noData = plan.sessionCount === 0;

  return (
    <SafeAreaView style={styles.safe}>
      <LinearGradient colors={[colors.brand[900], colors.brand[800]]} style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Practice Plan</Text>
        <Text style={styles.headerSub}>
          {noData
            ? 'Complete your first analysis to unlock personalized tips.'
            : `Based on your last ${plan.sessionCount} session${plan.sessionCount === 1 ? '' : 's'}`}
        </Text>
      </LinearGradient>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Priority areas ──────────────────────────────────── */}
        {!noData && plan.weakAreas.length > 0 && (
          <>
            <SectionHeader label="Focus Areas" />
            <Text style={styles.sectionDesc}>
              These metrics had the lowest average scores in your recent sessions.
              Targeted practice on these will move the needle fastest.
            </Text>
            {plan.weakAreas.map((area) => (
              <WeakAreaSection key={area.metricKey} area={area} />
            ))}
          </>
        )}

        {!noData && plan.weakAreas.length === 0 && (
          <View style={styles.allGoodCard}>
            <Text style={styles.allGoodEmoji}>🌟</Text>
            <Text style={styles.allGoodTitle}>Excellent all-around!</Text>
            <Text style={styles.allGoodBody}>
              All your metrics are scoring well. Browse the full exercise library below to refine any specific skill.
            </Text>
          </View>
        )}

        {noData && (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyEmoji}>🎻</Text>
            <Text style={styles.emptyTitle}>No session data yet</Text>
            <Text style={styles.emptyBody}>
              After your first analysis, we'll rank your weak areas and surface the exercises that will help you most.
              The full exercise library is available below.
            </Text>
          </View>
        )}

        {/* ── Full exercise library ───────────────────────────── */}
        <SectionHeader label="Full Exercise Library" />
        <Text style={styles.sectionDesc}>
          {EXERCISES.length} exercises across all {METRIC_KEYS.length} technique areas.
          Tap any area to expand.
        </Text>
        <View style={styles.libraryList}>
          {METRIC_KEYS.map((key) => (
            <LibraryMetricGroup
              key={key}
              metricKey={key}
              avgScore={plan.allMetricAverages[key]}
            />
          ))}
        </View>

        <View style={styles.bottomPad} />
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionHeader({ label }: { label: string }) {
  return <Text style={styles.sectionHeader}>{label}</Text>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },

  header: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
  },
  backBtn: { paddingTop: spacing.md, paddingBottom: spacing.sm },
  backText: { color: 'rgba(255,255,255,0.6)', fontSize: 14, fontWeight: '500' },
  headerTitle: { fontSize: 26, fontWeight: '800', color: '#fff', marginBottom: spacing.xs },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 19 },

  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xl },

  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.md,
  },
  sectionDesc: {
    fontSize: 13,
    color: colors.text.secondary,
    lineHeight: 19,
    marginBottom: spacing.xs,
  },

  emptyCard: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    gap: spacing.xs,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  emptyEmoji: { fontSize: 36, marginBottom: spacing.xs },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: colors.text.primary },
  emptyBody: {
    fontSize: 13,
    color: colors.text.muted,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
    lineHeight: 20,
  },

  allGoodCard: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    backgroundColor: '#f0fdf4',
    borderRadius: radius.lg,
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: '#86efac',
  },
  allGoodEmoji: { fontSize: 36, marginBottom: spacing.xs },
  allGoodTitle: { fontSize: 16, fontWeight: '700', color: '#166534' },
  allGoodBody: {
    fontSize: 13,
    color: '#166534',
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
    lineHeight: 20,
    opacity: 0.8,
  },

  libraryList: { gap: spacing.sm },

  bottomPad: { height: spacing.xl },
});
