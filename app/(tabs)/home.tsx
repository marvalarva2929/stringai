import React, { useMemo, useState } from 'react';
import {
  ScrollView,
  View,
  Text,
  StyleSheet,
  Pressable,
  SafeAreaView,
} from 'react-native';
import { router } from 'expo-router';
import { useUserStore } from '../../src/store/useUserStore';
import { useAuthStore } from '../../src/store/useAuthStore';
import { useAnalysisStore } from '../../src/store/useAnalysisStore';
import { Button } from '../../src/components/ui/Button';
import { TunerModal } from '../../src/components/tuner/TunerModal';
import { colors, spacing, radius } from '../../src/constants/theme';
import { MetricKey, SessionSummary } from '../../src/types/analysis';
import { Piece } from '../../src/types/piece';
import { METRIC_META } from '../../src/constants/metricMeta';

const FREE_LIMIT = 2;

// ── Helpers ───────────────────────────────────────────────────

function computeStreak(sessions: SessionSummary[]): number {
  if (sessions.length === 0) return 0;
  const DAY = 86_400_000;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dates = new Set(sessions.map((s) => {
    const d = new Date(s.recordedAt); d.setHours(0, 0, 0, 0); return d.getTime();
  }));
  let check = today.getTime();
  if (!dates.has(check)) { check -= DAY; if (!dates.has(check)) return 0; }
  let streak = 0;
  while (dates.has(check)) { streak++; check -= DAY; }
  return streak;
}

function topFocusMetric(sessions: SessionSummary[]): MetricKey | null {
  const recent = sessions.slice(0, 5).map((s) => s.topIssue).filter(Boolean) as MetricKey[];
  if (recent.length === 0) return null;
  const freq = new Map<MetricKey, number>();
  for (const m of recent) freq.set(m, (freq.get(m) ?? 0) + 1);
  let best: MetricKey | null = null, max = 0;
  for (const [m, n] of freq) { if (n > max) { max = n; best = m; } }
  return best;
}

// ── Mini sparkline ────────────────────────────────────────────

function Sparkline({ scores }: { scores: number[] }) {
  if (scores.length < 2) return null;
  return (
    <View style={spark.row}>
      {scores.map((score, i) => (
        <View key={i} style={[spark.bar, {
          height: Math.max(3, Math.round((score / 100) * 28)),
          backgroundColor: score >= 70 ? colors.score.excellent : score >= 50 ? '#f59e0b' : colors.score.critical,
        }]} />
      ))}
    </View>
  );
}
const spark = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', height: 28, gap: 3 },
  bar: { width: 8, borderRadius: 2 },
});

// ── Piece group type ──────────────────────────────────────────

interface PieceGroup {
  pieceId: string | null;
  piece: { id: string; title: string; composer?: string } | null;
  sessions: SessionSummary[];
  sessionCount: number;
  latestScore: number;
  improvement: number | null;
  scoreHistory: number[];
  latestDate: string;
}

// ── Main screen ───────────────────────────────────────────────

export default function HomeScreen() {
  const [tunerOpen, setTunerOpen] = useState(false);
  const { profile } = useUserStore();
  const { isAuthenticated, guestAnalysesUsed, canAnalyzeAsGuest } = useAuthStore();
  const { sessionHistory, reset, continueWithPiece } = useAnalysisStore();

  const isSubscribed = profile?.subscriptionTier === 'monthly' || profile?.subscriptionTier === 'annual';
  const freeUsed = isAuthenticated ? (profile?.freeAnalysesUsed ?? 0) : guestAnalysesUsed;
  const canAnalyze = isSubscribed || (!isAuthenticated && canAnalyzeAsGuest()) || (isAuthenticated && (profile?.freeAnalysesUsed ?? 0) < 2);

  // ── Analytics ──────────────────────────────────────────────
  const analytics = useMemo(() => {
    if (sessionHistory.length === 0) return null;

    const sorted = [...sessionHistory].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    const scores = sorted.map((s) => s.overallScore);
    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

    // Trend: avg of newest 3 vs avg of 3 before that
    const recent = scores.slice(-3);
    const prev = scores.slice(-6, -3);
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const prevAvg = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : null;
    const trend = prevAvg != null ? Math.round(recentAvg - prevAvg) : null;

    // Sparkline: last 8 sessions chronologically
    const sparkScores = scores.slice(-8);

    const streak = computeStreak(sessionHistory);
    const focusMetric = topFocusMetric(sessionHistory);

    return { avgScore, trend, sparkScores, streak, totalSessions: sessionHistory.length, focusMetric };
  }, [sessionHistory]);

  // ── Piece groups ───────────────────────────────────────────
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
      const sc = sorted.map((s) => s.overallScore);
      groups.push({
        pieceId,
        piece: sorted[0].piece ?? null,
        sessions: sorted,
        sessionCount: sorted.length,
        latestScore: sc[sc.length - 1],
        improvement: sc.length >= 2 ? sc[sc.length - 1] - sc[0] : null,
        scoreHistory: sc,
        latestDate: sorted[sorted.length - 1].recordedAt,
      });
    }
    return groups
      .sort((a, b) => b.latestDate.localeCompare(a.latestDate))
      .sort((a, b) => (a.pieceId === null ? 1 : 0) - (b.pieceId === null ? 1 : 0));
  }, [sessionHistory]);

  const handleNewAnalysis = () => {
    if (!canAnalyze) { router.push('/paywall'); return; }
    reset();
    router.push('/(tabs)/analyze');
  };

  const handleContinue = (group: PieceGroup) => {
    if (!canAnalyze) { router.push('/paywall'); return; }
    const piece: Piece | null = group.piece
      ? { id: group.piece.id, title: group.piece.title, composer: group.piece.composer, source: 'manual' }
      : null;
    continueWithPiece(piece);
    router.push('/(tabs)/analyze');
  };

  return (
    <SafeAreaView style={styles.safe}>
      <TunerModal visible={tunerOpen} onClose={() => setTunerOpen(false)} />
      <View style={styles.titleBar}>
        <Text style={styles.titleText}>String AI</Text>
        <Pressable style={styles.tunerBtn} onPress={() => setTunerOpen(true)}>
          <Text style={styles.tunerBtnText}>♩ Tune</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        <View style={styles.content}>


          {/* ── Analytics ──────────────────────────────────── */}
          {analytics && (
            <>
              {/* Stats strip */}
              <View style={styles.statsStrip}>
                <StatBox label="Sessions" value={String(analytics.totalSessions)} />
                <View style={styles.statsDivider} />
                <StatBox label="Avg Score" value={String(analytics.avgScore)} />
                <View style={styles.statsDivider} />
                <StatBox
                  label="Trend"
                  value={analytics.trend != null ? `${analytics.trend >= 0 ? '+' : ''}${analytics.trend}` : '—'}
                  valueColor={analytics.trend != null ? (analytics.trend >= 0 ? colors.score.excellent : colors.score.critical) : undefined}
                />
                <View style={styles.statsDivider} />
                <StatBox
                  label="Streak"
                  value={analytics.streak > 0 ? `${analytics.streak}🔥` : '0'}
                />
              </View>

              {/* Score trend card */}
              {analytics.sparkScores.length >= 2 && (
                <View style={styles.trendCard}>
                  <Text style={styles.cardLabel}>Score Trend</Text>
                  <Sparkline scores={analytics.sparkScores} />
                  {analytics.trend != null && (
                    <Text style={[
                      styles.trendCaption,
                      { color: analytics.trend >= 0 ? colors.score.excellent : colors.score.critical },
                    ]}>
                      {analytics.trend >= 0 ? '▲' : '▼'} {Math.abs(analytics.trend)} pts over last 3 sessions
                    </Text>
                  )}
                </View>
              )}

              {/* Focus / exercise tip */}
              {analytics.focusMetric && METRIC_META[analytics.focusMetric] && (
                <Pressable style={styles.focusCard} onPress={() => router.push('/tips')}>
                  <View style={styles.focusHeader}>
                    <Text style={styles.focusIcon}>{METRIC_META[analytics.focusMetric].icon}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.focusLabel}>Focus This Week</Text>
                      <Text style={styles.focusMetric}>{METRIC_META[analytics.focusMetric].label}</Text>
                    </View>
                    <Text style={styles.focusArrow}>›</Text>
                  </View>
                  <Text style={styles.focusTip}>
                    {METRIC_META[analytics.focusMetric].tips.needs_attention}
                  </Text>
                  <Text style={styles.focusPlanLink}>See full practice plan →</Text>
                </Pressable>
              )}

              {/* Practice plan link when no focus metric yet */}
              {!analytics.focusMetric && (
                <Pressable style={styles.tipsCard} onPress={() => router.push('/tips')}>
                  <Text style={styles.tipsCardIcon}>📋</Text>
                  <View style={styles.tipsCardText}>
                    <Text style={styles.tipsCardTitle}>Exercise Library</Text>
                    <Text style={styles.tipsCardSub}>Browse all technique exercises</Text>
                  </View>
                  <Text style={styles.tipsCardArrow}>›</Text>
                </Pressable>
              )}
            </>
          )}

          {/* ── Piece groups ────────────────────────────────── */}
          {pieceGroups.length > 0 ? (
            <>
              <Text style={styles.sectionHeading}>Your Pieces</Text>
              {pieceGroups.map((group) => {
                return (
                  <PieceGroupCard
                    key={group.pieceId ?? 'general'}
                    group={group}
                    onPress={() =>
                      group.pieceId
                        ? router.push(`/piece/${group.pieceId}`)
                        : router.push('/(tabs)/progress')
                    }
                    onContinue={() => handleContinue(group)}
                  />
                );
              })}
            </>
          ) : (
            <>
              <View style={styles.emptyCard}>
                <Text style={styles.emptyEmoji}>🎻</Text>
                <Text style={styles.emptyTitle}>No sessions yet</Text>
                <Text style={styles.emptyBody}>
                  Tap New Analysis, name the piece you're working on, and record your first session.
                </Text>
              </View>
              <Pressable style={styles.tipsCard} onPress={() => router.push('/tips')}>
                <Text style={styles.tipsCardIcon}>📋</Text>
                <View style={styles.tipsCardText}>
                  <Text style={styles.tipsCardTitle}>Browse Exercises</Text>
                  <Text style={styles.tipsCardSub}>Explore 50+ technique exercises while you wait</Text>
                </View>
                <Text style={styles.tipsCardArrow}>›</Text>
              </Pressable>
            </>
          )}

          {/* Upgrade prompt */}
          {!isSubscribed && freeUsed >= FREE_LIMIT && (
            <Pressable onPress={() => router.push('/paywall')} style={styles.upgradeCard}>
              <Text style={styles.upgradeEmoji}>⭐</Text>
              <View style={styles.upgradeText}>
                <Text style={styles.upgradeTitle}>Unlock Unlimited Analyses</Text>
                <Text style={styles.upgradeSubtitle}>From $9.99/mo — cancel anytime</Text>
              </View>
              <Text style={styles.upgradeArrow}>→</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>

      {/* Fixed bottom CTA */}
      <View style={styles.bottomBar}>
        {!isSubscribed && freeUsed < FREE_LIMIT && (
          <Text style={styles.freeNotice}>
            {Math.max(0, FREE_LIMIT - freeUsed)} free {FREE_LIMIT - freeUsed === 1 ? 'analysis' : 'analyses'} remaining
          </Text>
        )}
        <Button label="New Analysis" onPress={handleNewAnalysis} size="lg" fullWidth />
      </View>
    </SafeAreaView>
  );
}

// ── Piece group card ──────────────────────────────────────────

function PieceGroupCard({
  group,
  onPress,
  onContinue,
}: {
  group: PieceGroup;
  onPress?: () => void;
  onContinue: () => void;
}) {
  const isGeneral = group.pieceId === null;
  const title = isGeneral ? 'General Practice' : (group.piece?.title ?? 'Unknown Piece');
  const sub = isGeneral
    ? `${group.sessionCount} session${group.sessionCount === 1 ? '' : 's'}`
    : [group.piece?.composer, `${group.sessionCount} session${group.sessionCount === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  const lastPlayed = new Date(group.latestDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <Pressable style={card.wrap} onPress={onPress}>
      <View style={card.topRow}>
        <View style={card.titleBlock}>
          <Text style={card.title} numberOfLines={1}>{title}</Text>
          <Text style={card.sub} numberOfLines={1}>{sub}</Text>
        </View>
        <View style={card.scoreBlock}>
          <Text style={[card.score, { color: scoreColor(group.latestScore) }]}>{group.latestScore}</Text>
          <Text style={card.scoreLabel}>latest</Text>
        </View>
        <Text style={card.cardArrow}>›</Text>
      </View>
      <View style={card.midRow}>
        <Sparkline scores={group.scoreHistory} />
        <View style={card.midStats}>
          <Text style={card.lastPlayed}>Last played {lastPlayed}</Text>
          {group.improvement !== null && (
            <Text style={[card.delta, { color: group.improvement >= 0 ? colors.score.excellent : colors.score.critical }]}>
              {group.improvement >= 0 ? '▲' : '▼'} {Math.abs(group.improvement)} pts overall
            </Text>
          )}
        </View>
      </View>
      <Pressable style={card.continueBtn} onPress={onContinue}>
        <Text style={card.continueBtnText}>Continue Session  →</Text>
      </Pressable>
    </Pressable>
  );
}

function StatBox({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={styles.statBox}>
      <Text style={[styles.statValue, valueColor ? { color: valueColor } : {}]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function scoreColor(score: number): string {
  if (score >= 90) return colors.score.excellent;
  if (score >= 70) return '#16a34a';
  if (score >= 50) return '#d97706';
  return colors.score.critical;
}

// ── Styles ────────────────────────────────────────────────────

const card = StyleSheet.create({
  wrap: {
    backgroundColor: '#fff', borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 8, elevation: 3,
  },
  topRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  titleBlock: { flex: 1 },
  title: { fontSize: 16, fontWeight: '700', color: colors.text.primary },
  sub: { fontSize: 12, color: colors.text.muted, marginTop: 2 },
  scoreBlock: { alignItems: 'flex-end' },
  score: { fontSize: 26, fontWeight: '800', lineHeight: 30 },
  scoreLabel: { fontSize: 10, color: colors.text.muted, fontWeight: '600', textTransform: 'uppercase' },
  midRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  midStats: { alignItems: 'flex-end', gap: 2 },
  lastPlayed: { fontSize: 11, color: colors.text.muted },
  delta: { fontSize: 12, fontWeight: '700' },
  cardArrow: { fontSize: 22, color: colors.text.muted, fontWeight: '300', alignSelf: 'center', marginLeft: spacing.xs },
  continueBtn: {
    marginTop: spacing.xs, backgroundColor: colors.brand[50], borderRadius: radius.md,
    paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: colors.brand[200],
  },
  continueBtnText: { fontSize: 14, fontWeight: '700', color: colors.brand[700] },
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  titleBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: '#ede9fe',
    backgroundColor: colors.background,
  },
  titleText: { fontSize: 34, fontWeight: '800', color: colors.brand[700], letterSpacing: -1 },
  tunerBtn: {
    backgroundColor: colors.brand[50],
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: colors.brand[200],
  },
  tunerBtnText: { fontSize: 14, fontWeight: '700', color: colors.brand[700] },
  scroll: { flexGrow: 1 },
  content: { padding: spacing.lg, paddingTop: spacing.lg, gap: spacing.md, paddingBottom: 110 },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    paddingTop: spacing.sm,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: '#ede9fe',
    gap: spacing.xs,
  },
  freeNotice: { fontSize: 12, color: colors.text.muted, textAlign: 'center' },

  // Stats strip
  statsStrip: {
    flexDirection: 'row', backgroundColor: '#fff', borderRadius: radius.lg,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2,
  },
  statBox: { flex: 1, alignItems: 'center', paddingVertical: spacing.md },
  statValue: { fontSize: 20, fontWeight: '800', color: colors.brand[700] },
  statLabel: { fontSize: 10, color: colors.text.muted, fontWeight: '600', textTransform: 'uppercase', marginTop: 2 },
  statsDivider: { width: 1, backgroundColor: '#f0f0f0', marginVertical: spacing.sm },

  // Trend card
  trendCard: {
    backgroundColor: '#fff', borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2,
  },
  cardLabel: { fontSize: 12, fontWeight: '700', color: colors.text.muted, textTransform: 'uppercase', letterSpacing: 0.5 },
  trendCaption: { fontSize: 12, fontWeight: '600' },

  // Focus card
  focusCard: {
    backgroundColor: colors.brand[50], borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm,
    borderWidth: 1, borderColor: colors.brand[200],
  },
  focusHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  focusIcon: { fontSize: 28 },
  focusLabel: { fontSize: 10, fontWeight: '700', color: colors.brand[600], textTransform: 'uppercase', letterSpacing: 0.5 },
  focusMetric: { fontSize: 15, fontWeight: '700', color: colors.brand[800] },
  focusTip: { fontSize: 13, color: colors.brand[800], lineHeight: 19 },
  focusArrow: { fontSize: 22, color: colors.brand[400], fontWeight: '300' },
  focusPlanLink: { fontSize: 12, fontWeight: '700', color: colors.brand[600] },
  // Tips entry point card (shown when no focus metric)
  tipsCard: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: '#fff', borderRadius: radius.lg, padding: spacing.md,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2,
  },
  tipsCardIcon: { fontSize: 24 },
  tipsCardText: { flex: 1 },
  tipsCardTitle: { fontSize: 15, fontWeight: '700', color: colors.text.primary },
  tipsCardSub: { fontSize: 12, color: colors.text.muted, marginTop: 2 },
  tipsCardArrow: { fontSize: 22, color: colors.text.muted, fontWeight: '300' },

  // Section
  sectionHeading: {
    fontSize: 13, fontWeight: '700', color: colors.text.muted,
    textTransform: 'uppercase', letterSpacing: 0.5, marginTop: spacing.xs,
  },

  // Empty state
  emptyCard: {
    alignItems: 'center', paddingVertical: spacing.xl, backgroundColor: '#fff',
    borderRadius: radius.lg, gap: spacing.xs,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 4, elevation: 1,
  },
  emptyEmoji: { fontSize: 40, marginBottom: spacing.xs },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: colors.text.primary },
  emptyBody: { fontSize: 13, color: colors.text.muted, textAlign: 'center', paddingHorizontal: spacing.lg, lineHeight: 20 },

  // Upgrade
  upgradeCard: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.brand[600], borderRadius: radius.lg, padding: spacing.md,
  },
  upgradeEmoji: { fontSize: 24 },
  upgradeText: { flex: 1 },
  upgradeTitle: { fontSize: 15, fontWeight: '700', color: '#fff' },
  upgradeSubtitle: { fontSize: 12, color: 'rgba(255,255,255,0.8)', marginTop: 2 },
  upgradeArrow: { fontSize: 18, color: '#fff', fontWeight: '700' },
});
