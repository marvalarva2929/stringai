import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  SafeAreaView,
  Modal,
  TouchableWithoutFeedback,
} from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle } from 'react-native-reanimated';
import { FontAwesome6, Octicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useAuthStore } from '../../src/store/useAuthStore';
import { useUserStore } from '../../src/store/useUserStore';
import { useAnalysisStore } from '../../src/store/useAnalysisStore';
import { TunerModal } from '../../src/components/tuner/TunerModal';
import { ScoreGauge } from '../../src/components/ui/ScoreGauge';
import { WeeklyGoalCard } from '../../src/components/home/WeeklyGoalCard';
import { minutesPracticedThisWeek } from '../../src/lib/weeklyGoal';
import { useDailyPracticePlan } from '../../src/hooks/useDailyPracticePlan';
import { haptic } from '../../src/lib/haptics';
import { colors, spacing, radius } from '../../src/constants/theme';
import { severityFromScore } from '../../src/types/analysis';

const PLAN_DEPTH = 6;

const PILL_INFO: Record<'streak' | 'score', { icon: React.ReactNode; title: string; body: string }> = {
  streak: {
    icon: <FontAwesome6 name="fire" size={28} color="#f97316" />,
    title: 'Practice Streak',
    body: 'The number of days in a row you’ve completed a session. Practice today to keep it going — miss a day and it resets to zero.',
  },
  score: {
    icon: <Octicons name="star-fill" size={28} color="#f59e0b" />,
    title: 'Average Score',
    body: 'Your overall score averaged across every session you’ve recorded. It updates automatically as you practice more.',
  },
};

export default function HomeScreen() {
  const [tunerOpen, setTunerOpen] = useState(false);
  const [infoPopup, setInfoPopup] = useState<'streak' | 'score' | null>(null);

  const { profile } = useUserStore();
  const { weeklyGoalMinutes } = useAuthStore();
  const { sessionHistory } = useAnalysisStore();
  const dailyPlan = useDailyPracticePlan();
  const currentPiece = profile?.currentPiece;

  const goalMinutes = profile?.weeklyGoalMinutes ?? weeklyGoalMinutes;
  const minutesThisWeek = useMemo(
    () => minutesPracticedThisWeek(sessionHistory),
    [sessionHistory],
  );

  // One card per piece — the most recent session of each.
  const recentSessions = useMemo(() => {
    const latestByPiece = new Map<string | null, typeof sessionHistory[number]>();
    for (const session of sessionHistory) {
      const key = session.piece?.id ?? null;
      const existing = latestByPiece.get(key);
      if (!existing || session.recordedAt.localeCompare(existing.recordedAt) > 0) {
        latestByPiece.set(key, session);
      }
    }
    return [...latestByPiece.values()]
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
      .slice(0, 10);
  }, [sessionHistory]);

  const stats = useMemo(() => {
    if (sessionHistory.length === 0) return null;
    const scores = sessionHistory.map((s) => s.overallScore);
    const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

    const DAY = 86_400_000;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dates = new Set(sessionHistory.map((s) => {
      const d = new Date(s.recordedAt); d.setHours(0, 0, 0, 0); return d.getTime();
    }));
    let check = today.getTime();
    if (!dates.has(check)) { check -= DAY; if (!dates.has(check)) return { avg, streak: 0 }; }
    let streak = 0;
    while (dates.has(check)) { streak++; check -= DAY; }
    return { avg, streak };
  }, [sessionHistory]);

  // Plan card depth animation
  const planOffset = useSharedValue(0);
  const planSurfaceStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: planOffset.value }],
  }));

  // Record button depth animation — same mechanic as the plan card above.
  const recordOffset = useSharedValue(0);
  const recordSurfaceStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: recordOffset.value }],
  }));

  return (
    <SafeAreaView style={s.safe}>
      <TunerModal visible={tunerOpen} onClose={() => setTunerOpen(false)} />

      <ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Streak / avg / tune pills ────────────────── */}
        <View style={s.pillRow}>
          <View style={s.pillGroup}>
            {stats && (
              <>
                <Pressable style={s.pillLight} onPress={() => { haptic.light(); setInfoPopup('streak'); }}>
                  <FontAwesome6 name="fire" size={16} color="#f97316" />
                  <Text style={s.pillLightText}>{stats.streak}</Text>
                </Pressable>
                <Pressable style={s.pillLight} onPress={() => { haptic.light(); setInfoPopup('score'); }}>
                  <Octicons name="star-fill" size={16} color="#f59e0b" />
                  <Text style={s.pillLightText}>{stats.avg}</Text>
                </Pressable>
              </>
            )}
          </View>
          <Pressable style={s.pill} onPress={() => setTunerOpen(true)}>
            <Text style={s.pillText}>♩ Tune</Text>
          </Pressable>
        </View>

        {/* ── Streak / score info popup ─────────────────── */}
        <Modal visible={infoPopup !== null} transparent animationType="fade" onRequestClose={() => setInfoPopup(null)}>
          <TouchableWithoutFeedback onPress={() => setInfoPopup(null)}>
            <View style={s.popupBackdrop}>
              <TouchableWithoutFeedback>
                <View style={s.popupCard}>
                  {infoPopup && (
                    <>
                      {PILL_INFO[infoPopup].icon}
                      <Text style={s.popupTitle}>{PILL_INFO[infoPopup].title}</Text>
                      <Text style={s.popupBody}>{PILL_INFO[infoPopup].body}</Text>
                    </>
                  )}
                  <Pressable style={s.popupCloseBtn} onPress={() => setInfoPopup(null)}>
                    <Text style={s.popupCloseText}>Got it</Text>
                  </Pressable>
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        </Modal>

        {/* ── Pinned piece card ────────────────────────── */}
        {currentPiece && (
          <Pressable
            style={({ pressed }) => [s.pieceCard, pressed && s.pieceCardPressed]}
            onPress={() => { haptic.medium(); router.push({ pathname: '/practice/plan', params: { pieceId: currentPiece.pieceId } }); }}
          >
            <View style={s.pieceCardTop}>
              <View style={s.pieceBadge}>
                <FontAwesome6 name="music" size={13} color={colors.brand[700]} />
                <Text style={s.pieceBadgeText}>Currently practicing</Text>
              </View>
              <FontAwesome6 name="chevron-right" size={13} color={colors.text.muted} />
            </View>
            <Text style={s.pieceTitle} numberOfLines={1}>{currentPiece.title}</Text>
            {currentPiece.composer ? <Text style={s.pieceComposer}>{currentPiece.composer}</Text> : null}
            {currentPiece.goals ? <Text style={s.pieceGoals} numberOfLines={2}>“{currentPiece.goals}”</Text> : null}
            <Text style={s.pieceCta}>Warm up before you play →</Text>
          </Pressable>
        )}

        {/* ── Daily Practice Plan card — the main focus ──── */}
        <Pressable
          onPressIn={() => { planOffset.value = PLAN_DEPTH; haptic.medium(); }}
          onPressOut={() => { planOffset.value = 0; }}
          onPress={() => router.push('/(tabs)/train')}
          style={s.planCardOuter}
        >
          <View style={s.planCardBase} />
          <Animated.View style={[s.planCardSurface, planSurfaceStyle]}>
            <View style={s.planCardRow}>
              <View style={s.planCardTextWrap}>
                <Text style={s.planCardTitle}>Daily Warm-Up</Text>
                <Text style={s.planCardSub}>{dailyPlan.primaryFocus}</Text>
              </View>
              <FontAwesome6 name="bullseye" size={40} color="rgba(255,255,255,0.9)" />
            </View>
            <View style={s.planCardMeta}>
              <Text style={s.planCardMetaText}>{dailyPlan.blocks.length} exercises  ·  ~{dailyPlan.durationMinutes} min</Text>
              <Text style={s.planCardStart}>Start →</Text>
            </View>
          </Animated.View>
        </Pressable>

        {/* ── Record session button ────────────────────── */}
        <Pressable
          onPressIn={() => { recordOffset.value = PLAN_DEPTH; haptic.medium(); }}
          onPressOut={() => { recordOffset.value = 0; }}
          onPress={() => router.push('/(tabs)/analyze')}
          style={s.recordButtonOuter}
        >
          <View style={s.recordButtonBase} />
          <Animated.View style={[s.recordButtonSurface, recordSurfaceStyle]}>
            <FontAwesome6 name="microphone" size={16} color="#fff" />
            <Text style={s.recordButtonText}>
              {sessionHistory.length === 0 ? 'Record First Session' : 'Record New Session'}
            </Text>
          </Animated.View>
        </Pressable>

        {/* ── Weekly goal card ─────────────────────────── */}
        <WeeklyGoalCard
          goalMinutes={goalMinutes}
          minutesThisWeek={minutesThisWeek}
          onPress={() => router.push('/goal')}
        />

        {/* ── Continue recent sessions ─────────────────── */}
        {recentSessions.length > 0 && (
          <>
            <Text style={s.orLabel}>Continue recent sessions</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={s.sessionRow}
            >
              {recentSessions.map((session) => (
                <Pressable
                  key={session.id}
                  style={({ pressed }) => [s.sessionCard, pressed && s.sessionCardPressed]}
                  onPress={() => { haptic.light(); router.push(`/session/${session.id}`); }}
                >
                  <ScoreGauge
                    score={Math.round(session.overallScore)}
                    severity={severityFromScore(session.overallScore)}
                    size="sm"
                    showLabel={false}
                  />
                  <Text style={s.sessionDate}>
                    {new Date(session.recordedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </Text>
                  <Text style={s.sessionSub} numberOfLines={1}>
                    {session.piece?.title ?? 'General Practice'}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },

  // Streak / avg / tune pill row (above plan card)
  pillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pillGroup: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.brand[600],
    borderRadius: radius.full,
    paddingHorizontal: 14,
    paddingVertical: 8,
    shadowColor: colors.brand[800],
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 4,
  },
  pillText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },
  pillLight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fff',
    borderRadius: radius.full,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    borderBottomWidth: 3,
    borderBottomColor: '#d1d5db',
  },
  pillLightText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.text.primary,
  },

  // Streak/score info popup
  popupBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  popupCard: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: radius.xl,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  popupTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.text.primary,
    marginTop: 4,
  },
  popupBody: {
    fontSize: 14,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  popupCloseBtn: {
    marginTop: spacing.sm,
    backgroundColor: colors.brand[600],
    borderRadius: radius.full,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  popupCloseText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },

  // Scroll
  scroll: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.lg,
  },

  // Plan card (depth effect: base + animated surface) — the home screen's
  // main focus, so it's sized well above every other card.
  planCardOuter: {
    height: 210 + PLAN_DEPTH,
    borderRadius: 22,
  },
  planCardBase: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 210,
    borderRadius: 22,
    backgroundColor: colors.brand[800],
  },
  planCardSurface: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 210,
    borderRadius: 22,
    backgroundColor: colors.brand[600],
    padding: spacing.lg,
    justifyContent: 'space-between',
  },
  planCardRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  planCardTextWrap: { flex: 1 },
  planCardTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: '#fff',
    marginBottom: 6,
  },
  planCardSub: {
    fontSize: 15,
    color: 'rgba(255,255,255,0.8)',
    fontWeight: '500',
  },
  planCardEmoji: { fontSize: 36 },
  planCardMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  planCardMetaText: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.65)',
    fontWeight: '600',
  },
  planCardStart: {
    fontSize: 16,
    fontWeight: '800',
    color: '#fff',
  },

  // Pinned piece card — same bordered/pressed popout edge as WeeklyGoalCard
  // and the pillLight buttons above, so every card on this screen reads as
  // one consistent "button" language.
  pieceCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    borderBottomWidth: 4,
    borderBottomColor: '#d1d5db',
    padding: spacing.md,
    gap: 4,
  },
  pieceCardPressed: { backgroundColor: '#f9fafb' },
  pieceCardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pieceBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pieceBadgeText: {
    fontSize: 11,
    fontWeight: '900',
    color: colors.brand[700],
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  pieceTitle: { fontSize: 22, fontWeight: '900', color: colors.text.primary, marginTop: 4 },
  pieceComposer: { fontSize: 13, fontWeight: '600', color: colors.text.secondary },
  pieceGoals: { fontSize: 13, fontStyle: 'italic', color: colors.text.secondary, marginTop: 6 },
  pieceCta: { fontSize: 14, fontWeight: '800', color: colors.brand[700], marginTop: spacing.sm },

  // Record session button — same depth effect (base + animated surface) as
  // the plan card above, just sized for a single-row button.
  recordButtonOuter: {
    height: 56 + PLAN_DEPTH,
    borderRadius: 22,
    marginTop: -spacing.lg / 2,
  },
  recordButtonBase: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 56,
    borderRadius: 22,
    backgroundColor: colors.brand[800],
  },
  recordButtonSurface: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 56,
    borderRadius: 22,
    backgroundColor: colors.brand[600],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  recordButtonText: { fontSize: 15, fontWeight: '800', color: '#fff' },

  // Or label
  orLabel: {
    fontSize: 13,
    color: colors.text.muted,
    fontWeight: '500',
    textAlign: 'center',
    marginVertical: -spacing.sm,
  },

  // Recent session cards (square, horizontally scrollable, popout style)
  sessionRow: {
    gap: spacing.sm,
    paddingRight: spacing.lg,
  },
  sessionCard: {
    width: 108,
    height: 108,
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    borderBottomWidth: 4,
    borderBottomColor: '#d1d5db',
    padding: spacing.sm,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sessionCardPressed: { backgroundColor: '#f9fafb' },
  sessionDate: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.text.muted,
  },
  sessionSub: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.text.secondary,
    textAlign: 'center',
  },
});
