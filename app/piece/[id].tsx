import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  Pressable,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useAnalysisStore } from '../../src/store/useAnalysisStore';
import { useUserStore } from '../../src/store/useUserStore';
import { haptic } from '../../src/lib/haptics';
import { Card } from '../../src/components/ui/Card';
import { ScoreGauge } from '../../src/components/ui/ScoreGauge';
import { colors, spacing, radius } from '../../src/constants/theme';
import { severityFromScore, SessionSummary } from '../../src/types/analysis';

function ScoreBar({ score, maxScore }: { score: number; maxScore: number }) {
  const height = Math.max(4, Math.round((score / 100) * 80));
  const isLatest = score === maxScore;
  return (
    <View style={bar.wrap}>
      <Text style={bar.label}>{score}</Text>
      <View
        style={[
          bar.fill,
          {
            height,
            backgroundColor: isLatest
              ? colors.brand[500]
              : score >= 70
              ? colors.score.excellent
              : score >= 50
              ? '#f59e0b'
              : colors.score.critical,
          },
        ]}
      />
    </View>
  );
}

const bar = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 3 },
  label: { fontSize: 10, color: colors.text.muted, fontWeight: '600' },
  fill: { width: 28, borderRadius: 4 },
});

export default function PieceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { sessionHistory } = useAnalysisStore();
  const currentPiece = useUserStore((st) => st.profile?.currentPiece);
  const pinPiece = useUserStore((st) => st.pinPiece);
  const unpinPiece = useUserStore((st) => st.unpinPiece);

  const isGeneral = id === 'general';
  const isPinned = currentPiece?.pieceId === id;

  const sessions = useMemo<SessionSummary[]>(
    () =>
      sessionHistory
        .filter((s) => isGeneral ? !s.piece?.id : s.piece?.id === id)
        .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)),
    [sessionHistory, id, isGeneral],
  );

  // Non-general: the filter above guarantees every session carries this piece,
  // so sessions[0].piece is present whenever sessions is non-empty. The fallback
  // only covers the empty case, which renders the empty state below anyway.
  const piece: { title: string; composer?: string } = isGeneral
    ? { title: 'General Practice' }
    : sessions[0]?.piece ?? { title: 'This piece' };
  const scores = sessions.map((s) => s.overallScore);
  const avgScore = scores.length
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;
  const bestScore = scores.length ? Math.max(...scores) : 0;
  const latestScore = scores[scores.length - 1] ?? 0;
  const improvement = scores.length >= 2 ? latestScore - scores[0] : null;

  if (sessions.length === 0) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>No sessions found for this piece.</Text>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Text style={styles.backBtnText}>← Go Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <LinearGradient colors={[colors.brand[900], colors.brand[700]]} style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backRow}>
          <Text style={styles.backArrow}>‹</Text>
          <Text style={styles.backLabel}>Progress</Text>
        </Pressable>
        <Text style={styles.pieceTitle} numberOfLines={2}>{piece.title}</Text>
        {piece.composer && <Text style={styles.pieceComposer}>{piece.composer}</Text>}

        {!isGeneral && (
          <Pressable
            style={styles.pinBtn}
            onPress={() => {
              haptic.medium();
              if (isPinned) unpinPiece();
              else pinPiece({ pieceId: id, title: piece?.title ?? 'This piece', composer: piece?.composer });
            }}
          >
            <Text style={styles.pinBtnText}>
              {isPinned ? '★ Currently practicing — tap to unpin' : '☆ Set as current piece'}
            </Text>
          </Pressable>
        )}
      </LinearGradient>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Stats row */}
        <View style={styles.statsRow}>
          <StatBox label="Sessions" value={String(sessions.length)} />
          <StatBox label="Average" value={String(avgScore)} />
          <StatBox label="Best" value={String(bestScore)} />
          {improvement !== null && (
            <StatBox
              label="Overall"
              value={`${improvement >= 0 ? '+' : ''}${improvement}`}
              valueColor={improvement >= 0 ? colors.score.excellent : colors.score.critical}
            />
          )}
        </View>

        {/* Score trend chart */}
        <Card style={styles.chartCard}>
          <Text style={styles.sectionLabel}>Score Over Sessions</Text>
          <View style={styles.chartWrapper}>
            {/* Reference line at score 70 ("good" threshold) */}
            <View style={styles.chartRefLine} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.chartArea}>
                {sessions.map((s, i) => (
                  <View key={s.id} style={styles.chartCol}>
                    <ScoreBar score={s.overallScore} maxScore={bestScore} />
                    <Text style={styles.chartDateLabel}>
                      {new Date(s.recordedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </Text>
                  </View>
                ))}
              </View>
            </ScrollView>
          </View>
          {improvement !== null && (
            <Text style={[
              styles.chartCaption,
              { color: improvement >= 0 ? colors.score.excellent : colors.score.critical },
            ]}>
              {improvement >= 0 ? '▲' : '▼'} {Math.abs(improvement)} pts from first to latest session
            </Text>
          )}
        </Card>

        {/* Session list */}
        <Text style={styles.sectionHeading}>All Sessions</Text>
        {[...sessions].reverse().map((session) => (
          <Pressable
            key={session.id}
            onPress={() => router.push(`/session/${session.id}`)}
            style={({ pressed }) => [{ opacity: pressed ? 0.75 : 1 }]}
          >
            <Card style={styles.sessionCard}>
              <View style={styles.sessionRow}>
                <ScoreGauge
                  score={session.overallScore}
                  severity={severityFromScore(session.overallScore)}
                  size="sm"
                  showLabel={false}
                />
                <View style={styles.sessionInfo}>
                  <Text style={styles.sessionDate}>
                    {new Date(session.recordedAt).toLocaleDateString('en-US', {
                      weekday: 'short', month: 'short', day: 'numeric',
                    })}
                  </Text>
                  <Text style={styles.sessionMeta}>
                    {Math.round(session.durationSeconds)}s session
                    {session.topIssue ? ` · Focus: ${session.topIssue}` : ''}
                  </Text>
                </View>
                {session.overallDelta != null && (
                  <Text style={[
                    styles.sessionDelta,
                    { color: session.overallDelta >= 0 ? colors.score.excellent : colors.score.critical },
                  ]}>
                    {session.overallDelta >= 0 ? '+' : ''}{session.overallDelta}
                  </Text>
                )}
                <Text style={styles.sessionArrow}>›</Text>
              </View>
            </Card>
          </Pressable>
        ))}

      </ScrollView>
    </SafeAreaView>
  );
}

function StatBox({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.statBox}>
      <Text style={[styles.statValue, valueColor ? { color: valueColor } : {}]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },

  header: { paddingBottom: spacing.xl, paddingHorizontal: spacing.xl },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingTop: spacing.md, marginBottom: spacing.md },
  backArrow: { fontSize: 24, color: 'rgba(255,255,255,0.8)', lineHeight: 28 },
  backLabel: { fontSize: 14, color: 'rgba(255,255,255,0.8)', fontWeight: '500' },
  pieceTitle: { fontSize: 22, fontWeight: '700', color: '#fff', lineHeight: 28 },
  pieceComposer: { fontSize: 14, color: 'rgba(255,255,255,0.7)', marginTop: 4 },
  pinBtn: {
    marginTop: spacing.md,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
  },
  pinBtnText: { color: '#fff', fontSize: 13, fontWeight: '800' },

  content: { padding: spacing.lg, gap: spacing.md },

  // Stats
  statsRow: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 3,
  },
  statBox: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderRightWidth: 1,
    borderRightColor: '#f0f0f0',
  },
  statValue: { fontSize: 22, fontWeight: '700', color: colors.brand[700] },
  statLabel: { fontSize: 11, color: colors.text.muted, fontWeight: '600', textTransform: 'uppercase', marginTop: 2 },

  // Chart
  chartCard: {},
  sectionLabel: {
    fontSize: 12, fontWeight: '700', color: colors.text.muted,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: spacing.md,
  },
  chartWrapper: {
    position: 'relative',
    minHeight: 110,
    paddingTop: spacing.sm,
  },
  chartRefLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: Math.round(spacing.sm + (1 - 0.70) * 80),
    height: 1,
    backgroundColor: 'rgba(22,163,74,0.25)',
    zIndex: 1,
  },
  chartArea: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    minHeight: 100,
    paddingTop: spacing.sm,
    paddingBottom: 4,
  },
  chartCol: { alignItems: 'center', gap: 4 },
  chartDateLabel: { fontSize: 9, color: colors.text.muted, textAlign: 'center' },
  chartCaption: { fontSize: 12, fontWeight: '600', marginTop: spacing.sm, textAlign: 'center' },

  // Session list
  sectionHeading: {
    fontSize: 13, fontWeight: '700', color: colors.text.muted,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  sessionCard: { marginBottom: 0 },
  sessionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  sessionInfo: { flex: 1 },
  sessionDate: { fontSize: 14, fontWeight: '600', color: colors.text.primary },
  sessionMeta: { fontSize: 12, color: colors.text.muted, marginTop: 2 },
  sessionDelta: { fontSize: 14, fontWeight: '700' },
  sessionArrow: { fontSize: 18, color: colors.text.muted, marginLeft: spacing.xs },

  // Empty / error
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  emptyText: { fontSize: 15, color: colors.text.secondary },
  backBtn: { paddingVertical: spacing.sm, paddingHorizontal: spacing.lg },
  backBtnText: { fontSize: 15, color: colors.brand[600], fontWeight: '600' },
});
