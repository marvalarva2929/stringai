import React, { useMemo, useState } from 'react';
import {
  ScrollView,
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Pressable,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAnalysisStore } from '../../src/store/useAnalysisStore';
import { useAuthStore } from '../../src/store/useAuthStore';
import { haptic } from '../../src/lib/haptics';
import { DepthCard } from '../../src/components/ui/DepthCard';
import { OverallTrendCard } from '../../src/components/progress/OverallTrendCard';
import { CategoryTrendRow } from '../../src/components/progress/CategoryTrendRow';
import { StuckIssueCard } from '../../src/components/progress/StuckIssueCard';
import { ConsistencyCard } from '../../src/components/progress/ConsistencyCard';
import { PieceSummaryCard, type PieceSummary } from '../../src/components/progress/PieceSummaryCard';
import { colors, spacing, radius } from '../../src/constants/theme';
import { collectIssueSources } from '../../src/lib/practiceIssues';
import { minutesPracticedThisWeek } from '../../src/lib/weeklyGoal';
import { computeStreak } from '../../src/lib/streak';
import { CATEGORY_BY_ID } from '../../src/constants/categories';
import {
  buildCategorySeries, overallSeries, comparePeriods, compareHalves,
  stuckIssues, resolvedIssues, pieceVsGlobalIssues, practiceCalendar,
  progressStage, rangeStart,
  RANGE_LABELS, MIN_SESSIONS_FOR_STUCK,
  type ProgressRange, type TrendPoint,
} from '../../src/lib/progressAnalytics';

const RANGES: ProgressRange[] = ['4w', '3m', 'all'];
const CALENDAR_WEEKS: Record<ProgressRange, number> = { '4w': 5, '3m': 13, all: 13 };

export default function ProgressScreen() {
  // Selector subscriptions — destructuring the whole store re-rendered this
  // screen on every unrelated write.
  const sessionHistory = useAnalysisStore((s) => s.sessionHistory);
  const metricHistory = useAnalysisStore((s) => s.metricHistory);
  const sessionResultCache = useAnalysisStore((s) => s.sessionResultCache);
  const currentResult = useAnalysisStore((s) => s.currentResult);
  const weeklyGoalMinutes = useAuthStore((s) => s.weeklyGoalMinutes);

  const [range, setRange] = useState<ProgressRange>('4w');
  const [showFixed, setShowFixed] = useState(false);

  const stage = progressStage(sessionHistory.length);

  // ── Overall ──────────────────────────────────────────────
  const allOverallPoints = useMemo(() => overallSeries(sessionHistory), [sessionHistory]);

  const { overallPoints, overallComparison } = useMemo(() => {
    const now = new Date();
    const start = rangeStart(range, now);
    const visible = start == null
      ? allOverallPoints
      : allOverallPoints.filter((p) => p.t >= start);
    const comparison = start == null
      ? compareHalves(allOverallPoints)
      : comparePeriods(allOverallPoints, start, now.getTime());
    return { overallPoints: visible, overallComparison: comparison };
  }, [allOverallPoints, range]);

  // ── Categories ───────────────────────────────────────────
  const categorySeries = useMemo(
    () => buildCategorySeries(metricHistory, range),
    [metricHistory, range],
  );

  // ── Issues ───────────────────────────────────────────────
  const issueSources = useMemo(
    () => collectIssueSources({
      recentSessions: Object.values(sessionResultCache),
      metricHistory,
    }),
    [sessionResultCache, metricHistory],
  );

  const stuck = useMemo(() => stuckIssues(issueSources), [issueSources]);
  const fixed = useMemo(() => resolvedIssues(issueSources), [issueSources]);

  // ── Consistency ──────────────────────────────────────────
  const weeks = useMemo(
    () => practiceCalendar(sessionHistory, CALENDAR_WEEKS[range]),
    [sessionHistory, range],
  );
  const streak = useMemo(() => computeStreak(sessionHistory), [sessionHistory]);
  const minutesThisWeek = useMemo(() => minutesPracticedThisWeek(sessionHistory), [sessionHistory]);

  // ── Pieces ───────────────────────────────────────────────
  const pieceSummaries = useMemo<PieceSummary[]>(() => {
    const grouped = new Map<string | null, typeof sessionHistory>();
    for (const session of sessionHistory) {
      const key = session.piece?.id ?? null;
      const list = grouped.get(key) ?? [];
      list.push(session);
      grouped.set(key, list);
    }

    const summaries: PieceSummary[] = [];
    for (const [pieceId, sessions] of grouped.entries()) {
      const sorted = [...sessions].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
      const points: TrendPoint[] = sorted.map((s) => ({
        t: new Date(s.recordedAt).getTime(),
        value: s.overallScore,
      }));

      let note: string | null = null;
      if (pieceId) {
        const split = pieceVsGlobalIssues(issueSources, pieceId);
        if (split.pieceSpecific.length > 0) {
          note = `${split.pieceSpecific.length} issue${split.pieceSpecific.length === 1 ? '' : 's'} only show${split.pieceSpecific.length === 1 ? 's' : ''} up here`;
        } else if (split.universal.length > 0) {
          note = 'Shares your general technique issues';
        }
      }

      summaries.push({
        pieceId,
        title: pieceId === null ? 'General Practice' : sorted[0].piece?.title ?? 'Unknown Piece',
        composer: sorted[0].piece?.composer,
        sessionCount: sorted.length,
        points,
        direction: compareHalves(points).direction,
        note,
      });
    }

    // Most recently played first; unnamed practice always last.
    return summaries
      .sort((a, b) => (b.points.at(-1)?.t ?? 0) - (a.points.at(-1)?.t ?? 0))
      .sort((a, b) => (a.pieceId === null ? 1 : 0) - (b.pieceId === null ? 1 : 0));
  }, [sessionHistory, issueSources]);

  if (stage === 'empty') {
    return (
      <SafeAreaView style={styles.safe}>
        <Header sessionCount={0} pieceCount={0} />
        <EmptyState />
      </SafeAreaView>
    );
  }

  const namedPieces = pieceSummaries.filter((p) => p.pieceId !== null).length;
  const earlyData = stage !== 'full';

  return (
    <SafeAreaView style={styles.safe}>
      <Header sessionCount={sessionHistory.length} pieceCount={namedPieces} />

      <View style={styles.toggleContainer}>
        <View style={styles.toggleTrack}>
          {RANGES.map((r) => (
            <Pressable
              key={r}
              style={[styles.toggleChip, range === r && styles.toggleChipActive]}
              onPress={() => { haptic.light(); setRange(r); }}
            >
              <Text style={[styles.toggleText, range === r && styles.toggleTextActive]}>
                {RANGE_LABELS[r]}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {stage === 'baseline' ? (
          <DepthCard>
            <Text style={styles.baselineTitle}>This is your baseline</Text>
            <Text style={styles.baselineBody}>
              One session in. Record again and everything below turns into a trend —
              what's improving, what's stuck, and what to practice next.
            </Text>
          </DepthCard>
        ) : (
          <OverallTrendCard
            points={overallPoints}
            comparison={overallComparison}
            range={range}
            onPointPress={(point) => {
              const match = sessionHistory.find(
                (s) => new Date(s.recordedAt).getTime() === point.t,
              );
              if (match) { haptic.light(); router.push(`/session/${match.id}`); }
            }}
          />
        )}

        {/* ── Categories ─────────────────────────────────── */}
        <SectionHeader label="By skill" />
        <DepthCard style={styles.categoryCard}>
          {categorySeries.map((series) => (
            <CategoryTrendRow
              key={series.id}
              series={series}
              earlyData={earlyData}
              // The metric screen renders a specific session's detail and its
              // source (sessionResultCache / currentResult) is in-memory only.
              // Without one loaded the tap would dead-end on an empty state, so
              // the row simply isn't interactive then.
              onPress={
                currentResult
                  ? () => router.push(`/metric/${CATEGORY_BY_ID[series.id].keys[0]}`)
                  : undefined
              }
            />
          ))}
        </DepthCard>

        {/* ── Still working on ───────────────────────────── */}
        {stuck.length > 0 ? (
          <>
            <SectionHeader label="Still working on" />
            {stuck.slice(0, 3).map((recurrence) => (
              <StuckIssueCard
                key={recurrence.evidence.id}
                recurrence={recurrence}
                onPractice={() => router.push('/(tabs)/train')}
              />
            ))}
          </>
        ) : sessionHistory.length < MIN_SESSIONS_FOR_STUCK ? (
          <>
            <SectionHeader label="Still working on" />
            <DepthCard>
              <Text style={styles.lockedBody}>
                After {MIN_SESSIONS_FOR_STUCK} sessions this shows the faults that keep
                coming back — the ones worth building practice around.
                {' '}{MIN_SESSIONS_FOR_STUCK - sessionHistory.length} to go.
              </Text>
            </DepthCard>
          </>
        ) : null}

        {/* ── Fixed ──────────────────────────────────────── */}
        {fixed.length > 0 && (
          <>
            <SectionHeader label="You fixed these" />
            <DepthCard onPress={() => setShowFixed((v) => !v)}>
              <View style={styles.fixedHeader}>
                <Ionicons name="checkmark-circle" size={18} color="#22c55e" />
                <Text style={styles.fixedCount}>
                  {fixed.length} issue{fixed.length === 1 ? '' : 's'} stopped showing up
                </Text>
                <Text style={styles.chevron}>{showFixed ? '⌃' : '⌄'}</Text>
              </View>
              {showFixed && (
                <View style={styles.fixedList}>
                  {fixed.map((evidence) => (
                    <Text key={evidence.id} style={styles.fixedItem}>• {evidence.title}</Text>
                  ))}
                </View>
              )}
            </DepthCard>
          </>
        )}

        {/* ── Consistency ────────────────────────────────── */}
        <SectionHeader label="Consistency" />
        <ConsistencyCard
          weeks={weeks}
          streak={streak}
          minutesThisWeek={minutesThisWeek}
          goalMinutes={weeklyGoalMinutes}
        />

        {/* ── By piece ───────────────────────────────────── */}
        {pieceSummaries.length > 0 && (
          <>
            <SectionHeader label="By piece" />
            {pieceSummaries.map((summary) => (
              <PieceSummaryCard
                key={summary.pieceId ?? 'general'}
                summary={summary}
                onPress={() => router.push(`/piece/${summary.pieceId ?? 'general'}`)}
              />
            ))}
          </>
        )}

        {/* ── Practice plan ──────────────────────────────── */}
        <DepthCard onPress={() => router.push('/(tabs)/train')} style={styles.planCard}>
          <Ionicons name="list" size={22} color={colors.brand[600]} />
          <View style={styles.planText}>
            <Text style={styles.planTitle}>Practice Plan</Text>
            <Text style={styles.planSub}>Exercises built from what's stuck</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </DepthCard>

        <View style={styles.bottomPad} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Sub-components ───────────────────────────────────────────

function Header({ sessionCount, pieceCount }: { sessionCount: number; pieceCount: number }) {
  return (
    <View style={styles.header}>
      <Text style={styles.title}>Progress</Text>
      <Text style={styles.subtitle}>
        {sessionCount === 0
          ? 'Record your first session to start tracking'
          : `${sessionCount} session${sessionCount === 1 ? '' : 's'} · ${pieceCount} piece${pieceCount === 1 ? '' : 's'}`}
      </Text>
    </View>
  );
}

function SectionHeader({ label }: { label: string }) {
  return <Text style={styles.sectionHeader}>{label}</Text>;
}

function EmptyState() {
  return (
    <View style={styles.emptyState}>
      <Ionicons name="musical-notes-outline" size={64} color={colors.brand[300]} />
      <Text style={styles.emptyTitle}>No sessions yet</Text>
      <Text style={styles.emptyBody}>
        Record a session and this becomes your practice history — which skills are
        improving, which faults keep returning, and what to work on next.
      </Text>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },

  header: {
    paddingTop: 20, paddingBottom: spacing.xl, paddingHorizontal: spacing.xl,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  title: { fontSize: 24, fontWeight: '700', color: colors.text.primary },
  subtitle: { fontSize: 13, color: colors.text.muted, marginTop: 4 },

  toggleContainer: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.background,
  },
  toggleTrack: {
    flexDirection: 'row',
    backgroundColor: '#f3f4f6',
    borderRadius: radius.lg,
    padding: 3,
    gap: 3,
  },
  toggleChip: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: radius.md },
  toggleChipActive: {
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  toggleText: { fontSize: 13, fontWeight: '600', color: colors.text.secondary },
  toggleTextActive: { color: colors.brand[600] },

  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.md },

  sectionHeader: {
    fontSize: 12, fontWeight: '700', color: colors.text.muted,
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginTop: spacing.sm,
  },

  categoryCard: { paddingVertical: 2 },

  baselineTitle: { fontSize: 16, fontWeight: '700', color: colors.text.primary },
  baselineBody: { fontSize: 13, color: colors.text.secondary, lineHeight: 19 },

  lockedBody: { fontSize: 13, color: colors.text.secondary, lineHeight: 19 },

  fixedHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  fixedCount: { flex: 1, fontSize: 14, fontWeight: '700', color: colors.text.primary },
  fixedList: { gap: 4, paddingTop: spacing.xs },
  fixedItem: { fontSize: 13, color: colors.text.secondary, lineHeight: 19 },

  planCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  planText: { flex: 1 },
  planTitle: { fontSize: 15, fontWeight: '700', color: colors.text.primary },
  planSub: { fontSize: 12, color: colors.text.muted, marginTop: 2 },

  chevron: { fontSize: 20, color: colors.text.muted, fontWeight: '300' },

  emptyState: { alignItems: 'center', paddingTop: spacing.xxl, paddingHorizontal: spacing.xl },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text.primary, marginTop: spacing.md },
  emptyBody: {
    fontSize: 13, color: colors.text.muted, textAlign: 'center',
    marginTop: spacing.sm, lineHeight: 20,
  },

  bottomPad: { height: spacing.xl },
});
