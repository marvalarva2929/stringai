import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  Pressable,
  useWindowDimensions,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useAnalysisStore } from '../../src/store/useAnalysisStore';
import { useUserStore } from '../../src/store/useUserStore';
import { haptic } from '../../src/lib/haptics';
import { DepthCard } from '../../src/components/ui/DepthCard';
import { TrendLine } from '../../src/components/charts/TrendLine';
import { DivergingBars } from '../../src/components/charts/DivergingBars';
import { DIRECTION_STYLE } from '../../src/components/charts/chartTheme';
import { colors, spacing, radius } from '../../src/constants/theme';
import { METRIC_META } from '../../src/constants/metricMeta';
import type { SessionSummary } from '../../src/types/analysis';
import { collectIssueSources } from '../../src/lib/practiceIssues';
import { buildIssueTimeline } from '../../src/lib/issueTimeline';
import { usePracticeAttemptStore } from '../../src/store/usePracticeAttemptStore';
import { IssueTimelineCard } from '../../src/components/progress/IssueTimelineCard';
import {
  categoryDeltas, compareHalves, pieceVsGlobalIssues, type TrendPoint,
} from '../../src/lib/progressAnalytics';

const SCREEN_PADDING = spacing.lg;
const CARD_PADDING = spacing.md;

export default function PieceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { width } = useWindowDimensions();

  const sessionHistory = useAnalysisStore((s) => s.sessionHistory);
  const metricHistory = useAnalysisStore((s) => s.metricHistory);
  const sessionResultCache = useAnalysisStore((s) => s.sessionResultCache);
  const currentPiece = useUserStore((st) => st.profile?.currentPiece);
  const pinPiece = useUserStore((st) => st.pinPiece);
  const unpinPiece = useUserStore((st) => st.unpinPiece);

  const isGeneral = id === 'general';
  const isPinned = currentPiece?.pieceId === id;
  const chartWidth = width - SCREEN_PADDING * 2 - CARD_PADDING * 2 - 3;

  const sessions = useMemo<SessionSummary[]>(
    () =>
      sessionHistory
        .filter((s) => (isGeneral ? !s.piece?.id : s.piece?.id === id))
        .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)),
    [sessionHistory, id, isGeneral],
  );

  const points = useMemo<TrendPoint[]>(
    () => sessions.map((s) => ({ t: new Date(s.recordedAt).getTime(), value: s.overallScore })),
    [sessions],
  );
  const comparison = useMemo(() => compareHalves(points), [points]);

  // Per-metric history for just this piece's attempts.
  const pieceEntries = useMemo(
    () => metricHistory.filter((e) => (isGeneral ? !e.pieceId : e.pieceId === id)),
    [metricHistory, id, isGeneral],
  );
  const deltas = useMemo(() => categoryDeltas(pieceEntries), [pieceEntries]);

  const issueSources = useMemo(
    () => collectIssueSources({
      recentSessions: Object.values(sessionResultCache),
      metricHistory,
    }),
    [sessionResultCache, metricHistory],
  );
  const issueSplit = useMemo(
    () => (isGeneral ? null : pieceVsGlobalIssues(issueSources, id)),
    [issueSources, id, isGeneral],
  );

  // Act three: for each issue this piece produced, what happened next.
  const attempts = usePracticeAttemptStore((st) => st.attempts);
  const timeline = useMemo(
    () => (isGeneral ? [] : buildIssueTimeline({ sources: issueSources, attempts, pieceId: id })),
    [issueSources, attempts, id, isGeneral],
  );

  const piece: { title: string; composer?: string } = isGeneral
    ? { title: 'General Practice' }
    : sessions[0]?.piece ?? { title: 'This piece' };

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

  const direction = DIRECTION_STYLE[comparison.direction];

  return (
    <SafeAreaView style={styles.safe}>
      <LinearGradient colors={[colors.brand[900], colors.brand[700]]} style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backRow}>
          <Text style={styles.backArrow}>‹</Text>
          {/* Reachable from Home as well as Progress, so it can't name a tab. */}
          <Text style={styles.backLabel}>Back</Text>
        </Pressable>
        <Text style={styles.pieceTitle} numberOfLines={2}>{piece.title}</Text>
        {piece.composer && <Text style={styles.pieceComposer}>{piece.composer}</Text>}

        {!isGeneral && (
          <Pressable
            style={styles.pinBtn}
            onPress={() => {
              haptic.medium();
              if (isPinned) unpinPiece();
              else pinPiece({ pieceId: id, title: piece.title, composer: piece.composer });
            }}
          >
            <Text style={styles.pinBtnText}>
              {isPinned ? '★ Currently practicing — tap to unpin' : '☆ Set as current piece'}
            </Text>
          </Pressable>
        )}
      </LinearGradient>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* ── Attempts over time ─────────────────────────── */}
        <DepthCard>
          <View style={styles.attemptHeader}>
            <View>
              <Text style={styles.attemptCount}>
                {sessions.length} attempt{sessions.length === 1 ? '' : 's'}
              </Text>
              <Text style={styles.attemptLabel}>on this piece</Text>
            </View>
            {comparison.direction !== 'unknown' && comparison.delta != null && (
              <View style={styles.deltaBlock}>
                <Text style={[styles.delta, { color: direction.color }]}>
                  {direction.glyph} {Math.round(comparison.delta) > 0 ? '+' : ''}{Math.round(comparison.delta)}
                </Text>
                <Text style={styles.deltaLabel}>latest tries vs. first</Text>
              </View>
            )}
          </View>

          {points.length >= 2 ? (
            <TrendLine
              points={points}
              width={chartWidth}
              onPointPress={(point) => {
                const match = sessions.find((s) => new Date(s.recordedAt).getTime() === point.t);
                if (match) { haptic.light(); router.push(`/session/${match.id}`); }
              }}
            />
          ) : (
            <Text style={styles.hint}>Record this piece again to see it as a trend.</Text>
          )}
        </DepthCard>

        {/* ── What changed ───────────────────────────────── */}
        {deltas.length > 0 && (
          <>
            <SectionHeader label="What changed on this piece" />
            <DepthCard>
              <DivergingBars deltas={deltas} width={chartWidth} />
              <Text style={styles.footnote}>
                First attempts compared with your most recent ones.
              </Text>
            </DepthCard>
          </>
        )}

        {/* ── Did the practice help? ────────────────────── */}
        {timeline.length > 0 && (
          <>
            <SectionHeader label="What you've been working on" />
            <Text style={styles.groupHint}>
              Each problem this piece has thrown up, what you did about it, and
              what the measurement has done since.
            </Text>
            <View style={styles.timeline}>
              {timeline.map((entry) => (
                <IssueTimelineCard key={entry.issueId} entry={entry} />
              ))}
            </View>
          </>
        )}

        {/* ── Issues, split by whether they follow you ───── */}
        {issueSplit && issueSplit.pieceSpecific.length > 0 && (
          <>
            <SectionHeader label="Specific to this piece" />
            <DepthCard>
              <Text style={styles.groupHint}>
                These show up here but not in your other playing — a hard passage
                rather than a technique gap.
              </Text>
              {issueSplit.pieceSpecific.slice(0, 4).map((evidence) => (
                <IssueRow key={evidence.id} title={evidence.title} metricKey={evidence.metricKey} />
              ))}
            </DepthCard>
          </>
        )}

        {issueSplit && issueSplit.universal.length > 0 && (
          <>
            <SectionHeader label="Follows you everywhere" />
            <DepthCard>
              <Text style={styles.groupHint}>
                These turn up whatever you play, so they're worth drilling on their
                own rather than inside this piece.
              </Text>
              {issueSplit.universal.slice(0, 4).map((evidence) => (
                <IssueRow key={evidence.id} title={evidence.title} metricKey={evidence.metricKey} />
              ))}
              <Pressable
                style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]}
                onPress={() => { haptic.medium(); router.push('/(tabs)/train'); }}
              >
                <Text style={styles.ctaText}>Practice these →</Text>
              </Pressable>
            </DepthCard>
          </>
        )}

        {/* ── Attempt list ───────────────────────────────── */}
        <SectionHeader label="All attempts" />
        {[...sessions].reverse().map((session) => (
          <DepthCard
            key={session.id}
            onPress={() => router.push(`/session/${session.id}`)}
            style={styles.sessionCard}
          >
            <View style={styles.sessionRow}>
              <View style={styles.sessionInfo}>
                <Text style={styles.sessionDate}>
                  {new Date(session.recordedAt).toLocaleDateString('en-US', {
                    weekday: 'short', month: 'short', day: 'numeric',
                  })}
                </Text>
                <Text style={styles.sessionMeta}>
                  {Math.round(session.durationSeconds)}s
                  {session.topIssue ? ` · Focus: ${METRIC_META[session.topIssue]?.label ?? session.topIssue}` : ''}
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </View>
          </DepthCard>
        ))}

        <View style={styles.bottomPad} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Sub-components ───────────────────────────────────────────

function SectionHeader({ label }: { label: string }) {
  return <Text style={styles.sectionHeader}>{label}</Text>;
}

function IssueRow({ title, metricKey }: { title: string; metricKey: keyof typeof METRIC_META }) {
  return (
    <View style={styles.issueRow}>
      <Text style={styles.issueIcon}>{METRIC_META[metricKey]?.icon ?? '🎻'}</Text>
      <Text style={styles.issueTitle}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },

  header: { paddingBottom: spacing.xl, paddingHorizontal: spacing.xl },
  backRow: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingTop: spacing.md, marginBottom: spacing.md,
  },
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

  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.md },

  sectionHeader: {
    fontSize: 12, fontWeight: '700', color: colors.text.muted,
    textTransform: 'uppercase', letterSpacing: 0.5, marginTop: spacing.sm,
  },

  attemptHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  attemptCount: { fontSize: 24, fontWeight: '800', color: colors.text.primary },
  attemptLabel: { fontSize: 12, color: colors.text.muted, fontWeight: '600' },
  deltaBlock: { alignItems: 'flex-end' },
  delta: { fontSize: 17, fontWeight: '800' },
  deltaLabel: { fontSize: 11, color: colors.text.muted, marginTop: 2 },
  hint: { fontSize: 13, color: colors.text.secondary, paddingVertical: spacing.sm },
  footnote: { fontSize: 11, color: colors.text.muted, marginTop: spacing.xs },

  groupHint: { fontSize: 12, color: colors.text.secondary, lineHeight: 17 },
  timeline: { gap: spacing.sm },
  issueRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingTop: 2 },
  issueIcon: { fontSize: 14, lineHeight: 19 },
  issueTitle: { flex: 1, fontSize: 13, color: colors.text.primary, fontWeight: '600', lineHeight: 19 },

  cta: {
    alignSelf: 'flex-start',
    backgroundColor: colors.brand[50],
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    marginTop: spacing.xs,
  },
  ctaPressed: { backgroundColor: colors.brand[100] },
  ctaText: { fontSize: 13, fontWeight: '700', color: colors.brand[700] },

  sessionCard: { paddingVertical: spacing.sm },
  sessionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  sessionInfo: { flex: 1 },
  sessionDate: { fontSize: 14, fontWeight: '600', color: colors.text.primary },
  sessionMeta: { fontSize: 12, color: colors.text.muted, marginTop: 2 },
  chevron: { fontSize: 20, color: colors.text.muted, fontWeight: '300' },

  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  emptyText: { fontSize: 15, color: colors.text.secondary },
  backBtn: { paddingVertical: spacing.sm, paddingHorizontal: spacing.lg },
  backBtnText: { fontSize: 15, color: colors.brand[600], fontWeight: '600' },

  bottomPad: { height: spacing.xl },
});
