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
import { haptic } from '../../src/lib/haptics';
import { Card } from '../../src/components/ui/Card';
import { ScoreGauge } from '../../src/components/ui/ScoreGauge';
import { colors, spacing, radius } from '../../src/constants/theme';
import { severityFromScore, SessionSummary } from '../../src/types/analysis';
import { scoreColor } from '../../src/lib/scoreColor';

type ProgressView = 'by_song' | 'all_sessions';

interface PieceGroup {
  pieceId: string | null;
  piece: { id: string; title: string; composer?: string } | null;
  sessions: SessionSummary[]; // ascending by recordedAt
  sessionCount: number;
  avgScore: number;
  bestScore: number;
  latestScore: number;
  improvement: number | null; // last score − first score
  scoreHistory: number[];
  latestDate: string;
}

function ScoreDots({ scores }: { scores: number[] }) {
  const recent = scores.slice(-6);
  return (
    <View style={dot.row}>
      {recent.map((s, i) => (
        <View key={i} style={[dot.circle, { backgroundColor: scoreColor(s) }]} />
      ))}
    </View>
  );
}

const dot = StyleSheet.create({
  row:    { flexDirection: 'row', alignItems: 'center', gap: 5 },
  circle: { width: 8, height: 8, borderRadius: 4 },
});

export default function ProgressScreen() {
  const { sessionHistory } = useAnalysisStore();
  const [view, setView] = useState<ProgressView>('by_song');

  const hasData = sessionHistory.length > 0;

  // Group sessions by piece
  const pieceGroups = useMemo<PieceGroup[]>(() => {
    const map = new Map<string | null, SessionSummary[]>();
    for (const s of sessionHistory) {
      const key = s.piece?.id ?? null;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }

    const groups: PieceGroup[] = [];
    for (const [pieceId, sessions] of map.entries()) {
      const sorted = [...sessions].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
      const scores = sorted.map((s) => s.overallScore);
      const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
      groups.push({
        pieceId,
        piece: sorted[0].piece ?? null,
        sessions: sorted,
        sessionCount: sorted.length,
        avgScore: avg,
        bestScore: Math.max(...scores),
        latestScore: scores[scores.length - 1],
        improvement: scores.length >= 2 ? scores[scores.length - 1] - scores[0] : null,
        scoreHistory: scores,
        latestDate: sorted[sorted.length - 1].recordedAt,
      });
    }

    // Most recently played piece first; general practice last
    return groups
      .sort((a, b) => b.latestDate.localeCompare(a.latestDate))
      .sort((a, b) => (a.pieceId === null ? 1 : 0) - (b.pieceId === null ? 1 : 0));
  }, [sessionHistory]);

  const namedGroups = pieceGroups.filter((g) => g.pieceId !== null);
  const generalGroup = pieceGroups.find((g) => g.pieceId === null) ?? null;

  const avgScore = hasData
    ? Math.round(sessionHistory.reduce((a, s) => a + s.overallScore, 0) / sessionHistory.length)
    : null;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.title}>Progress</Text>
        <Text style={styles.subtitle}>
          {hasData
            ? `${sessionHistory.length} session${sessionHistory.length === 1 ? '' : 's'} · ${namedGroups.length} piece${namedGroups.length === 1 ? '' : 's'}`
            : 'Record your first session to start tracking'}
        </Text>
      </View>

      {/* View toggle — styled as iOS segmented control */}
      <View style={styles.toggleContainer}>
        <View style={styles.toggleTrack}>
          <Pressable
            style={[styles.toggleChip, view === 'by_song' && styles.toggleChipActive]}
            onPress={() => setView('by_song')}
          >
            <Text style={[styles.toggleText, view === 'by_song' && styles.toggleTextActive]}>
              By Song
            </Text>
          </Pressable>
          <Pressable
            style={[styles.toggleChip, view === 'all_sessions' && styles.toggleChipActive]}
            onPress={() => setView('all_sessions')}
          >
            <Text style={[styles.toggleText, view === 'all_sessions' && styles.toggleTextActive]}>
              All Sessions
            </Text>
          </Pressable>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Practice plan entry point */}
        <Pressable style={styles.practiceCard} onPress={() => router.push('/tips')}>
          <Ionicons name="list" size={24} color={colors.brand[600]} />
          <View style={styles.practiceCardText}>
            <Text style={styles.practiceCardTitle}>Practice Plan</Text>
            <Text style={styles.practiceCardSub}>Personalized exercises based on your sessions</Text>
          </View>
          <Text style={styles.practiceCardArrow}>›</Text>
        </Pressable>

        {/* ── By Song view ─────────────────────────────────── */}
        {view === 'by_song' && (
          <>
            {namedGroups.length === 0 && !generalGroup && (
              <EmptyState />
            )}

            {namedGroups.map((group) => (
              <PieceGroupCard
                key={group.pieceId!}
                group={group}
                onPress={() => router.push(`/piece/${group.pieceId}`)}
              />
            ))}

            {generalGroup && (
              <PieceGroupCard
                key="general"
                group={generalGroup}
                onPress={() => router.push('/piece/general')}
              />
            )}
          </>
        )}

        {/* ── All Sessions view ─────────────────────────────── */}
        {view === 'all_sessions' && (
          <>
            {avgScore != null && (
              <Card style={styles.avgCard}>
                <Text style={styles.sectionLabel}>Average Score</Text>
                <View style={styles.avgRow}>
                  <ScoreGauge score={avgScore} severity={severityFromScore(avgScore)} size="lg" />
                  <View style={styles.avgInfo}>
                    <Text style={styles.avgSubtitle}>across {sessionHistory.length} sessions</Text>
                    <Text style={styles.avgHint}>Keep practicing daily for the fastest improvement.</Text>
                  </View>
                </View>
              </Card>
            )}

            {hasData ? (
              <>
                <Text style={styles.historyHeading}>Session History</Text>
                {[...sessionHistory]
                  .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
                  .map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      onPress={() => router.push(`/session/${session.id}`)}
                    />
                  ))}
              </>
            ) : (
              <EmptyState />
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Sub-components ───────────────────────────────────────────

function PieceGroupCard({
  group,
  onPress,
}: {
  group: PieceGroup;
  onPress: () => void;
}) {
  const isGeneral = group.pieceId === null;
  const title = isGeneral ? 'General Practice' : (group.piece?.title ?? 'Unknown Piece');
  const sub = isGeneral
    ? `${group.sessionCount} session${group.sessionCount === 1 ? '' : 's'} without a selected piece`
    : `${group.piece?.composer ?? 'Unknown'} · ${group.sessionCount} session${group.sessionCount === 1 ? '' : 's'}`;

  return (
    <Pressable
      style={({ pressed }) => [styles.groupCard, { opacity: pressed ? 0.85 : 1 }]}
      onPress={onPress}
    >
      <View style={styles.groupTop}>
        <View style={styles.groupTitleBlock}>
          <Text style={styles.groupTitle} numberOfLines={1}>{title}</Text>
          <Text style={styles.groupSub} numberOfLines={1}>{sub}</Text>
        </View>
        <View style={styles.groupScoreBlock}>
          <Text style={styles.groupAvg}>{group.avgScore}</Text>
          <Text style={styles.groupAvgLabel}>avg</Text>
        </View>
        <Text style={styles.groupArrow}>›</Text>
      </View>

      <View style={styles.groupBottom}>
        <ScoreDots scores={group.scoreHistory} />
        <View style={styles.groupStats}>
          <Text style={styles.groupBest}>Best {group.bestScore}</Text>
          {group.improvement !== null && (
            <Text style={[
              styles.groupDelta,
              { color: group.improvement >= 0 ? colors.score.excellent : colors.score.critical },
            ]}>
              {group.improvement >= 0 ? '▲' : '▼'} {Math.abs(group.improvement)} pts overall
            </Text>
          )}
        </View>
      </View>
    </Pressable>
  );
}

function SessionRow({ session, onPress }: { session: SessionSummary; onPress?: () => void }) {
  return (
    <Pressable onPress={() => { haptic.light(); onPress?.(); }} style={({ pressed }) => [{ opacity: pressed ? 0.75 : 1 }]}>
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
            <Text style={styles.sessionMeta} numberOfLines={1}>
              {session.piece?.title
                ? session.piece.title
                : session.instrument}{' '}
              · {Math.round(session.durationSeconds)}s
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
          {onPress && <Text style={styles.sessionArrow}>›</Text>}
        </View>
      </Card>
    </Pressable>
  );
}

function EmptyState() {
  return (
    <View style={styles.emptyState}>
      <Ionicons name="musical-notes-outline" size={64} color={colors.brand[300]} />
      <Text style={styles.emptyTitle}>No sessions yet</Text>
      <Text style={styles.emptyBody}>
        Head to the Analyze tab and record your first session.
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
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  toggleTrack: {
    flexDirection: 'row',
    backgroundColor: '#f3f4f6',
    borderRadius: radius.lg,
    padding: 3,
    gap: 3,
  },
  toggleChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 7,
    borderRadius: radius.md,
  },
  toggleChipActive: {
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  toggleText: { fontSize: 14, fontWeight: '600', color: colors.text.secondary },
  toggleTextActive: { color: colors.brand[600] },

  content: { padding: spacing.lg, gap: spacing.md },

  // Piece group card
  groupCard: {
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 3,
  },
  groupTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  groupTitleBlock: { flex: 1 },
  groupTitle: { fontSize: 15, fontWeight: '700', color: colors.text.primary },
  groupSub: { fontSize: 12, color: colors.text.muted, marginTop: 2 },
  groupScoreBlock: { alignItems: 'center', minWidth: 36 },
  groupAvg: { fontSize: 22, fontWeight: '700', color: colors.text.primary, lineHeight: 26 },
  groupAvgLabel: { fontSize: 10, color: colors.text.muted, fontWeight: '600', textTransform: 'uppercase' },
  groupArrow: { fontSize: 22, color: colors.text.muted, fontWeight: '300', alignSelf: 'center' },
  groupBottom: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  groupStats: { alignItems: 'flex-end', gap: 2 },
  groupBest: { fontSize: 11, color: colors.text.muted },
  groupDelta: { fontSize: 12, fontWeight: '700' },

  // Average card
  avgCard: {},
  avgRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avgInfo: { flex: 1 },
  avgSubtitle: { fontSize: 13, color: colors.text.secondary },
  avgHint: { fontSize: 12, color: colors.text.muted, marginTop: 4, lineHeight: 17 },

  sectionLabel: {
    fontSize: 12, fontWeight: '700', color: colors.text.muted,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: spacing.sm,
  },

  // Session list
  historyHeading: {
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

  // Empty state
  emptyState: { alignItems: 'center', paddingTop: spacing.xxl },
  emptyEmoji: { fontSize: 48, marginBottom: spacing.md },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text.primary },
  emptyBody: { fontSize: 13, color: colors.text.muted, textAlign: 'center', marginTop: spacing.sm, lineHeight: 20 },

  // Practice plan card
  practiceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    padding: spacing.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  practiceCardIcon: { fontSize: 24 },
  practiceCardText: { flex: 1 },
  practiceCardTitle: { fontSize: 15, fontWeight: '700', color: colors.text.primary },
  practiceCardSub: { fontSize: 12, color: colors.text.muted, marginTop: 2 },
  practiceCardArrow: { fontSize: 22, color: colors.text.muted, fontWeight: '300' },
});
